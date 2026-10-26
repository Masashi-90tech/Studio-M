// 流れ解析（レベル②）: 格子ボルツマン法（LBM, D2Q9, BGK衝突）による2D非圧縮流れ。
//
// - 障害物（raster.solid == 1）は半格子バウンスバック
// - 左端: 流入（速度指定の平衡分布。密度は隣の列から取る）
// - 右端: 流出（隣の列の分布をそのままコピー = ゼロ勾配）
// - 上下: slip = 鏡面反射（対称）、noslip = バウンスバック（壁面）
// - 高Reでも崩れないよう Smagorinsky の渦粘性（LES）を足している
// - 格子（lattice）の量と物理量の換算は dx = h, dt = uLat * h / U で行う
//
// 計算は「引き込み型（pull）」の移流＋衝突を1回のループにまとめ、
// 分布関数を方向ごとの Float32Array 2組（現在 / 次）で持ってステップごとに入れ替える。
// ホットループの中ではメモリ確保をしない。
//
// プロ設定（project.flow.advanced、すべて省略可。省略時は自動）:
// - smagorinskyCs: Smagorinsky 定数（0 で LES 無効、自動は 0.1）
// - latticeU:      格子上の流入速度（0.01〜0.2 に丸める。自動は 0.08、τ が足りなければ 0.1）
// - perturbation:  初期擾乱の倍率（自動は 1）。createFlowSolverWithOptions の opts が優先
//
// result().scalars に載せる「実際に使った値」（キーは固定）:
// - latticeU:       '格子単位の流入速度'
// - tau:            '緩和時間 τ'
// - smagorinskyCs:  'Smagorinsky 定数'
//
// 温度（project.flow.thermal.enabled が true のときだけ。省略・false なら温度の計算は一切せず、結果も今までと同じ）:
// 同じ格子で温度の移流拡散を解く共役伝熱（flow-thermal.ts）。LBM の 1 ステップごとに熱を 1 ステップ進める。
// - fields:  temp '温度'（°C。物体の中も有効なので mask なし）
// - scalars: maxTemp '最高温度'（物体の最高）、heatOut '流出口から風が運び出す熱'（W。渦で脈打つので、流れが半分通り抜ける時間の移動平均）、
//            heatIn '発熱の合計'（W）、
//            温度固定の図形があるときは heatFixed '温度固定へ流れ込む熱'（W）
// - history: maxTemp（最高温度の推移）
// - perShape: 部品ごとの最高温度など（熱解析と同じ key・同じ形。raster.shapeIndex があるとき）

import { getMaterial } from '../core/materials';
import type { Field, History, Project, Raster, ResultSet, ScalarValue, Solver, SolverFactory, SolverStatus } from '../core/types';
import { FlowThermal } from './flow-thermal';
import { buildPartTemps } from './thermal-parts';

// ---------- 定数 ----------

/** 緩和時間 τ の下限。これより小さいと BGK は不安定になる */
const TAU_MIN = 0.505;
/** Smagorinsky 定数 Cs の自動値 */
const CS_DEFAULT = 0.1;
/** プロ設定で指定できる格子速度の範囲 */
const U_LAT_MIN_USER = 0.01;
const U_LAT_MAX_USER = 0.2;
/** 格子上の流入速度の候補（小さい方が圧縮性誤差は小さいが、同じ τ で到達できる Re は下がる） */
const U_LAT_PREFERRED = 0.08;
const U_LAT_MAX = 0.1;
/** 履歴に残すサンプルの最大数 */
const HISTORY_MAX = 2000;
/** 流出側スポンジ層の厚さ（nx に対する割合）と最大の強さ */
const SPONGE_FRACTION = 0.15;
const SPONGE_STRENGTH = 0.3;
/** 時間チェックの間隔（ステップ） */
const CHUNK = 5;

// D2Q9: 0:(0,0) 1:(1,0) 2:(0,1) 3:(-1,0) 4:(0,-1) 5:(1,1) 6:(-1,1) 7:(-1,-1) 8:(1,-1)
const CX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
const CY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
/** 逆向きの方向 */
const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
/** y 方向を反転した方向（鏡面反射用） */
const FLIP_Y = [0, 1, 4, 3, 2, 8, 7, 6, 5];
const W0 = 4 / 9;
const W1 = 1 / 9;
const W2 = 1 / 36;

// ---------- 公開する型 ----------

export interface FlowOptions {
  /** 初期擾乱の強さ（1 = 標準、0 = なし）。カルマン渦が自然に立ち上がるよう標準では少しだけ乱す */
  perturbation?: number;
}

/** 通常の Solver に、テストや診断に使う情報を足したもの */
export interface FlowSolver extends Solver {
  /** LBM を指定ステップだけ進める（時間予算なし） */
  advance(steps: number): void;
  /** 流体セル全体の格子上の質量（Σρ） */
  totalMass(): number;
  readonly stepCount: number;
  /** 現在の緩和時間 τ */
  readonly tau: number;
  /** 格子上の流入速度 */
  readonly uLat: number;
  /** 1ステップあたりの物理時間 [s] */
  readonly dt: number;
  /** 物体の代表長さ L [m] */
  readonly length: number;
  /** 物理的なレイノルズ数 */
  readonly rePhysical: number;
  /** 実際に計算している（τの下限などで制限された後の）レイノルズ数 */
  readonly reEffective: number;
  /** 温度も計算している（project.flow.thermal.enabled） */
  readonly thermal: boolean;
}

