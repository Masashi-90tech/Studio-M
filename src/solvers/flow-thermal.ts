// 流れ＋熱（共役伝熱）: 流れ解析（flow.ts の LBM）と同じ格子で、温度 T の移流拡散を解く。
// DOM を触らない。flow.ts が、thermal が有効なときだけ作って、LBM の 1 ステップごとに step() を呼ぶ。
//
// 解く式（流体・固体を 1 つの式で扱う。ρcp は流体の値、固体では下の注を参照）:
//   ρcp (∂T/∂t + u·∇T) = ∇·(k ∇T) + q          （u は LBM の速度。固体の中では 0）
//
// - 流体セル: 流体の材料（flow.fluidId）の ρ・cp・k。移流は MUSCL（van Leer の制限関数つきの 2 次風上）の「非保存形」
//   T_new = T − Σ u_out (T_面 − T_セル)。一様な温度は厳密に保たれ（発熱 0 なら流入温度のまま）、制限関数があるので振動しない。
//   LBM の速度は完全には発散ゼロでないが、非保存形なので T∇·u の偽の熱源が出ない。
// - 固体セル: k で伝導し、heatSource の発熱（raster.heatGen [W/m³]）が入る。異なる材料・流体との境界は調和平均の熱伝導率
//   （半セル分の抵抗の直列つなぎ。heat.ts の面のつなぎ方と同じ）。raster.kEff があるセルはその値で伝導する。
// - 境界: 左端の流体セルは流入温度に固定、右端は隣の列のコピー（ゼロ勾配）、上下・左右の端の固体は断熱。
//   raster.fixedTemp があるセルはその温度に固定する（物体でも流体でもよい）。物体と、温度固定の物体でないセルの間は、
//   heat.ts と同じく面が固定温度に直接触れているとみなす（物体側の半セルだけで伝導）。
//
// 時間刻みと安定条件（格子の単位: セル幅 = 1、LBM の 1 ステップ = 1）:
// - 流体の陽解法は、クーラン数 |ux| + |uy| と拡散数 α dt/h² · Σ(面の重み) の合計が CFL（0.4）以下になるようサブステップに分ける。
//   速度は前のステップの最大値（×1.25 の余裕）で見積もる。サブステップが多すぎる（風が極端に遅く拡散が支配的）ときは、
//   熱の時計を LBM より遅らせて MAX_SUB 回に収める（定常の結果は変わらない）。
// - 固体は、定常の温度が熱容量によらないことを使い、熱容量を持たない準定常（ρcp → 0 の極限）として扱う。
//   陽解法の安定条件に縛られず、固体の熱容量のせいで落ち着くのが遅くなることもない。毎ステップ、
//   SOR（ガウス・ザイデル法の加速版）の数回の更新で分布を整え、連結成分ごとに全体を同じだけずらして熱収支を厳密に合わせる
//   （固体は温度がほぼ一様で、全体の水準はガウス・ザイデル法だけだと熱容量を持つのと同じくらい遅くしか動かないため）。
//   そのため、途中の温度の変化は実時間ではない。落ち着いたあとの温度は、本物の熱容量で時間を進めた場合と同じになる。
//
// ホットループ（step）の中ではメモリ確保をしない。

import { getMaterial } from '../core/materials';
import type { Project, Raster } from '../core/types';

/** 流入温度の既定 [°C] */
export const INLET_TEMP_DEFAULT_C = 25;

/** 陽解法の安定条件（クーラン数と拡散数の合計の上限）。2 次の制限関数つき風上は 0.5 以下で安定 */
const CFL = 0.4;
/** 1 回の LBM ステップあたりのサブステップの上限 */
const MAX_SUB = 24;
/** 固体の準定常の更新回数（LBM の 1 ステップあたり。前向き・後ろ向きを交互に）と、SOR の加速係数（1 以上 2 未満） */
const SOLID_SWEEPS = 4;
const SOLID_OMEGA = 1.7;
/** 前のステップの最大速度から今の最大速度を見積もるときの余裕 */
const CMAX_MARGIN = 1.25;

// mask のビット: 下位 4 つ = その向きの隣が流体セル（移流が通る）、上位 4 つ = さらにその先も流体セル（2 次の風上に使う）
const OPEN_E = 1;
const OPEN_W = 2;
const OPEN_N = 4;
const OPEN_S = 8;
const FAR_E = 16;
const FAR_W = 32;
const FAR_N = 64;
const FAR_S = 128;

export interface FlowThermalOptions {
  project: Project;
  raster: Raster;
  /** LBM の 1 ステップの物理時間 [s] */
  dt: number;
  /** 格子の速度 → m/s の換算 */
  velScale: number;
  /** 格子上の流入速度（流れがなければ 0） */
  uIn: number;
}

export class FlowThermal {
  private readonly nx: number;
  private readonly n: number;
  private readonly h: number;
  private readonly thickness: number;
  private readonly tin: number;
  private readonly velScale: number;
  /** 流体の ρcp [J/(m³·K)] と k */
  private readonly rhoCpF: number;
  /** 流体の拡散数 α dt/h²（LBM の 1 ステップあたり） */
  private readonly dF: number;
  /** 流体セルの拡散の重みの合計の最大（Σ w）× dF */
  private readonly dMax: number;

  private A: Float64Array;
  private B: Float64Array;

  // 流体セル（動かす）
  private readonly fluidList: Int32Array;
  private readonly mask: Uint8Array;
  private readonly wE: Float32Array;
  private readonly wW: Float32Array;
  private readonly wN: Float32Array;
  private readonly wS: Float32Array;
  private readonly outletList: Int32Array;
  private readonly outletOpenW: Uint8Array;

  // 固体セル（準定常で更新する）
  private readonly solidList: Int32Array;
  private readonly solidNbr: Int32Array;
  private readonly solidG: Float64Array;
  private readonly solidInv: Float64Array;
  private readonly solidQ: Float64Array;
  /** 固体の連結成分ごとの全体の熱収支の補正（加算補正）に使う: セルが属する成分と、外（流体・温度固定）との面のコンダクタンス */
  private readonly compOf: Int32Array;
  private readonly compNum: Float64Array;
  private readonly compDen: Float64Array;
  private readonly solidQraw: Float64Array;
  private readonly solidGx: Float64Array;
  private readonly solidGxSum: Float64Array;

  /** 値をそのまま引き継ぐセル（温度固定、放熱経路のない固体、解析しない固体） */
  private readonly keepList: Int32Array;
  /** keepList のセルの値（温度固定ならその温度、放熱経路のない固体は流入温度） */
  private readonly keepValue: Float64Array;
  /** 物体のセル（最高温度・部品ごとの集計に使う。放熱経路のない固体は含めない） */
  private readonly bodyList: Int32Array;
  /** 1 = 温度が有効な物体セル */
  readonly bodyMask: Uint8Array;
  /** 温度が固定のセルがある */
  readonly hasFixed: boolean;
  /** 発熱の合計 [W]（温度固定のセルの中の発熱と、放熱経路のない固体の発熱は除く） */
  readonly heatInW: number;
  /** 放熱経路がなく温度が定まらないため除外した発熱 [W] */
  readonly floatingHeatW: number;
  /** 熱の時計を LBM より遅らせたことがある（風が極端に遅いとき） */
  slowed = false;
  /** 直近の最大 |ux|+|uy|（格子単位） */
  private cmax: number;
  private readonly cmax0: number;
  private readonly frozenNbr: Int32Array;
  private readonly frozenG: Float64Array;
  private readonly frozenCell: Int32Array;