// ---------- 実装 ----------

class FlowSolverImpl implements FlowSolver {
  readonly analysis = 'flow' as const;

  private readonly nx: number;
  private readonly ny: number;
  private readonly n: number;
  private readonly h: number;
  private readonly solid: Uint8Array;
  private readonly fluidMask: Uint8Array;
  private readonly slip: boolean;
  private readonly thickness: number;
  private readonly rhoPhys: number;
  private readonly perturbation: number;
  private readonly cs: number;

  // 物理量と格子量の換算
  readonly rePhysical: number;
  readonly length: number;
  readonly uLat: number;
  readonly dt: number;
  private readonly lengthCells: number;
  private readonly hasObstacle: boolean;
  private readonly uPhys: number; // 換算に使う代表速度 [m/s]
  private readonly uIn: number; // 格子上の流入速度（0 のこともある）
  private readonly velScale: number; // 格子速度 → m/s
  private readonly pressScale: number; // (ρ-1)/3 → Pa
  private readonly forceScale: number; // 格子上の力 → N（厚さ込み）
  tau: number;

  // 分布関数（方向ごとの配列を2組）
  private cur: Float32Array[];
  private nxt: Float32Array[];
  /** 流入列に置く平衡分布（ρ = 1） */
  private readonly fIn = new Float64Array(9);

  // 境界処理のテーブル（セルごとに、どの方向の引き込み元が壁・物体か）
  private readonly special: Uint8Array;
  private readonly bbMask: Uint16Array;
  private readonly spMask: Uint16Array;
  private readonly off: Int32Array;
  private readonly tmp = new Float64Array(9);
  /** 流出側のスポンジ層: 列ごとの密度緩和の強さ（0 なら何もしない） */
  private readonly sponge: Float32Array;
  private readonly spongeStart: number;
  private readonly nFluidInner: number;

  // 物体表面のリンク（運動量交換法で力を出す）
  private readonly linkQ: Uint8Array; // 物体へ向かう方向
  private readonly linkIdx: Int32Array;
  private readonly linkCx: Int8Array;
  private readonly linkCy: Int8Array;

  // 状態
  stepCount = 0;
  private accFx = 0;
  private accFy = 0;
  private accN = 0;
  private lastFx = 0; // 直近のサンプル区間で平均した力（格子単位）
  private lastFy = 0;
  private readonly sampleEvery: number;
  private histT: number[] = [];
  private histDrag: number[] = [];
  private histLift: number[] = [];
  private instabilityCount = 0;
  private instabilityNote = '';
  private readonly baseWarnings: string[] = [];

  // 温度（thermal が有効なときだけ。無効なら null のまま何もしない）
  private readonly project: Project;
  private readonly raster: Raster;
  private readonly heat: FlowThermal | null;
  /** LBM の速度（格子単位）。熱の移流に渡す */
  private readonly thUx: Float32Array | null;
  private readonly thUy: Float32Array | null;
  private histMaxT: number[] = [];
  private fTemp: Float32Array | null = null;
  private thermalResets = 0;
  /** 流出口の熱の流れの移動平均 [W]（渦で脈打つので、流れが半分通り抜ける時間ぶんをならす） */
  private heatOutAvg = 0;
  private readonly heatOutAlpha: number;

  // result() で使い回す出力バッファ
  private fSpeed: Float32Array;
  private fUx: Float32Array;
  private fUy: Float32Array;
  private fPress: Float32Array;
  private fVort: Float32Array;

  constructor(project: Project, raster: Raster, opts: FlowOptions) {
    const { nx, ny, h } = raster;
    const n = nx * ny;
    this.nx = nx;
    this.ny = ny;
    this.n = n;
    this.h = h;
    this.project = project;
    this.raster = raster;
    this.solid = Uint8Array.from(raster.solid);
    this.fluidMask = new Uint8Array(n);
    for (let c = 0; c < n; c++) this.fluidMask[c] = this.solid[c] ? 0 : 1;
    this.slip = project.flow.walls === 'slip';
    this.thickness = project.thickness;
    const adv = project.flow.advanced ?? {};
    this.perturbation = opts.perturbation ?? adv.perturbation ?? 1;
    this.cs = adv.smagorinskyCs !== undefined && adv.smagorinskyCs >= 0 ? adv.smagorinskyCs : CS_DEFAULT;

    const fluid = getMaterial(project.flow.fluidId);
    this.rhoPhys = fluid.rho;
    const nuPhys = fluid.viscosity ?? 1.5e-5;

    // 流入速度。0 や負のときは警告して扱いを決める
    const uSet = project.flow.inletVelocity;
    const uAbs = Math.abs(uSet);
    if (uSet < 0) this.baseWarnings.push('流入速度が負です。流れは常に +x 方向（左から右）として、大きさだけを使います。');
    if (uAbs < 1e-9) this.baseWarnings.push('流入速度が 0 です。流れのない状態を計算します。');
    this.uPhys = uAbs > 1e-9 ? uAbs : 1;

    // 代表長さ L = 物体のバウンディングボックスの高さ（なければ領域の高さ）
    let jMin = ny;
    let jMax = -1;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (this.solid[j * nx + i]) {
          if (j < jMin) jMin = j;
          if (j > jMax) jMax = j;
        }
      }
    }
    this.hasObstacle = jMax >= 0;
    this.lengthCells = this.hasObstacle ? jMax - jMin + 1 : ny;
    this.length = this.lengthCells * h;
    this.rePhysical = uAbs > 1e-9 ? (uAbs * this.length) / nuPhys : 0;

    // 格子速度と τ の決め方。まず小さめの uLat を試し、τ が足りなければ大きい方へ
    let uLat = U_LAT_PREFERRED;
    const reForTau = Math.max(this.rePhysical, 1e-3);
    let tau = 3 * ((uLat * this.lengthCells) / reForTau) + 0.5;
    if (adv.latticeU !== undefined && Number.isFinite(adv.latticeU)) {
      // 利用者が格子速度を指定した場合は自動選択をしない（範囲外は丸めて知らせる）
      uLat = Math.min(U_LAT_MAX_USER, Math.max(U_LAT_MIN_USER, adv.latticeU));
      if (uLat !== adv.latticeU) {
        this.baseWarnings.push(
          `格子単位の流入速度 ${adv.latticeU} は範囲外のため ${uLat} に丸めました（指定できるのは ${U_LAT_MIN_USER}〜${U_LAT_MAX_USER}）。`,
        );
      }
      tau = 3 * ((uLat * this.lengthCells) / reForTau) + 0.5;
    } else if (tau < TAU_MIN) {
      uLat = U_LAT_MAX;
      tau = 3 * ((uLat * this.lengthCells) / reForTau) + 0.5;
    }
    this.tau = Math.max(tau, TAU_MIN);
    this.uLat = uLat;
    this.uIn = uAbs > 1e-9 ? uLat : 0;

    this.velScale = this.uPhys / uLat;
    this.dt = (uLat * h) / this.uPhys;
    this.pressScale = this.rhoPhys * this.velScale * this.velScale;
    // 2D の格子力 [ρ u² L / 奥行き] → 物理力 [N]
    this.forceScale = this.pressScale * h * this.thickness;
    this.sampleEvery = Math.max(1, Math.min(50, Math.round(this.lengthCells / (20 * uLat))));
    this.heatOutAlpha = 1 / Math.max(10, (0.5 * nx) / uLat);

    if (this.hasObstacle && this.lengthCells < 8) {
      this.baseWarnings.push(`障害物の高さが格子 ${this.lengthCells} 個分しかなく、形状・抗力の精度が低くなります。格子数（nx）を増やしてください。`);
    }
    if (this.rePhysical > 300) {
      this.baseWarnings.push(
        `Re=${Math.round(this.rePhysical)} では実際の流れは3次元的に乱れるため、2D計算の結果とは異なります（抗力や渦の大きさは目安として見てください）。`,
      );
    }

    // 平衡分布（ρ=1, 流入速度）
    this.equilibrium(1, this.uIn, 0, this.fIn);

    // 流出側のスポンジ層。圧力波が端で反射して揚力・抗力に乗るのを抑える（速度は変えず密度だけ 1 へ寄せる）
    const nSponge = Math.max(4, Math.round(SPONGE_FRACTION * nx));
    this.spongeStart = Math.max(nx - 1 - nSponge, 1);
    this.sponge = new Float32Array(nx);
    for (let i = this.spongeStart; i < nx; i++) {
      const r = (i - this.spongeStart + 1) / (nx - this.spongeStart);
      this.sponge[i] = SPONGE_STRENGTH * r * r;
    }

    // 境界テーブル
    this.special = new Uint8Array(n);
    this.bbMask = new Uint16Array(n);
    this.spMask = new Uint16Array(n);
    this.off = new Int32Array(9);
    for (let q = 0; q < 9; q++) this.off[q] = -CX[q] - CY[q] * nx;
    const links: { q: number; idx: number }[] = [];
    let nInner = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = j * nx + i;
        if (this.solid[idx]) continue;
        if (i >= 1 && i <= nx - 2) nInner++;
        for (let q = 1; q < 9; q++) {
          const sx = i - CX[q];
          const sy = j - CY[q];
          if (sy < 0 || sy >= ny) {
            // 上下の壁: 対称なら鏡面反射、壁面ならバウンスバック
            if (this.slip) this.spMask[idx] |= 1 << q;
            else this.bbMask[idx] |= 1 << q;
          } else if (sx >= 0 && sx < nx && this.solid[sy * nx + sx]) {
            this.bbMask[idx] |= 1 << q;
            // 物体への衝突は力の計算に使う（流入・流出の列は境界条件で置き換わるので除く）
            if (i >= 1 && i <= nx - 2) links.push({ q: OPP[q], idx });
          }
        }
        if (this.bbMask[idx] || this.spMask[idx]) this.special[idx] = 1;
      }
    }
    this.nFluidInner = nInner;
    this.linkQ = Uint8Array.from(links.map((l) => l.q));
    this.linkIdx = Int32Array.from(links.map((l) => l.idx));
    this.linkCx = Int8Array.from(links.map((l) => CX[l.q]));
    this.linkCy = Int8Array.from(links.map((l) => CY[l.q]));

    this.cur = Array.from({ length: 9 }, () => new Float32Array(n));
    this.nxt = Array.from({ length: 9 }, () => new Float32Array(n));
    this.fSpeed = new Float32Array(n);
    this.fUx = new Float32Array(n);
    this.fUy = new Float32Array(n);
    this.fPress = new Float32Array(n);
    this.fVort = new Float32Array(n);

    if (project.flow.thermal?.enabled === true) {
      this.heat = new FlowThermal({ project, raster, dt: this.dt, velScale: this.velScale, uIn: this.uIn });
      this.thUx = new Float32Array(n);
      this.thUy = new Float32Array(n);
      this.fTemp = new Float32Array(n);
    } else {
      this.heat = null;
      this.thUx = null;
      this.thUy = null;
    }

    this.initState();
  }

  get thermal(): boolean {
    return this.heat !== null;
  }

  // ---------- 初期化 ----------

  /** 平衡分布 f_eq(ρ, ux, uy) を out に書く */
  private equilibrium(rho: number, ux: number, uy: number, out: Float64Array): void {
    const usq = 1.5 * (ux * ux + uy * uy);
    for (let q = 0; q < 9; q++) {
      const w = q === 0 ? W0 : q < 5 ? W1 : W2;
      const cu = 3 * (CX[q] * ux + CY[q] * uy);
      out[q] = w * rho * (1 + cu + 0.5 * cu * cu - usq);
    }
  }

  /** 一様流＋ごく小さな擾乱で初期化する */
  private initState(): void {
    const { nx, ny, n, cur } = this;
    const eq = new Float64Array(9);
    // 擾乱: 物体の斜め後方に小さな縦方向の速度の山を置いて対称性を崩す
    let bx = 0.3 * nx;
    let by = 0.5 * ny;
    if (this.hasObstacle) {
      let iMin = nx;
      let iMax = -1;
      let jMin = ny;
      let jMax = -1;
      for (let c = 0; c < n; c++) {
        if (!this.solid[c]) continue;
        const i = c % nx;
        const j = (c - i) / nx;
        if (i < iMin) iMin = i;
        if (i > iMax) iMax = i;
        if (j < jMin) jMin = j;
        if (j > jMax) jMax = j;
      }
      bx = iMax + 1 + 0.5 * this.lengthCells;
      by = (jMin + jMax + 1) / 2 + 0.25 * this.lengthCells;
    }
    const sigma = Math.max(1.5, 0.4 * this.lengthCells);
    const amp = 0.1 * this.uLat * this.perturbation;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = j * nx + i;
        let ux = 0;
        let uy = 0;
        if (!this.solid[idx]) {
          ux = this.uIn;
          const dx = i + 0.5 - bx;
          const dy = j + 0.5 - by;
          uy = amp * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        }
        this.equilibrium(1, ux, uy, eq);
        for (let q = 0; q < 9; q++) cur[q][idx] = eq[q];
      }
    }
    this.stepCount = 0;
    this.accFx = this.accFy = this.accN = 0;
    this.lastFx = this.lastFy = 0;
    this.histT = [];
    this.histDrag = [];
    this.histLift = [];
    this.histMaxT = [];
    this.heatOutAvg = 0;
    this.heat?.reset();
    if (this.thUx && this.thUy) {
      this.thUx.fill(0);
      this.thUy.fill(0);
    }
  }

  // ---------- 1ステップ（引き込み型の移流＋衝突） ----------

  /** 1ステップ進める。不安定になったら false */
  private stepOnce(): boolean {
    const { nx, ny, solid, special, off, tmp, fIn, sponge, spongeStart } = this;
    const src = this.cur;
    const dst = this.nxt;
    const s0 = src[0], s1 = src[1], s2 = src[2], s3 = src[3], s4 = src[4], s5 = src[5], s6 = src[6], s7 = src[7], s8 = src[8];
    const d0 = dst[0], d1 = dst[1], d2 = dst[2], d3 = dst[3], d4 = dst[4], d5 = dst[5], d6 = dst[6], d7 = dst[7], d8 = dst[8];
    const tau = this.tau;
    const cs2x18 = 18 * this.cs * this.cs;
    const thUx = this.thUx;
    const thUy = this.thUy;

    // 物体が受ける力（運動量交換法）: 物体へ向かう分布 f と跳ね返る分布の和 = 2 f
    let fx = 0;
    let fy = 0;
    for (let k = 0; k < this.linkQ.length; k++) {
      const v = src[this.linkQ[k]][this.linkIdx[k]];
      fx += v * this.linkCx[k];
      fy += v * this.linkCy[k];
    }
    this.accFx += 2 * fx;
    this.accFy += 2 * fy;
    this.accN++;

    let massSum = 0;
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 1; i < nx - 1; i++) {
        const idx = row + i;
        if (solid[idx] === 1) continue;

        // 移流: 隣のセルの衝突後の値を引き込む（壁・物体側は反射）
        let f0: number, f1: number, f2: number, f3: number, f4: number, f5: number, f6: number, f7: number, f8: number;
        if (special[idx] === 0) {
          f0 = s0[idx];
          f1 = s1[idx - 1];
          f2 = s2[idx - nx];
          f3 = s3[idx + 1];
          f4 = s4[idx + nx];
          f5 = s5[idx - 1 - nx];
          f6 = s6[idx + 1 - nx];
          f7 = s7[idx + 1 + nx];
          f8 = s8[idx - 1 + nx];
        } else {
          const bb = this.bbMask[idx];
          const sp = this.spMask[idx];
          tmp[0] = s0[idx];
          for (let q = 1; q < 9; q++) {
            if ((bb >> q) & 1) tmp[q] = src[OPP[q]][idx];
            else if ((sp >> q) & 1) tmp[q] = src[FLIP_Y[q]][idx];
            else tmp[q] = src[q][idx + off[q]];
          }
          f0 = tmp[0]; f1 = tmp[1]; f2 = tmp[2]; f3 = tmp[3]; f4 = tmp[4];
          f5 = tmp[5]; f6 = tmp[6]; f7 = tmp[7]; f8 = tmp[8];
        }

        // マクロ量
        const rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
        const inv = 1 / rho;
        const ux = (f1 - f3 + f5 - f6 - f7 + f8) * inv;
        const uy = (f2 - f4 + f5 + f6 - f7 - f8) * inv;
        massSum += rho;
        if (thUx !== null && thUy !== null) {
          thUx[idx] = ux;
          thUy[idx] = uy;
        }

        // 平衡分布
        const usq = 1.5 * (ux * ux + uy * uy);
        const r0 = W0 * rho;
        const r1 = W1 * rho;
        const r2 = W2 * rho;
        const e0 = r0 * (1 - usq);
        let cu = 3 * ux;
        const e1 = r1 * (1 + cu + 0.5 * cu * cu - usq);
        const e3 = r1 * (1 - cu + 0.5 * cu * cu - usq);
        cu = 3 * uy;
        const e2 = r1 * (1 + cu + 0.5 * cu * cu - usq);
        const e4 = r1 * (1 - cu + 0.5 * cu * cu - usq);
        cu = 3 * (ux + uy);
        const e5 = r2 * (1 + cu + 0.5 * cu * cu - usq);
        const e7 = r2 * (1 - cu + 0.5 * cu * cu - usq);
        cu = 3 * (uy - ux);
        const e6 = r2 * (1 + cu + 0.5 * cu * cu - usq);
        const e8 = r2 * (1 - cu + 0.5 * cu * cu - usq);

        // 平衡からのずれ（非平衡部分）
        const n0 = f0 - e0, n1 = f1 - e1, n2 = f2 - e2, n3 = f3 - e3, n4 = f4 - e4;
        const n5 = f5 - e5, n6 = f6 - e6, n7 = f7 - e7, n8 = f8 - e8;

        // Smagorinsky: 非平衡の運動量流束テンソルからひずみ速度に比例した渦粘性を足す
        const pxx = n1 + n3 + n5 + n6 + n7 + n8;
        const pyy = n2 + n4 + n5 + n6 + n7 + n8;
        const pxy = n5 - n6 + n7 - n8;
        const qMag = Math.sqrt(2 * (pxx * pxx + pyy * pyy + 2 * pxy * pxy));
        const tauEff = 0.5 * (tau + Math.sqrt(tau * tau + (cs2x18 * qMag) * inv));
        const omega = 1 / tauEff;

        // 衝突して次のバッファへ
        d0[idx] = f0 - omega * n0;
        d1[idx] = f1 - omega * n1;
        d2[idx] = f2 - omega * n2;
        d3[idx] = f3 - omega * n3;
        d4[idx] = f4 - omega * n4;
        d5[idx] = f5 - omega * n5;
        d6[idx] = f6 - omega * n6;
        d7[idx] = f7 - omega * n7;
        d8[idx] = f8 - omega * n8;

        // スポンジ層: 密度を 1 へ寄せる（f += σ (1-ρ) f_eq / ρ）
        if (i >= spongeStart) {
          const k = sponge[i] * (1 - rho) * inv;
          d0[idx] += k * e0;
          d1[idx] += k * e1;
          d2[idx] += k * e2;
          d3[idx] += k * e3;
          d4[idx] += k * e4;
          d5[idx] += k * e5;
          d6[idx] += k * e6;
          d7[idx] += k * e7;
          d8[idx] += k * e8;
        }
      }
    }

    // 流入列: 流入速度の平衡分布。密度は隣の列から取って圧力が自由に動けるようにする
    for (let j = 0; j < ny; j++) {
      const idx = j * nx;
      if (solid[idx] === 1) continue;
      let rho = 1;
      if (solid[idx + 1] === 0) {
        rho = s0[idx + 1] + s1[idx + 1] + s2[idx + 1] + s3[idx + 1] + s4[idx + 1] + s5[idx + 1] + s6[idx + 1] + s7[idx + 1] + s8[idx + 1];
      }
      for (let q = 0; q < 9; q++) dst[q][idx] = rho * fIn[q];
    }
    // 流出列: 隣の列をコピー（ゼロ勾配）
    for (let j = 0; j < ny; j++) {
      const idx = j * nx + nx - 1;
      if (solid[idx] === 1) continue;
      if (solid[idx - 1] === 1) {
        for (let q = 0; q < 9; q++) dst[q][idx] = fIn[q];
      } else {
        for (let q = 0; q < 9; q++) dst[q][idx] = dst[q][idx - 1];
      }
    }

    // 入れ替え
    this.cur = dst;
    this.nxt = src;
    this.stepCount++;

    // 発散の検知: 質量の合計が NaN になる、または平均密度が極端にずれたら不安定とみなす
    if (this.nFluidInner > 0) {
      const mean = massSum / this.nFluidInner;
      if (!(mean > 0.5 && mean < 2)) return false;
    }

    // 温度を 1 ステップ進める（速度は、流入列・流出列を境界条件に合わせて補う）
    if (this.heat !== null && thUx !== null && thUy !== null) this.stepThermal(this.heat, thUx, thUy);

    // 履歴のサンプリング（区間平均した力を記録する）
    if (this.stepCount % this.sampleEvery === 0 && this.accN > 0) {
      this.lastFx = this.accFx / this.accN;
      this.lastFy = this.accFy / this.accN;
      this.accFx = this.accFy = this.accN = 0;
      this.histT.push(this.stepCount * this.dt);
      this.histDrag.push(this.lastFx * this.forceScale);
      this.histLift.push(this.lastFy * this.forceScale);
      if (this.heat !== null) this.histMaxT.push(this.heat.maxTemp());
      if (this.histT.length > HISTORY_MAX + 200) {
        const cut = this.histT.length - HISTORY_MAX;
        this.histT.splice(0, cut);
        this.histDrag.splice(0, cut);
        this.histLift.splice(0, cut);
        if (this.heat !== null) this.histMaxT.splice(0, cut);
      }
    }
    return true;
  }

  /** 温度の 1 ステップ。LBM の速度配列の流入列・流出列を境界条件どおりに埋めてから熱を進める */
  private stepThermal(heat: FlowThermal, ux: Float32Array, uy: Float32Array): void {
    const { nx, ny, solid } = this;
    for (let j = 0; j < ny; j++) {
      const a = j * nx;
      const b = a + nx - 1;
      if (solid[a] === 0) {
        ux[a] = this.uIn;
        uy[a] = 0;
      }
      if (solid[b] === 0) {
        if (solid[b - 1] === 1) {
          ux[b] = this.uIn;
          uy[b] = 0;
        } else {
          ux[b] = ux[b - 1];
          uy[b] = uy[b - 1];
        }
      }
    }
    heat.step(ux, uy);
    this.heatOutAvg += (heat.heatOutW(ux) - this.heatOutAvg) * this.heatOutAlpha;
    // 温度が壊れたら（数値の暴走）、温度だけ初期化してやり直す。流れは続ける
    if (this.stepCount % 50 === 0 && !Number.isFinite(heat.maxTemp())) {
      heat.reset();
      this.thermalResets++;
    }
  }

  /** 発散したときの復旧: τ を少し上げて初期状態からやり直す */
  private recover(): void {
    this.instabilityCount++;
    this.tau = Math.min(1.5, this.tau + 0.05);
    this.initState();
    this.instabilityNote =
      `計算が不安定になったため初期状態に戻し、粘性を少し上げて（τ=${this.tau.toFixed(3)}）やり直しました（${this.instabilityCount}回目）。` +
      '格子数を増やすか、流速を下げると改善します。';
  }

  advance(steps: number): void {
    for (let k = 0; k < steps; k++) {
      if (!this.stepOnce()) {
        this.recover();
        return;
      }
    }
  }

  step(budgetMs: number): SolverStatus {
    const t0 = performance.now();
    let ran = 0;
    do {
      const before = this.stepCount;
      this.advance(CHUNK);
      ran += this.stepCount - before;
      if (this.stepCount < before) break; // 復旧で巻き戻った
    } while (performance.now() - t0 < budgetMs);
    const elapsed = Math.max(performance.now() - t0, 1e-3);
    return {
      done: false,
      progress: 0,
      iteration: this.stepCount,
      message: `LBM ${this.stepCount} ステップ（t = ${(this.stepCount * this.dt).toPrecision(3)} s、${Math.round((ran / elapsed) * 1000)} ステップ/秒）`,
    };
  }

  // ---------- 診断 ----------

  get reEffective(): number {
    return (this.uLat * this.lengthCells) / ((this.tau - 0.5) / 3);
  }

  totalMass(): number {
    const { cur, n, solid } = this;
    let sum = 0;
    for (let c = 0; c < n; c++) {
      if (solid[c]) continue;
      for (let q = 0; q < 9; q++) sum += cur[q][c];
    }
    return sum;
  }

  /** 利用者に見せる注意をまとめる */
  private buildWarnings(): string[] {
    const w = [...this.baseWarnings];
    // τ の下限や不安定化の対策で、物理的な Re より低い Re 相当で計算している場合
    if (this.rePhysical > 0 && this.reEffective < this.rePhysical * 0.98) {
      w.push(
        `格子が粗いため、実際のRe=${Math.round(this.rePhysical)}ではなくRe≈${Math.round(this.reEffective)}相当で計算しています。` +
          '格子数を増やすと改善します。',
      );
    }
    if (this.instabilityNote) w.push(this.instabilityNote);
    if (this.heat !== null) w.push(...this.thermalWarnings(this.heat));
    return w;
  }

  /** 温度の計算についての注意 */
  private thermalWarnings(heat: FlowThermal): string[] {
    const w: string[] = [
      '温度は 2D の断面で計算しています。板の表裏の面からの放熱は入れていないため、熱はすべて風が運び出します（実機より高めの温度になります）。',
      '固体は熱容量を持たない準定常で計算しているため、途中の温度の変化は実時間ではありません。温度が落ち着いたあとの値は、熱容量によらず同じです。',
    ];
    if (heat.slowed) {
      w.push('風がとても遅く熱の拡散が支配的なため、温度の計算の時間を流れより遅らせています。途中の温度の変化は実時間と合いません。風を強くすると改善します。');
    }
    if (heat.floatingHeatW > 0) {
      w.push(`放熱経路のない固体の中に ${heat.floatingHeatW.toPrecision(3)} W の発熱があります。温度が定まらないため、その部分は除いています。流体や温度固定の図形に接するようにしてください。`);
    }
    if (this.uIn === 0 && heat.heatInW > 0) {
      w.push('流入速度が 0 のため、風は熱を運びません。熱は空気の熱伝導だけで逃げるので、温度は非常に高くなります。流入速度を上げてください。');
    }
    if (this.thermalResets > 0) {
      w.push(`温度の計算が不安定になったため、温度だけ初期化してやり直しました（${this.thermalResets}回）。`);
    }
    return w;
  }

  /** 温度の結果（場・数値・履歴・部品ごと）。thermal が有効なときだけ呼ぶ */
  private thermalResult(heat: FlowThermal): { field: Field; scalars: ScalarValue[]; history: History; perShape: ReturnType<typeof buildPartTemps> } {
    const temp = this.fTemp!;
    heat.fillTemp(temp);
    const scalars: ScalarValue[] = [
      { key: 'maxTemp', label: '最高温度', unit: '°C', value: heat.maxTemp() },
      { key: 'heatOut', label: '流出口から風が運び出す熱（直近の平均）', unit: 'W', value: this.heatOutAvg },
      { key: 'heatIn', label: '発熱の合計', unit: 'W', value: heat.heatInW },
    ];
    if (heat.hasFixed) scalars.push({ key: 'heatFixed', label: '温度固定へ流れ込む熱', unit: 'W', value: heat.heatToFixedW() });
    return {
      // 物体の中も温度が決まっているので mask はかけない
      field: { key: 'temp', label: '温度', unit: '°C', data: temp },
      scalars,
      history: { key: 'maxTemp', label: '最高温度', unit: '°C', t: this.histT.slice(), values: this.histMaxT.slice() },
      perShape: buildPartTemps({ project: this.project, raster: this.raster, temp: heat.temperature(), valid: heat.bodyMask }),
    };
  }

  // ---------- 結果 ----------

  result(): ResultSet {
    const { nx, ny, n, h, cur, solid } = this;
    const vs = this.velScale;
    const ps = this.pressScale / 3;
    const speed = this.fSpeed;
    const uxF = this.fUx;
    const uyF = this.fUy;
    const press = this.fPress;
    const vort = this.fVort;

    // 分布関数からマクロ量を物理単位で取り出す
    for (let c = 0; c < n; c++) {
      if (solid[c]) {
        speed[c] = uxF[c] = uyF[c] = press[c] = 0;
        continue;
      }
      const f0 = cur[0][c], f1 = cur[1][c], f2 = cur[2][c], f3 = cur[3][c], f4 = cur[4][c];
      const f5 = cur[5][c], f6 = cur[6][c], f7 = cur[7][c], f8 = cur[8][c];
      const rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
      const ux = ((f1 - f3 + f5 - f6 - f7 + f8) / rho) * vs;
      const uy = ((f2 - f4 + f5 + f6 - f7 - f8) / rho) * vs;
      uxF[c] = ux;
      uyF[c] = uy;
      speed[c] = Math.hypot(ux, uy);
      press[c] = (rho - 1) * ps;
    }
    // 渦度 ω = ∂uy/∂x - ∂ux/∂y（内部は中心差分、端は片側差分。物体内部の速度は 0）
    for (let j = 0; j < ny; j++) {
      const jm = j > 0 ? j - 1 : j;
      const jp = j < ny - 1 ? j + 1 : j;
      for (let i = 0; i < nx; i++) {
        const idx = j * nx + i;
        if (solid[idx]) {
          vort[idx] = 0;
          continue;
        }
        const im = i > 0 ? i - 1 : i;
        const ip = i < nx - 1 ? i + 1 : i;
        const dvdx = (uyF[j * nx + ip] - uyF[j * nx + im]) / ((ip - im) * h);
        const dudy = (uxF[jp * nx + i] - uxF[jm * nx + i]) / ((jp - jm) * h);
        vort[idx] = dvdx - dudy;
      }
    }

    const mask = this.fluidMask;
    const fields: Field[] = [
      { key: 'speed', label: '流速', unit: 'm/s', data: speed, mask },
      { key: 'ux', label: '流速 x', unit: 'm/s', data: uxF, mask },
      { key: 'uy', label: '流速 y', unit: 'm/s', data: uyF, mask },
      { key: 'pressure', label: '圧力', unit: 'Pa', data: press, mask, diverging: true },
      { key: 'vorticity', label: '渦度', unit: '1/s', data: vort, mask, diverging: true },
    ];

    const drag = this.lastFx * this.forceScale;
    const lift = this.lastFy * this.forceScale;
    const time = this.stepCount * this.dt;
    // 動圧 × 代表面積（L × 厚さ）
    const qa = 0.5 * this.rhoPhys * this.uPhys * this.uPhys * this.length * this.thickness;
    const scalars: ScalarValue[] = [
      { key: 'Re', label: 'レイノルズ数', unit: '', value: this.rePhysical },
      { key: 'drag', label: '抗力', unit: 'N', value: drag },
      { key: 'lift', label: '揚力', unit: 'N', value: lift },
      { key: 'Cd', label: '抗力係数', unit: '', value: this.uIn > 0 && qa > 0 ? drag / qa : 0 },
      { key: 'Cl', label: '揚力係数', unit: '', value: this.uIn > 0 && qa > 0 ? lift / qa : 0 },
      { key: 'time', label: '経過時間', unit: 's', value: time },
      { key: 'latticeU', label: '格子単位の流入速度', unit: '', value: this.uLat },
      { key: 'tau', label: '緩和時間 τ', unit: '', value: this.tau },
      { key: 'smagorinskyCs', label: 'Smagorinsky 定数', unit: '', value: this.cs },
    ];
    const st = this.hasObstacle && this.uIn > 0 ? this.estimateStrouhal(qa) : null;
    if (st !== null) scalars.push({ key: 'strouhal', label: 'ストローハル数', unit: '', value: st });
    const th = this.heat !== null ? this.thermalResult(this.heat) : null;
    if (th) {
      fields.push(th.field);
      scalars.push(...th.scalars);
    }

    const history: History[] = [
      { key: 'drag', label: '抗力', unit: 'N', t: this.histT.slice(), values: this.histDrag.slice() },
      { key: 'lift', label: '揚力', unit: 'N', t: this.histT.slice(), values: this.histLift.slice() },
    ];

    if (th) history.push(th.history);

    const result: ResultSet = { analysis: 'flow', nx, ny, h, fields, scalars, history, warnings: this.buildWarnings() };
    if (th?.perShape) result.perShape = th.perShape;
    return result;
  }

  /**
   * 揚力履歴のゼロ交差から渦放出の周波数を求め、St = f L / U を返す。
   * 振幅が小さい・交差が少ない・間隔がばらつくときは null（まだ渦が出ていない）。
   */
  private estimateStrouhal(qa: number): number | null {
    const total = this.histLift.length;
    const m = Math.min(total, 1000);
    if (m < 50 || qa <= 0) return null;
    const t = this.histT;
    const v = this.histLift;
    const s = total - m;
    let mean = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = s; k < total; k++) {
      mean += v[k];
      if (v[k] < lo) lo = v[k];
      if (v[k] > hi) hi = v[k];
    }
    mean /= m;
    const amp = hi - lo;
    if (amp / qa < 0.05) return null; // 揚力係数の振れが小さすぎる

    // 平均値を下から上へ横切る時刻を集める（ヒステリシス付き）
    const band = 0.15 * amp;
    const cross: number[] = [];
    let armed = false;
    for (let k = s + 1; k < total; k++) {
      const a = v[k - 1] - mean;
      const b = v[k] - mean;
      if (b < -band) armed = true;
      if (armed && a <= 0 && b > 0) {
        cross.push(t[k - 1] + ((t[k] - t[k - 1]) * -a) / (b - a));
        armed = false;
      }
    }
    if (cross.length < 3) return null;
    const periods: number[] = [];
    for (let k = 1; k < cross.length; k++) periods.push(cross[k] - cross[k - 1]);
    const sorted = [...periods].sort((x, y) => x - y);
    const med = sorted[Math.floor(sorted.length / 2)];
    if (periods.some((p) => Math.abs(p - med) > 0.3 * med)) return null;
    const period = (cross[cross.length - 1] - cross[0]) / (cross.length - 1);
    return this.length / (this.uPhys * period);
  }
}

/** 初期擾乱などを指定できる版（テスト・診断用） */
export function createFlowSolverWithOptions(project: Project, raster: Raster, opts: FlowOptions = {}): FlowSolver {
  return new FlowSolverImpl(project, raster, opts);
}

export const createFlowSolver: SolverFactory = (project, raster) => createFlowSolverWithOptions(project, raster);