  constructor(opts: FlowThermalOptions) {
    const { project, raster, dt, velScale, uIn } = opts;
    const { nx, ny, h } = raster;
    const n = nx * ny;
    this.nx = nx;
    this.n = n;
    this.h = h;
    this.thickness = project.thickness;
    this.velScale = velScale;
    const th = project.flow.thermal;
    this.tin = th?.inletTempC !== undefined && Number.isFinite(th.inletTempC) ? th.inletTempC : INLET_TEMP_DEFAULT_C;

    const fluid = getMaterial(project.flow.fluidId);
    this.rhoCpF = fluid.rho * fluid.cp;
    const kf = fluid.k;
    this.dF = (kf / this.rhoCpF) * (dt / (h * h));

    const { solid, fixedTemp } = raster;
    const isSolid = (c: number): boolean => solid[c] === 1;
    const isFixed = (c: number): boolean => !Number.isNaN(fixedTemp[c]);

    // セルごとの熱伝導率（固体は材料の k、kEff があればそれ。流体は流体の k）
    const k = new Float64Array(n);
    const kCache = new Map<string, number>();
    for (let c = 0; c < n; c++) {
      if (!isSolid(c)) {
        k[c] = kf;
        continue;
      }
      const id = raster.materialId[c];
      let kv = 0;
      if (id !== null) {
        const cached = kCache.get(id);
        if (cached !== undefined) kv = cached;
        else {
          kv = getMaterial(id).k;
          kCache.set(id, kv);
        }
      }
      const ke = raster.kEff ? raster.kEff[c] : NaN;
      k[c] = Number.isFinite(ke) && ke > 0 ? ke : kv;
    }
    const harm = (a: number, b: number): number => (a > 0 && b > 0 ? (2 * a * b) / (a + b) : 0);
    /**
     * 隣り合う 2 セル間の面のコンダクタンス用の熱伝導率。ふつうは調和平均。
     * 物体と、温度固定の物体でないセル（heat.ts と同じく、その面が固定温度に直接触れているとみなす）の間は、物体側の半セルだけ（2k）
     */
    const kFace = (c: number, m: number): number => {
      if (isSolid(c) && !isSolid(m) && isFixed(m)) return 2 * k[c];
      if (isSolid(m) && !isSolid(c) && isFixed(c)) return 2 * k[m];
      return harm(k[c], k[m]);
    };

    // 放熱経路のない固体（流体にも温度固定のセルにも触れない連結成分）を探す。そこは温度が定まらないので解から外す
    const floating = new Uint8Array(n);
    {
      const visited = new Uint8Array(n);
      const stack = new Int32Array(n);
      const members = new Int32Array(n);
      for (let start = 0; start < n; start++) {
        if (!isSolid(start) || visited[start]) continue;
        let sp = 0;
        let count = 0;
        let hasSink = false;
        stack[sp++] = start;
        visited[start] = 1;
        while (sp > 0) {
          const c = stack[--sp];
          members[count++] = c;
          if (isFixed(c)) hasSink = true;
          const i = c % nx;
          const j = (c - i) / nx;
          const nbs = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1];
          for (const m of nbs) {
            if (m < 0) continue;
            if (!isSolid(m)) hasSink = true;
            else if (!visited[m]) {
              visited[m] = 1;
              stack[sp++] = m;
            }
          }
        }
        if (!hasSink) for (let q = 0; q < count; q++) floating[members[q]] = 1;
      }
    }

    // セルの分類
    const fluidCells: number[] = [];
    const solidCells: number[] = [];
    const keepCells: number[] = [];
    const outletCells: number[] = [];
    const bodyCells: number[] = [];
    this.bodyMask = new Uint8Array(n);
    let heatIn = 0;
    let floatingHeat = 0;
    let anyFixed = false;
    const volume = h * h * this.thickness;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const fixed = isFixed(c);
        if (fixed) anyFixed = true;
        if (isSolid(c)) {
          if (floating[c]) {
            keepCells.push(c);
            floatingHeat += raster.heatGen[c] * volume;
            continue;
          }
          bodyCells.push(c);
          this.bodyMask[c] = 1;
          if (fixed) keepCells.push(c);
          else {
            solidCells.push(c);
            heatIn += raster.heatGen[c] * volume;
          }
          continue;
        }
        if (fixed) keepCells.push(c);
        else if (i === 0) continue; // 流入列は流入温度のまま（動かさない）
        else if (i === nx - 1) outletCells.push(c);
        else fluidCells.push(c);
      }
    }
    this.hasFixed = anyFixed;
    this.heatInW = heatIn;
    this.floatingHeatW = floatingHeat;
    this.fluidList = Int32Array.from(fluidCells);
    this.solidList = Int32Array.from(solidCells);
    this.keepList = Int32Array.from(keepCells);
    this.keepValue = Float64Array.from(keepCells, (c) => (isFixed(c) ? fixedTemp[c] : this.tin));
    this.outletList = Int32Array.from(outletCells);
    this.bodyList = Int32Array.from(bodyCells);

    // 流体セル: 移流の通り道（mask）と拡散の重み（隣との調和平均 k ÷ 流体の k）
    this.mask = new Uint8Array(n);
    this.wE = new Float32Array(n);
    this.wW = new Float32Array(n);
    this.wN = new Float32Array(n);
    this.wS = new Float32Array(n);
    let wMax = 0;
    for (const c of this.fluidList) {
      const i = c % nx;
      const j = (c - i) / nx;
      let m = 0;
      let wSum = 0;
      // 東
      {
        const nb = c + 1;
        const w = harm(k[c], k[nb]) / kf;
        this.wE[c] = w;
        wSum += w;
        if (!isSolid(nb)) {
          m |= OPEN_E;
          if (i + 2 <= nx - 1 && !isSolid(c + 2)) m |= FAR_E;
        }
      }
      // 西
      {
        const nb = c - 1;
        const w = harm(k[c], k[nb]) / kf;
        this.wW[c] = w;
        wSum += w;
        if (!isSolid(nb)) {
          m |= OPEN_W;
          if (i - 2 >= 0 && !isSolid(c - 2)) m |= FAR_W;
        }
      }
      // 北（上端は断熱の壁）
      if (j + 1 <= ny - 1) {
        const nb = c + nx;
        const w = harm(k[c], k[nb]) / kf;
        this.wN[c] = w;
        wSum += w;
        if (!isSolid(nb)) {
          m |= OPEN_N;
          if (j + 2 <= ny - 1 && !isSolid(c + 2 * nx)) m |= FAR_N;
        }
      }
      // 南（下端は断熱の壁）
      if (j - 1 >= 0) {
        const nb = c - nx;
        const w = harm(k[c], k[nb]) / kf;
        this.wS[c] = w;
        wSum += w;
        if (!isSolid(nb)) {
          m |= OPEN_S;
          if (j - 2 >= 0 && !isSolid(c - 2 * nx)) m |= FAR_S;
        }
      }
      this.mask[c] = m;
      if (wSum > wMax) wMax = wSum;
    }
    this.dMax = this.dF * wMax;
    this.outletOpenW = Uint8Array.from(this.outletList, (c) => (isSolid(c - 1) ? 0 : 1));

    // 固体セル: 4 つの面のコンダクタンス G = k_調和平均（端は 0）と、更新式 T = (Σ G T_隣) / ΣG + q h² / ΣG
    const S = this.solidList.length;
    this.solidNbr = new Int32Array(4 * S);
    this.solidG = new Float64Array(4 * S);
    this.solidInv = new Float64Array(S);
    this.solidQ = new Float64Array(S);
    for (let s = 0; s < S; s++) {
      const c = this.solidList[s];
      const i = c % nx;
      const j = (c - i) / nx;
      const nbs = [i < nx - 1 ? c + 1 : -1, i > 0 ? c - 1 : -1, j < ny - 1 ? c + nx : -1, j > 0 ? c - nx : -1];
      let gSum = 0;
      for (let d = 0; d < 4; d++) {
        const nb = nbs[d];
        const g = nb >= 0 ? kFace(c, nb) : 0;
        this.solidNbr[4 * s + d] = nb >= 0 ? nb : c;
        this.solidG[4 * s + d] = g;
        gSum += g;
      }
      if (gSum > 0) {
        this.solidInv[s] = 1 / gSum;
        // q h² は奥行き 1 m あたりの発熱 [W/m]。k の単位 [W/(m·K)] で割ると温度 [K]
        this.solidQ[s] = (raster.heatGen[c] * h * h) / gSum;
      } else {
        // 熱をまったく通さない（k が 0 の）セル: 自分自身を隣とみなして、温度を変えない
        for (let d = 0; d < 4; d++) {
          this.solidNbr[4 * s + d] = c;
          this.solidG[4 * s + d] = 1;
        }
        this.solidInv[s] = 0.25;
        this.solidQ[s] = 0;
      }
    }

    // 固体の連結成分と、外（固体のリストにないセル）との面
    const slot = new Int32Array(n).fill(-1);
    for (let q = 0; q < S; q++) slot[this.solidList[q]] = q;
    this.solidQraw = new Float64Array(S);
    this.solidGx = new Float64Array(4 * S);
    this.solidGxSum = new Float64Array(S);
    this.compOf = new Int32Array(S).fill(-1);
    let nComp = 0;
    {
      const stack = new Int32Array(S);
      for (let q0 = 0; q0 < S; q0++) {
        if (this.compOf[q0] >= 0) continue;
        let sp = 0;
        stack[sp++] = q0;
        this.compOf[q0] = nComp;
        while (sp > 0) {
          const q = stack[--sp];
          const c = this.solidList[q];
          this.solidQraw[q] = raster.heatGen[c] * h * h;
          for (let d = 0; d < 4; d++) {
            const g = this.solidG[4 * q + d];
            if (!(g > 0)) continue;
            const m = slot[this.solidNbr[4 * q + d]];
            if (m < 0) {
              this.solidGx[4 * q + d] = g;
              this.solidGxSum[q] += g;
            } else if (this.compOf[m] < 0) {
              this.compOf[m] = nComp;
              stack[sp++] = m;
            }
          }
        }
        nComp++;
      }
    }
    this.compNum = new Float64Array(nComp);
    this.compDen = new Float64Array(nComp);

    // 温度固定のセルから見た隣との伝導（温度固定のセルへ流れ込む熱の計算に使う）
    const fz: number[] = [];
    const fzNbr: number[] = [];
    const fzG: number[] = [];
    for (const c of this.keepList) {
      if (!isFixed(c) || floating[c]) continue;
      const i = c % nx;
      const j = (c - i) / nx;
      const nbs = [i < nx - 1 ? c + 1 : -1, i > 0 ? c - 1 : -1, j < ny - 1 ? c + nx : -1, j > 0 ? c - nx : -1];
      for (const nb of nbs) {
        if (nb < 0 || isFixed(nb)) continue;
        fz.push(c);
        fzNbr.push(nb);
        fzG.push(kFace(c, nb));
      }
    }
    this.frozenCell = Int32Array.from(fz);
    this.frozenNbr = Int32Array.from(fzNbr);
    this.frozenG = Float64Array.from(fzG);

    this.A = new Float64Array(n);
    this.B = new Float64Array(n);
    this.cmax0 = 2.5 * Math.abs(uIn) + 0.02;
    this.cmax = this.cmax0;
    this.reset();
  }

  /** 流入温度 [°C] */
  get inletTempC(): number {
    return this.tin;
  }

  /** 全セルを流入温度に戻す（温度固定のセルはその温度） */
  reset(): void {
    this.A.fill(this.tin);
    this.B.fill(this.tin);
    for (let k = 0; k < this.keepList.length; k++) this.A[this.keepList[k]] = this.B[this.keepList[k]] = this.keepValue[k];
    this.cmax = this.cmax0;
    this.slowed = false;
  }

  /**
   * LBM の 1 ステップぶん、熱を進める。ux, uy は格子単位の速度（物体のセルは 0。左端は流入速度、右端は隣の列と同じ）。
   * 風が極端に遅く拡散が支配的なとき、熱の時計だけ遅れることがある（slowed）
   */
  step(ux: Float32Array, uy: Float32Array): void {
    const stab = this.cmax * CMAX_MARGIN + this.dMax;
    let total = 1;
    let sub = 1;
    if (stab > CFL) {
      total = Math.min(1, (MAX_SUB * CFL) / stab);
      sub = Math.max(1, Math.ceil((total * stab) / CFL - 1e-9));
    }
    if (total < 1) this.slowed = true;
    const tau = total / sub;
    for (let s = 0; s < sub; s++) this.substep(ux, uy, tau);
    this.sweepSolids();
  }

  /** 流体セルを tau（LBM の 1 ステップに対する割合）だけ陽解法で進める */
  private substep(ux: Float32Array, uy: Float32Array, tau: number): void {
    const { nx, A, B, mask, fluidList, wE, wW, wN, wS } = this;
    const tauD = tau * this.dF;
    let cm = 0;
    for (let k = 0; k < fluidList.length; k++) {
      const c = fluidList[k];
      const m = mask[c];
      const Tc = A[c];
      const uxc = ux[c];
      const uyc = uy[c];
      const sp = Math.abs(uxc) + Math.abs(uyc);
      if (sp > cm) cm = sp;
      let adv = 0; // Σ u_外向き (T_面 − T_セル)
      let dif = 0; // Σ w (T_隣 − T_セル)

      if (m & OPEN_E) {
        const Tn = A[c + 1];
        const uo = 0.5 * (uxc + ux[c + 1]);
        if (uo >= 0) {
          if (m & OPEN_W) {
            const du = Tc - A[c - 1];
            const dd = Tn - Tc;
            const pr = du * dd;
            if (pr > 0) adv += (uo * pr) / (du + dd);
          }
        } else {
          let d = Tn - Tc;
          if (m & FAR_E) {
            const du = Tn - A[c + 2];
            const dd = Tc - Tn;
            const pr = du * dd;
            if (pr > 0) d += pr / (du + dd);
          }
          adv += uo * d;
        }
      }
      if (m & OPEN_W) {
        const Tn = A[c - 1];
        const uo = -0.5 * (uxc + ux[c - 1]);
        if (uo >= 0) {
          if (m & OPEN_E) {
            const du = Tc - A[c + 1];
            const dd = Tn - Tc;
            const pr = du * dd;
            if (pr > 0) adv += (uo * pr) / (du + dd);
          }
        } else {
          let d = Tn - Tc;
          if (m & FAR_W) {
            const du = Tn - A[c - 2];
            const dd = Tc - Tn;
            const pr = du * dd;
            if (pr > 0) d += pr / (du + dd);
          }
          adv += uo * d;
        }
      }
      if (m & OPEN_N) {
        const Tn = A[c + nx];
        const uo = 0.5 * (uyc + uy[c + nx]);
        if (uo >= 0) {
          if (m & OPEN_S) {
            const du = Tc - A[c - nx];
            const dd = Tn - Tc;
            const pr = du * dd;
            if (pr > 0) adv += (uo * pr) / (du + dd);
          }
        } else {
          let d = Tn - Tc;
          if (m & FAR_N) {
            const du = Tn - A[c + 2 * nx];
            const dd = Tc - Tn;
            const pr = du * dd;
            if (pr > 0) d += pr / (du + dd);
          }
          adv += uo * d;
        }
      }
      if (m & OPEN_S) {
        const Tn = A[c - nx];
        const uo = -0.5 * (uyc + uy[c - nx]);
        if (uo >= 0) {
          if (m & OPEN_N) {
            const du = Tc - A[c + nx];
            const dd = Tn - Tc;
            const pr = du * dd;
            if (pr > 0) adv += (uo * pr) / (du + dd);
          }
        } else {
          let d = Tn - Tc;
          if (m & FAR_S) {
            const du = Tn - A[c - 2 * nx];
            const dd = Tc - Tn;
            const pr = du * dd;
            if (pr > 0) d += pr / (du + dd);
          }
          adv += uo * d;
        }
      }

      // 拡散（流体同士は重み 1、物体との面は調和平均 k ÷ 流体の k）
      dif += wE[c] * (A[c + 1] - Tc) + wW[c] * (A[c - 1] - Tc);
      if (wN[c] > 0) dif += wN[c] * (A[c + nx] - Tc);
      if (wS[c] > 0) dif += wS[c] * (A[c - nx] - Tc);

      B[c] = Tc - tau * adv + tauD * dif;
    }
    this.cmax = cm;

    // 値を引き継ぐセル（固体はあとで準定常に更新する）
    const keep = this.keepList;
    for (let k = 0; k < keep.length; k++) B[keep[k]] = A[keep[k]];
    const solids = this.solidList;
    for (let k = 0; k < solids.length; k++) B[solids[k]] = A[solids[k]];
    // 流入列は流入温度のまま（B は reset で埋めてあり、書き換えない）。流出列は隣の列のコピー（ゼロ勾配）
    const out = this.outletList;
    for (let k = 0; k < out.length; k++) {
      const c = out[k];
      B[c] = this.outletOpenW[k] === 1 ? B[c - 1] : A[c];
    }
    this.A = B;
    this.B = A;
  }

  /**
   * 固体の温度を、熱容量なしの準定常（Σ G (T_隣 − T) + Q = 0）へ向けて更新する。
   * SOR（ガウス・ザイデル法の加速版）の数回の更新で温度の分布を整え、そのあと連結成分ごとに全体を同じだけずらして、
   * 成分全体の熱収支（発熱 + 外から入る熱 = 0）を厳密に合わせる（固体はほぼ一様な温度なので、全体の温度の水準は
   * ガウス・ザイデル法だけだと極端に遅くしか動かない。この補正がその遅い成分を消す）
   */
  private sweepSolids(): void {
    const { A, solidList, solidNbr, solidG, solidInv, solidQ } = this;
    const S = solidList.length;
    for (let sweep = 0; sweep < SOLID_SWEEPS; sweep++) {
      if ((sweep & 1) === 0) {
        for (let s = 0; s < S; s++) {
          const o = 4 * s;
          const c = solidList[s];
          const gs = (solidG[o] * A[solidNbr[o]] + solidG[o + 1] * A[solidNbr[o + 1]] + solidG[o + 2] * A[solidNbr[o + 2]] + solidG[o + 3] * A[solidNbr[o + 3]]) * solidInv[s] + solidQ[s];
          A[c] += SOLID_OMEGA * (gs - A[c]);
        }
      } else {
        for (let s = S - 1; s >= 0; s--) {
          const o = 4 * s;
          const c = solidList[s];
          const gs = (solidG[o] * A[solidNbr[o]] + solidG[o + 1] * A[solidNbr[o + 1]] + solidG[o + 2] * A[solidNbr[o + 2]] + solidG[o + 3] * A[solidNbr[o + 3]]) * solidInv[s] + solidQ[s];
          A[c] += SOLID_OMEGA * (gs - A[c]);
        }
      }
    }
    // 成分ごとの熱収支の補正
    const { compOf, compNum, compDen, solidGx, solidGxSum, solidQraw } = this;
    compNum.fill(0);
    compDen.fill(0);
    for (let s = 0; s < S; s++) {
      const o = 4 * s;
      const c = solidList[s];
      const Tc = A[c];
      const k = compOf[s];
      compNum[k] += solidQraw[s] + solidGx[o] * (A[solidNbr[o]] - Tc) + solidGx[o + 1] * (A[solidNbr[o + 1]] - Tc) + solidGx[o + 2] * (A[solidNbr[o + 2]] - Tc) + solidGx[o + 3] * (A[solidNbr[o + 3]] - Tc);
      compDen[k] += solidGxSum[s];
    }
    for (let k = 0; k < compNum.length; k++) compNum[k] = compDen[k] > 0 ? compNum[k] / compDen[k] : 0;
    for (let s = 0; s < S; s++) A[solidList[s]] += compNum[compOf[s]];
  }

  // ---------- 結果 ----------

  /** 現在の温度 [°C]（長さ nx * ny） */
  temperature(): Float64Array {
    return this.A;
  }

  /** 物体の最高温度 [°C]。物体がなければ流入温度 */
  maxTemp(): number {
    const { A, bodyList } = this;
    if (bodyList.length === 0) return this.tin;
    let mx = -Infinity;
    for (let k = 0; k < bodyList.length; k++) {
      const v = A[bodyList[k]];
      if (v > mx) mx = v;
    }
    return mx;
  }

  /** 温度を Float32 に書き出す */
  fillTemp(out: Float32Array): void {
    const A = this.A;
    for (let c = 0; c < this.n; c++) out[c] = A[c];
  }

  /**
   * 流出口から風が運び出す熱 [W] = ρcp ∫ u (T − T_in) dy × 厚さ。ux は格子単位の速度（右端の列を使う）
   */
  heatOutW(ux: Float32Array): number {
    const { A, outletList } = this;
    let sum = 0;
    for (let k = 0; k < outletList.length; k++) {
      const c = outletList[k];
      sum += ux[c] * (A[c] - this.tin);
    }
    return this.rhoCpF * this.velScale * sum * this.h * this.thickness;
  }

  /** 温度固定のセルへ流れ込んでいる熱 [W]（吸い込まれる向きを正）。固定のセルがなければ 0 */
  heatToFixedW(): number {
    const { A, frozenCell, frozenNbr, frozenG } = this;
    let sum = 0;
    for (let k = 0; k < frozenCell.length; k++) sum += frozenG[k] * (A[frozenNbr[k]] - A[frozenCell[k]]);
    return sum * this.thickness;
  }
}
