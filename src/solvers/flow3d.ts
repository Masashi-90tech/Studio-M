// 3D の流れ（Lite、ボクセルの格子ボルツマン法）。2D の flow.ts（D2Q9）を D3Q19 に広げたもの。
//
// - 3D モデルを風洞（grid3d.ts の studyGrid が決める直方体の格子）の中に置き、一様な流れを当てる。
//   PC のエンジン（OpenFOAM）も同じ格子に結果を載せるので、並べて比べられる。
// - 部品のセル（voxelizeMesh の inside）は半格子バウンスバック
// - 流入面（flow.direction の上流側の面）: 流入速度の平衡分布。密度は隣の層から取る
// - 流出面: 隣の層の分布をそのままコピー（ゼロ勾配）。その手前にスポンジ層（密度だけ 1 へ寄せる）
// - 側面: slip = 鏡面反射（対称）、noslip = バウンスバック（壁面）
// - 高 Re でも崩れないよう Smagorinsky の渦粘性（LES）を足している（D3Q19 でも式は 2D と同じ）
// - 格子の量と物理量の換算は dx = h, dt = uLat * h / U（2D と同じ）
//
// 計算は「引き込み型（pull）」の移流＋衝突を 1 回のループにまとめ、分布関数を方向ごとの Float32Array 2 組
// （現在 / 次）で持ってステップごとに入れ替える。ホットループの中ではメモリ確保をしない。
// 流れの向きは 6 通り（±x, ±y, ±z）あり、軸の番号 axis と符号 sign で一般化している（流入・流出の層だけが違う）。
//
// プロ設定（flow.advanced、すべて省略可。省略時は自動）:
// - smagorinskyCs: Smagorinsky 定数（0 で LES 無効、自動は 0.1）
// - latticeU:      格子上の流入速度（0.01〜0.2 に丸める。自動は 0.08、τ が足りなければ 0.1）
//
// 力: 運動量交換法で部品が受ける力を求める。流れの向きの成分が抗力、垂直な 2 方向が揚力（liftA・liftB）。
//   流れに垂直な 2 軸を番号の小さい順に A・B とする（流れが x なら A = y、B = z。y なら A = x、B = z。z なら A = x、B = y）。
//   揚力の符号は、その軸の正の向きを正とする。
//
// result().scalars に載せる「実際に使った値」（キーは固定。2D の流れと同じ key をそろえ、3D で増えるものを足した）:
// - Re / drag / Cd / time / latticeU / tau / smagorinskyCs（2D と同じ）
// - liftA / liftB / ClA / ClB: 流れに垂直な 2 方向の揚力 [N] と揚力係数
// - steps: LBM のステップ数、flowThroughs: 流れが風洞を通り抜けた回数の目安
// - refArea: 抗力係数の基準面積（流れの向きへの部品の投影面積）[m²]、length: 代表長さ D [m]
// - cellSize / cells / cellsInside: セルの一辺 [mm]・格子のセル数・部品の中のセル数
// history: drag / liftA / liftB の推移（区間平均）

import { getMaterial } from '../core/materials';
import { flow3DDefaults, flowAxis, mesh3DBounds, studyGrid } from '../core/grid3d';
import { meshMetrics, voxelizeMesh } from '../core/voxelize';
import type { FlowDirection3D, Flow3DSettings, Grid3D, History, ResultSet3D, ScalarValue, Solver3D, Solver3DFactory, SolverStatus, Study3D } from '../core/types';

// ---------- 定数（2D の flow.ts と同じ考え方） ----------

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
/** 流出側スポンジ層の厚さ（流れの向きのセル数に対する割合）と最大の強さ */
const SPONGE_FRACTION = 0.15;
const SPONGE_STRENGTH = 0.3;
/** 代表長さ D がこのセル数に満たないと、形や抗力の精度が低い */
const MIN_LENGTH_CELLS = 10;
/** 発散から復旧するときの τ の上限 */
const TAU_RECOVER_MAX = 1.5;

// D3Q19: 0:(0,0,0) 1:(1,0,0) 2:(-1,0,0) 3:(0,1,0) 4:(0,-1,0) 5:(0,0,1) 6:(0,0,-1)
//   7:(1,1,0) 8:(-1,-1,0) 9:(1,-1,0) 10:(-1,1,0) 11:(1,0,1) 12:(-1,0,-1) 13:(1,0,-1) 14:(-1,0,1)
//   15:(0,1,1) 16:(0,-1,-1) 17:(0,1,-1) 18:(0,-1,1)
// 1 以上の方向は、奇数番号の次の偶数番号が逆向き（OPP）
const CX = [0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
const CY = [0, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 0, 0, 1, -1, 1, -1];
const CZ = [0, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, 1, -1, -1, 1, 1, -1, -1, 1];
const Q = 19;
const OPP: number[] = CX.map((_, q) => (q === 0 ? 0 : q % 2 === 1 ? q + 1 : q - 1));
const W0 = 1 / 3;
const W1 = 1 / 18;
const W2 = 1 / 36;
const WEIGHT = CX.map((_, q) => (q === 0 ? W0 : q < 7 ? W1 : W2));
/** 方向 q の成分を、mask のビット（1 = x, 2 = y, 4 = z）の軸だけ反転した方向（鏡面反射用） */
const MIRROR: number[] = (() => {
  const t: number[] = [];
  for (let mask = 0; mask < 8; mask++) {
    for (let q = 0; q < Q; q++) {
      const cx = mask & 1 ? -CX[q] : CX[q];
      const cy = mask & 2 ? -CY[q] : CY[q];
      const cz = mask & 4 ? -CZ[q] : CZ[q];
      let found = q;
      for (let p = 0; p < Q; p++) if (CX[p] === cx && CY[p] === cy && CZ[p] === cz) found = p;
      t.push(found);
    }
  }
  return t;
})();

const AXIS_NAME = ['x', 'y', 'z'] as const;

// ---------- 公開する型 ----------

/** 下の層（格子と部品のセルを直接渡して作る）の入力。Study3D から作る createFlow3DSolver がこれを組み立てる */
export interface Flow3DCoreOptions {
  grid: Grid3D;
  /** 1 = 部品のセル。長さ nx·ny·nz */
  solid: Uint8Array;
  /** 流れの向き（省略時 '+x'） */
  direction?: FlowDirection3D;
  /** 側面（省略時 slip） */
  walls?: 'slip' | 'noslip';
  /** 流入速度 [m/s] */
  inletVelocity: number;
  /** 流体の密度 [kg/m³]（省略時 1.204 = 空気） */
  rho?: number;
  /** 流体の動粘度 [m²/s]（省略時 1.5e-5） */
  viscosity?: number;
  /** 代表長さ D [m]（Re の基準）。省略時は部品のセルの流れに垂直な寸法の最大（部品がなければ風洞の断面の大きい方） */
  length?: number;
  /** 抗力係数の基準面積 [m²]。省略時は部品のセルを流れの向きへ投影した面積 */
  refArea?: number;
  advanced?: Flow3DSettings['advanced'];
  /** 初期擾乱の強さ（1 = 標準、0 = なし） */
  perturbation?: number;
  /** 結果に足す注意（格子の注意など。呼び出し側で作ったもの） */
  extraWarnings?: string[];
  /** 部品の中のセル数の表示用（省略時は solid から数える） */
  cellsInside?: number;
}

/** 通常の Solver3D に、テストや診断に使う情報を足したもの */
export interface Flow3DCore extends Solver3D {
  /** LBM を指定ステップだけ進める（時間予算なし）。不安定になったら復旧して止まる */
  advance(steps: number): void;
  /** 流体セル全体の格子上の質量（Σρ） */
  totalMass(): number;
  readonly stepCount: number;
  readonly tau: number;
  readonly uLat: number;
  /** 1 ステップあたりの物理時間 [s] */
  readonly dt: number;
  readonly length: number;
  readonly rePhysical: number;
  readonly reEffective: number;
  /** 発散して復旧した回数 */
  readonly instabilityCount: number;
}

// ---------- 実装 ----------

class Flow3DImpl implements Flow3DCore {
  readonly analysis = 'flow' as const;

  private readonly grid: Grid3D;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly n: number;
  private readonly h: number;
  private readonly solid: Uint8Array;
  private readonly fluidMask: Uint8Array;
  private readonly slip: boolean;
  private readonly axis: 0 | 1 | 2;
  private readonly sign: 1 | -1;
  private readonly perp: [number, number];
  private readonly rhoPhys: number;
  private readonly perturbation: number;
  private readonly cs: number;
  private readonly cellsInside: number;
  private readonly extraWarnings: string[];

  // 物理量と格子量の換算
  readonly rePhysical: number;
  readonly length: number;
  readonly uLat: number;
  readonly dt: number;
  private readonly lengthCells: number;
  private readonly hasObstacle: boolean;
  private readonly uPhys: number;
  private readonly uIn: number;
  private readonly velScale: number;
  private readonly pressScale: number;
  private readonly forceScale: number;
  private readonly refArea: number;
  private readonly sponge: Float32Array;
  /** 部品のセルの外接（格子の番号）。擾乱の位置に使う */
  private readonly bmin: number[];
  private readonly bmax: number[];
  tau: number;

  // 分布関数（方向ごとの配列を 2 組）
  // 方向 q のセル idx は q·n + idx に置く（1 本の配列にすると、ホットループが持つ配列の参照が減って速い）
  private cur: Float32Array;
  private nxt: Float32Array;
  /** 流入面に置く平衡分布（ρ = 1） */
  private readonly fIn = new Float64Array(Q);

  // 境界処理のテーブル
  private readonly special: Uint8Array;
  private readonly off: Int32Array;
  private readonly tmp = new Float64Array(Q);
  private readonly lo: [number, number, number];
  private readonly hi: [number, number, number];
  private readonly nFluidInner: number;
  /** 流入面・流出面の流体セルの番号と、その内側の隣のセルまでの番号の差 */
  private readonly inCells: Int32Array;
  private readonly outCells: Int32Array;
  private readonly inNbStep: number;
  private readonly outNbStep: number;

  // 部品表面のリンク（運動量交換法）
  /** 部品へ向かう分布の位置（q·n + idx） */
  private readonly linkPos: Int32Array;
  private readonly linkCx: Int8Array;
  private readonly linkCy: Int8Array;
  private readonly linkCz: Int8Array;

  // 状態
  stepCount = 0;
  instabilityCount = 0;
  private acc = [0, 0, 0];
  private accN = 0;
  private last = [0, 0, 0]; // 直近のサンプル区間で平均した力（格子単位、x・y・z）
  private readonly sampleEvery: number;
  private histT: number[] = [];
  private histDrag: number[] = [];
  private histLiftA: number[] = [];
  private histLiftB: number[] = [];
  private instabilityNote = '';
  private readonly baseWarnings: string[] = [];

  // result() で使い回す出力バッファ
  private readonly fSpeed: Float32Array;
  private readonly fUx: Float32Array;
  private readonly fUy: Float32Array;
  private readonly fUz: Float32Array;
  private readonly fPress: Float32Array;
  private readonly fVort: Float32Array;

  constructor(opts: Flow3DCoreOptions) {
    const { grid } = opts;
    const { nx, ny, nz, h } = grid;
    const n = nx * ny * nz;
    if (opts.solid.length !== n) throw new Error('部品のセルの配列の長さが格子と合っていません。');
    this.grid = grid;
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.n = n;
    this.h = h;
    this.solid = Uint8Array.from(opts.solid);
    this.fluidMask = new Uint8Array(n);
    let inside = 0;
    for (let c = 0; c < n; c++) {
      this.fluidMask[c] = this.solid[c] ? 0 : 1;
      inside += this.solid[c] ? 1 : 0;
    }
    this.cellsInside = opts.cellsInside ?? inside;
    this.extraWarnings = opts.extraWarnings ?? [];
    this.slip = (opts.walls ?? 'slip') === 'slip';
    const { axis, sign } = flowAxis(opts.direction ?? '+x');
    this.axis = axis;
    this.sign = sign;
    const perp = [0, 1, 2].filter((a) => a !== axis);
    this.perp = [perp[0], perp[1]];
    const dims = [nx, ny, nz];
    if (dims[axis] < 3) throw new Error('流れの向きの格子が 3 セルに満たないため、流れを計算できません。格子を細かくしてください。');
    const adv = opts.advanced ?? {};
    this.perturbation = opts.perturbation ?? 1;
    this.cs = adv.smagorinskyCs !== undefined && adv.smagorinskyCs >= 0 ? adv.smagorinskyCs : CS_DEFAULT;
    this.rhoPhys = opts.rho ?? 1.204;
    const nuPhys = opts.viscosity ?? 1.5e-5;

    // 流入速度。0 のときは警告して扱いを決める（向きは flow.direction で決まるので、負の値は大きさだけを使う）
    const uSet = opts.inletVelocity;
    const uAbs = Math.abs(uSet);
    if (uSet < 0) this.baseWarnings.push('流入速度が負です。流れの向きは「流れの向き」の設定で決まるので、大きさだけを使います。');
    if (uAbs < 1e-9) this.baseWarnings.push('流入速度が 0 です。流れのない状態を計算します。');
    this.uPhys = uAbs > 1e-9 ? uAbs : 1;

    // 部品のセルの外接（流れの向きの範囲は擾乱の位置、垂直方向は代表長さの既定に使う）
    const bmin = [nx, ny, nz];
    const bmax = [-1, -1, -1];
    const proj = new Uint8Array(dims[perp[0]] * dims[perp[1]]);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          if (!this.solid[(k * ny + j) * nx + i]) continue;
          const p = [i, j, k];
          for (let a = 0; a < 3; a++) {
            if (p[a] < bmin[a]) bmin[a] = p[a];
            if (p[a] > bmax[a]) bmax[a] = p[a];
          }
          proj[p[perp[1]] * dims[perp[0]] + p[perp[0]]] = 1;
        }
    this.hasObstacle = bmax[0] >= 0;
    const crossCells = this.hasObstacle ? Math.max(bmax[perp[0]] - bmin[perp[0]] + 1, bmax[perp[1]] - bmin[perp[1]] + 1) : Math.max(dims[perp[0]], dims[perp[1]]);
    this.length = opts.length !== undefined && opts.length > 0 ? opts.length : crossCells * h;
    this.lengthCells = this.length / h;
    let projCells = 0;
    for (let c = 0; c < proj.length; c++) projCells += proj[c];
    this.refArea = opts.refArea !== undefined && opts.refArea > 0 ? opts.refArea : projCells * h * h;
    this.rePhysical = uAbs > 1e-9 ? (uAbs * this.length) / nuPhys : 0;

    // 格子速度と τ の決め方（2D と同じ）。まず小さめの uLat を試し、τ が足りなければ大きい方へ
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
    // 格子上の力 → 物理の力 [N]（運動量 ρ h³·(h/dt) を dt で割る = ρ h⁴/dt²）
    this.forceScale = this.pressScale * h * h;
    this.sampleEvery = Math.max(1, Math.min(50, Math.round(this.lengthCells / (20 * uLat))));

    if (this.hasObstacle && this.lengthCells < MIN_LENGTH_CELLS) {
      this.baseWarnings.push(
        `部品の代表長さ D が格子 ${this.lengthCells.toFixed(1)} セル分しかなく（目安は ${MIN_LENGTH_CELLS} セル以上）、形・抗力の精度が低くなります。` +
          'セルを小さくするか、セル数の上限を上げてください。',
      );
    }
    if (this.rePhysical > 1000) {
      this.baseWarnings.push(
        `Re=${Math.round(this.rePhysical)} は乱流の流れです。細かい渦は格子で解けず、壁の近くのモデルも使っていないので、` +
          '抗力・圧力は目安として見てください（Smagorinsky の渦粘性で崩れないようにしています）。',
      );
    }
    if (this.hasObstacle && this.refArea > 0) {
      const crossArea = dims[perp[0]] * dims[perp[1]] * h * h;
      const blockage = this.refArea / crossArea;
      if (blockage > 0.1) {
        this.baseWarnings.push(
          `風洞の断面に対して部品が大きく（閉塞率 ${(blockage * 100).toFixed(0)}%）、抗力が大きめに出ます。風洞の余白（側方）を広げると改善します。`,
        );
      }
    }
    if (!this.hasObstacle) this.baseWarnings.push('流れの中に部品がありません（部品のセルが 0 個）。一様な流れをそのまま計算します。');

    // 平衡分布（ρ = 1, 流入速度）
    const uv = [0, 0, 0];
    uv[axis] = sign * this.uIn;
    this.equilibrium(1, uv[0], uv[1], uv[2], this.fIn);

    // 流出側のスポンジ層。圧力波が端で反射して力に乗るのを抑える（速度は変えず密度だけ 1 へ寄せる）
    const nAlong = dims[axis];
    const nSponge = Math.min(Math.max(4, Math.round(SPONGE_FRACTION * nAlong)), nAlong - 2);
    this.sponge = new Float32Array(nAlong);
    for (let m = 0; m < nAlong; m++) {
      const dOut = sign > 0 ? nAlong - 1 - m : m; // 流出面からの距離（セル）
      if (dOut < nSponge) {
        const r = (nSponge - dOut) / nSponge;
        this.sponge[m] = SPONGE_STRENGTH * r * r;
      }
    }

    // 主ループの範囲: 流れの向きは流入・流出の層を除く（その 2 層は境界条件で埋める）
    this.lo = [0, 0, 0];
    this.hi = [nx - 1, ny - 1, nz - 1];
    this.lo[axis] = 1;
    this.hi[axis] = dims[axis] - 2;

    // 流入・流出の層の流体セル
    const stride = [1, nx, nx * ny];
    const planeIn = sign > 0 ? 0 : dims[axis] - 1;
    const planeOut = sign > 0 ? dims[axis] - 1 : 0;
    const inList: number[] = [];
    const outList: number[] = [];
    for (let v = 0; v < dims[perp[1]]; v++) {
      for (let u = 0; u < dims[perp[0]]; u++) {
        const base = u * stride[perp[0]] + v * stride[perp[1]];
        const ci = planeIn * stride[axis] + base;
        const co = planeOut * stride[axis] + base;
        if (!this.solid[ci]) inList.push(ci);
        if (!this.solid[co]) outList.push(co);
      }
    }
    this.inCells = Int32Array.from(inList);
    this.outCells = Int32Array.from(outList);
    this.inNbStep = sign * stride[axis];
    this.outNbStep = -sign * stride[axis];

    // 境界テーブル: セルごとに、引き込み元が側面の外・部品のセルになる方向があるか。部品へのリンク（力）も集める
    this.special = new Uint8Array(n);
    this.off = new Int32Array(Q);
    for (let q = 0; q < Q; q++) this.off[q] = -CX[q] - CY[q] * nx - CZ[q] * nx * ny;
    const links: { q: number; idx: number }[] = [];
    let nInner = 0;
    for (let k = this.lo[2]; k <= this.hi[2]; k++) {
      for (let j = this.lo[1]; j <= this.hi[1]; j++) {
        for (let i = this.lo[0]; i <= this.hi[0]; i++) {
          const idx = (k * ny + j) * nx + i;
          if (this.solid[idx]) continue;
          nInner++;
          for (let q = 1; q < Q; q++) {
            const sx = i - CX[q];
            const sy = j - CY[q];
            const sz = k - CZ[q];
            if (sx < 0 || sx >= nx || sy < 0 || sy >= ny || sz < 0 || sz >= nz) {
              this.special[idx] = 1;
            } else if (this.solid[idx + this.off[q]]) {
              this.special[idx] = 1;
              // 部品への衝突は力の計算に使う（部品へ向かう方向は引き込みの逆向き）
              links.push({ q: OPP[q], idx });
            }
          }
        }
      }
    }
    this.nFluidInner = nInner;
    this.linkPos = Int32Array.from(links.map((l) => l.q * n + l.idx));
    this.linkCx = Int8Array.from(links.map((l) => CX[l.q]));
    this.linkCy = Int8Array.from(links.map((l) => CY[l.q]));
    this.linkCz = Int8Array.from(links.map((l) => CZ[l.q]));

    this.cur = new Float32Array(Q * n);
    this.nxt = new Float32Array(Q * n);
    this.fSpeed = new Float32Array(n);
    this.fUx = new Float32Array(n);
    this.fUy = new Float32Array(n);
    this.fUz = new Float32Array(n);
    this.fPress = new Float32Array(n);
    this.fVort = new Float32Array(n);

    this.bmin = bmin;
    this.bmax = bmax;
    this.initState();
  }

  // ---------- 初期化 ----------

  /** 平衡分布 f_eq(ρ, u) を out に書く */
  private equilibrium(rho: number, ux: number, uy: number, uz: number, out: Float64Array): void {
    const usq = 1.5 * (ux * ux + uy * uy + uz * uz);
    for (let q = 0; q < Q; q++) {
      const cu = 3 * (CX[q] * ux + CY[q] * uy + CZ[q] * uz);
      out[q] = WEIGHT[q] * rho * (1 + cu + 0.5 * cu * cu - usq);
    }
  }

  /** 一様流＋ごく小さな擾乱で初期化する */
  private initState(): void {
    const { nx, ny, nz, cur, axis, sign } = this;
    const dims = [nx, ny, nz];
    const eq = new Float64Array(Q);
    const [pa, pb] = this.perp;
    // 擾乱: 部品の斜め後方に小さな横向きの速度の山を置いて対称性を崩す
    const c = [0.3 * nx, 0.5 * ny, 0.5 * nz];
    if (this.hasObstacle) {
      for (let a = 0; a < 3; a++) c[a] = (this.bmin[a] + this.bmax[a] + 1) / 2;
      c[axis] = sign > 0 ? this.bmax[axis] + 1 + 0.5 * this.lengthCells : this.bmin[axis] - 0.5 * this.lengthCells;
      c[pa] += 0.25 * this.lengthCells;
      c[pb] += 0.15 * this.lengthCells;
    } else {
      c[axis] = 0.5 * dims[axis];
    }
    const sigma = Math.max(1.5, 0.4 * this.lengthCells);
    const amp = this.uIn > 0 ? 0.1 * this.uLat * this.perturbation : 0; // 流れがないときは乱さない
    const u = [0, 0, 0];
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const idx = (k * ny + j) * nx + i;
          u[0] = u[1] = u[2] = 0;
          if (!this.solid[idx]) {
            u[axis] = sign * this.uIn;
            const dx = i + 0.5 - c[0];
            const dy = j + 0.5 - c[1];
            const dz = k + 0.5 - c[2];
            const g = amp * Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * sigma * sigma));
            u[pa] += g;
            u[pb] += 0.5 * g;
          }
          this.equilibrium(1, u[0], u[1], u[2], eq);
          for (let q = 0; q < Q; q++) cur[q * this.n + idx] = eq[q];
        }
      }
    }
    this.stepCount = 0;
    this.acc[0] = this.acc[1] = this.acc[2] = 0;
    this.accN = 0;
    this.last[0] = this.last[1] = this.last[2] = 0;
    this.histT = [];
    this.histDrag = [];
    this.histLiftA = [];
    this.histLiftB = [];
  }

  // ---------- 1 ステップ（引き込み型の移流＋衝突） ----------

  /** 1 ステップ進める。不安定になったら false */
  private stepOnce(): boolean {
    const { nx, ny, solid, special, off, tmp, fIn, sponge, axis, slip } = this;
    const nz = this.nz;
    const src = this.cur;
    const dst = this.nxt;
    const n = this.n;
    // 方向 q の分布を引き込む位置は idx + p[q]（q·n + 引き込み元との番号の差）、書き込む位置は idx + c[q]（q·n）
    const p1 = n + off[1], p2 = 2 * n + off[2], p3 = 3 * n + off[3], p4 = 4 * n + off[4], p5 = 5 * n + off[5], p6 = 6 * n + off[6];
    const p7 = 7 * n + off[7], p8 = 8 * n + off[8], p9 = 9 * n + off[9], p10 = 10 * n + off[10], p11 = 11 * n + off[11], p12 = 12 * n + off[12];
    const p13 = 13 * n + off[13], p14 = 14 * n + off[14], p15 = 15 * n + off[15], p16 = 16 * n + off[16], p17 = 17 * n + off[17], p18 = 18 * n + off[18];
    const c1 = n, c2 = 2 * n, c3 = 3 * n, c4 = 4 * n, c5 = 5 * n, c6 = 6 * n, c7 = 7 * n, c8 = 8 * n, c9 = 9 * n;
    const c10 = 10 * n, c11 = 11 * n, c12 = 12 * n, c13 = 13 * n, c14 = 14 * n, c15 = 15 * n, c16 = 16 * n, c17 = 17 * n, c18 = 18 * n;
    const tau = this.tau;
    const cs2x18 = 18 * this.cs * this.cs;
    const lox = this.lo[0], loy = this.lo[1], loz = this.lo[2];
    const hix = this.hi[0], hiy = this.hi[1], hiz = this.hi[2];

    // 部品が受ける力（運動量交換法）: 部品へ向かう分布 f と跳ね返る分布の和 = 2 f
    let fx = 0;
    let fy = 0;
    let fz = 0;
    for (let k = 0; k < this.linkPos.length; k++) {
      const v = src[this.linkPos[k]];
      fx += v * this.linkCx[k];
      fy += v * this.linkCy[k];
      fz += v * this.linkCz[k];
    }
    this.acc[0] += 2 * fx;
    this.acc[1] += 2 * fy;
    this.acc[2] += 2 * fz;
    this.accN++;

    let massSum = 0;
    for (let k = loz; k <= hiz; k++) {
      for (let j = loy; j <= hiy; j++) {
        const row = (k * ny + j) * nx;
        for (let i = lox; i <= hix; i++) {
          const idx = row + i;
          if (solid[idx] === 1) continue;

          // 移流: 隣のセルの衝突後の値を引き込む（壁・部品側は反射）
          let f0: number, f1: number, f2: number, f3: number, f4: number, f5: number, f6: number, f7: number, f8: number, f9: number;
          let f10: number, f11: number, f12: number, f13: number, f14: number, f15: number, f16: number, f17: number, f18: number;
          if (special[idx] === 0) {
            f0 = src[idx];
            f1 = src[idx + p1];
            f2 = src[idx + p2];
            f3 = src[idx + p3];
            f4 = src[idx + p4];
            f5 = src[idx + p5];
            f6 = src[idx + p6];
            f7 = src[idx + p7];
            f8 = src[idx + p8];
            f9 = src[idx + p9];
            f10 = src[idx + p10];
            f11 = src[idx + p11];
            f12 = src[idx + p12];
            f13 = src[idx + p13];
            f14 = src[idx + p14];
            f15 = src[idx + p15];
            f16 = src[idx + p16];
            f17 = src[idx + p17];
            f18 = src[idx + p18];
          } else {
            tmp[0] = src[idx];
            for (let q = 1; q < Q; q++) {
              const px = i - CX[q];
              const py = j - CY[q];
              const pz = k - CZ[q];
              const out = (px < 0 || px >= nx ? 1 : 0) | (py < 0 || py >= ny ? 2 : 0) | (pz < 0 || pz >= nz ? 4 : 0);
              if (out !== 0) {
                // 側面の外: 対称なら鏡面反射、壁面ならバウンスバック
                tmp[q] = slip ? src[MIRROR[out * Q + q] * n + idx] : src[OPP[q] * n + idx];
              } else {
                const sIdx = idx + off[q];
                tmp[q] = solid[sIdx] === 1 ? src[OPP[q] * n + idx] : src[q * n + sIdx];
              }
            }
            f0 = tmp[0]; f1 = tmp[1]; f2 = tmp[2]; f3 = tmp[3]; f4 = tmp[4]; f5 = tmp[5]; f6 = tmp[6]; f7 = tmp[7]; f8 = tmp[8]; f9 = tmp[9];
            f10 = tmp[10]; f11 = tmp[11]; f12 = tmp[12]; f13 = tmp[13]; f14 = tmp[14]; f15 = tmp[15]; f16 = tmp[16]; f17 = tmp[17]; f18 = tmp[18];
          }

          // マクロ量
          const rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8 + f9 + f10 + f11 + f12 + f13 + f14 + f15 + f16 + f17 + f18;
          const inv = 1 / rho;
          const ux = (f1 - f2 + f7 - f8 + f9 - f10 + f11 - f12 + f13 - f14) * inv;
          const uy = (f3 - f4 + f7 - f8 - f9 + f10 + f15 - f16 + f17 - f18) * inv;
          const uz = (f5 - f6 + f11 - f12 - f13 + f14 + f15 - f16 - f17 + f18) * inv;
          massSum += rho;

          // 平衡分布（逆向きの対は a ± b）
          const usq = 1.5 * (ux * ux + uy * uy + uz * uz);
          const r0 = W0 * rho;
          const r1 = W1 * rho;
          const r2 = W2 * rho;
          const e0 = r0 * (1 - usq);
          let cu = 3 * ux;
          let a = r1 * (1 + 0.5 * cu * cu - usq);
          let b = r1 * cu;
          const e1 = a + b, e2 = a - b;
          cu = 3 * uy;
          a = r1 * (1 + 0.5 * cu * cu - usq);
          b = r1 * cu;
          const e3 = a + b, e4 = a - b;
          cu = 3 * uz;
          a = r1 * (1 + 0.5 * cu * cu - usq);
          b = r1 * cu;
          const e5 = a + b, e6 = a - b;
          cu = 3 * (ux + uy);
          a = r2 * (1 + 0.5 * cu * cu - usq);
          b = r2 * cu;
          const e7 = a + b, e8 = a - b;
          cu = 3 * (ux - uy);
          a = r2 * (1 + 0.5 * cu * cu - usq);
          b = r2 * cu;
          const e9 = a + b, e10 = a - b;
          cu = 3 * (ux + uz);
          a = r2 * (1 + 0.5 * cu * cu - usq);
          b = r2 * cu;
          const e11 = a + b, e12 = a - b;
          cu = 3 * (ux - uz);
          a = r2 * (1 + 0.5 * cu * cu - usq);
          b = r2 * cu;
          const e13 = a + b, e14 = a - b;
          cu = 3 * (uy + uz);
          a = r2 * (1 + 0.5 * cu * cu - usq);
          b = r2 * cu;
          const e15 = a + b, e16 = a - b;
          cu = 3 * (uy - uz);
          a = r2 * (1 + 0.5 * cu * cu - usq);
          b = r2 * cu;
          const e17 = a + b, e18 = a - b;

          // 平衡からのずれ（非平衡部分）
          const n0 = f0 - e0, n1 = f1 - e1, n2 = f2 - e2, n3 = f3 - e3, n4 = f4 - e4, n5 = f5 - e5, n6 = f6 - e6, n7 = f7 - e7, n8 = f8 - e8, n9 = f9 - e9;
          const n10 = f10 - e10, n11 = f11 - e11, n12 = f12 - e12, n13 = f13 - e13, n14 = f14 - e14, n15 = f15 - e15, n16 = f16 - e16, n17 = f17 - e17, n18 = f18 - e18;

          // Smagorinsky: 非平衡の運動量流束テンソルからひずみ速度に比例した渦粘性を足す（式は 2D と同じ）
          const pxx = n1 + n2 + n7 + n8 + n9 + n10 + n11 + n12 + n13 + n14;
          const pyy = n3 + n4 + n7 + n8 + n9 + n10 + n15 + n16 + n17 + n18;
          const pzz = n5 + n6 + n11 + n12 + n13 + n14 + n15 + n16 + n17 + n18;
          const pxy = n7 + n8 - n9 - n10;
          const pxz = n11 + n12 - n13 - n14;
          const pyz = n15 + n16 - n17 - n18;
          const qMag = Math.sqrt(2 * (pxx * pxx + pyy * pyy + pzz * pzz + 2 * (pxy * pxy + pxz * pxz + pyz * pyz)));
          const tauEff = 0.5 * (tau + Math.sqrt(tau * tau + cs2x18 * qMag * inv));
          const omega = 1 / tauEff;

          // 衝突して次のバッファへ
          dst[idx] = f0 - omega * n0;
          dst[idx + c1] = f1 - omega * n1;
          dst[idx + c2] = f2 - omega * n2;
          dst[idx + c3] = f3 - omega * n3;
          dst[idx + c4] = f4 - omega * n4;
          dst[idx + c5] = f5 - omega * n5;
          dst[idx + c6] = f6 - omega * n6;
          dst[idx + c7] = f7 - omega * n7;
          dst[idx + c8] = f8 - omega * n8;
          dst[idx + c9] = f9 - omega * n9;
          dst[idx + c10] = f10 - omega * n10;
          dst[idx + c11] = f11 - omega * n11;
          dst[idx + c12] = f12 - omega * n12;
          dst[idx + c13] = f13 - omega * n13;
          dst[idx + c14] = f14 - omega * n14;
          dst[idx + c15] = f15 - omega * n15;
          dst[idx + c16] = f16 - omega * n16;
          dst[idx + c17] = f17 - omega * n17;
          dst[idx + c18] = f18 - omega * n18;

          // スポンジ層: 密度を 1 へ寄せる（f += σ (1-ρ) f_eq / ρ）
          const sg = sponge[axis === 0 ? i : axis === 1 ? j : k];
          if (sg > 0) {
            const kk = sg * (1 - rho) * inv;
            dst[idx] += kk * e0;
            dst[idx + c1] += kk * e1;
            dst[idx + c2] += kk * e2;
            dst[idx + c3] += kk * e3;
            dst[idx + c4] += kk * e4;
            dst[idx + c5] += kk * e5;
            dst[idx + c6] += kk * e6;
            dst[idx + c7] += kk * e7;
            dst[idx + c8] += kk * e8;
            dst[idx + c9] += kk * e9;
            dst[idx + c10] += kk * e10;
            dst[idx + c11] += kk * e11;
            dst[idx + c12] += kk * e12;
            dst[idx + c13] += kk * e13;
            dst[idx + c14] += kk * e14;
            dst[idx + c15] += kk * e15;
            dst[idx + c16] += kk * e16;
            dst[idx + c17] += kk * e17;
            dst[idx + c18] += kk * e18;
          }
        }
      }
    }

    // 流入の層: 流入速度の平衡分布。密度は内側の隣から取って圧力が自由に動けるようにする
    for (let m = 0; m < this.inCells.length; m++) {
      const idx = this.inCells[m];
      const nb = idx + this.inNbStep;
      let rho = 1;
      if (solid[nb] === 0) {
        rho = 0;
        for (let q = 0; q < Q; q++) rho += src[q * n + nb];
      }
      for (let q = 0; q < Q; q++) dst[q * n + idx] = rho * fIn[q];
    }
    // 流出の層: 内側の隣をコピー（ゼロ勾配）
    for (let m = 0; m < this.outCells.length; m++) {
      const idx = this.outCells[m];
      const nb = idx + this.outNbStep;
      if (solid[nb] === 1) {
        for (let q = 0; q < Q; q++) dst[q * n + idx] = fIn[q];
      } else {
        for (let q = 0; q < Q; q++) dst[q * n + idx] = dst[q * n + nb];
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

    // 履歴のサンプリング（区間平均した力を記録する）
    if (this.stepCount % this.sampleEvery === 0 && this.accN > 0) {
      for (let a = 0; a < 3; a++) {
        this.last[a] = this.acc[a] / this.accN;
        this.acc[a] = 0;
      }
      this.accN = 0;
      const [fd, fa, fb] = this.forces();
      this.histT.push(this.stepCount * this.dt);
      this.histDrag.push(fd);
      this.histLiftA.push(fa);
      this.histLiftB.push(fb);
      if (this.histT.length > HISTORY_MAX + 200) {
        const cut = this.histT.length - HISTORY_MAX;
        this.histT.splice(0, cut);
        this.histDrag.splice(0, cut);
        this.histLiftA.splice(0, cut);
        this.histLiftB.splice(0, cut);
      }
    }
    return true;
  }

  /** 直近の力 [N]: [抗力（流れの向き）, 揚力 A, 揚力 B] */
  private forces(): [number, number, number] {
    const s = this.forceScale;
    return [this.sign * this.last[this.axis] * s, this.last[this.perp[0]] * s, this.last[this.perp[1]] * s];
  }

  /** 発散したときの復旧: τ を少し上げて初期状態からやり直す */
  private recover(): void {
    this.instabilityCount++;
    this.tau = Math.min(TAU_RECOVER_MAX, this.tau + 0.05);
    this.initState();
    this.instabilityNote =
      `計算が不安定になったため初期状態に戻し、粘性を少し上げて（τ=${this.tau.toFixed(3)}）やり直しました（${this.instabilityCount}回目）。` +
      'セルを小さくするか、流速を下げると改善します。';
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
      this.advance(1);
      ran += this.stepCount - before;
      if (this.stepCount < before) break; // 復旧で巻き戻った
    } while (performance.now() - t0 < budgetMs);
    const elapsed = Math.max(performance.now() - t0, 1e-3);
    const through = this.flowThroughs();
    return {
      done: false,
      progress: Math.min(1, through),
      iteration: this.stepCount,
      message: `LBM ${this.stepCount} ステップ（t = ${(this.stepCount * this.dt).toPrecision(3)} s、流れが風洞を ${through.toFixed(1)} 回通り抜けた、${Math.round((ran / elapsed) * 1000)} ステップ/秒）`,
    };
  }

  // ---------- 診断 ----------

  /** 流れが風洞を通り抜けた回数の目安（流入速度で進んだ距離 / 風洞の長さ） */
  private flowThroughs(): number {
    const nAlong = [this.nx, this.ny, this.nz][this.axis];
    return (this.stepCount * this.uLat) / nAlong;
  }

  get reEffective(): number {
    return (this.uLat * this.lengthCells) / ((this.tau - 0.5) / 3);
  }

  totalMass(): number {
    const { cur, n, solid } = this;
    let sum = 0;
    for (let c = 0; c < n; c++) {
      if (solid[c]) continue;
      for (let q = 0; q < Q; q++) sum += cur[q * n + c];
    }
    return sum;
  }

  /** 利用者に見せる注意をまとめる */
  private buildWarnings(): string[] {
    const w = [...this.extraWarnings, ...this.baseWarnings];
    // τ の下限や不安定化の対策で、物理的な Re より低い Re 相当で計算している場合
    if (this.rePhysical > 0 && this.reEffective < this.rePhysical * 0.98) {
      w.push(
        `格子が粗いため、実際の Re=${Math.round(this.rePhysical)} ではなく Re≈${Math.round(this.reEffective)} 相当で計算しています。` +
          'セルを小さくすると改善します。',
      );
    }
    if (this.instabilityNote) w.push(this.instabilityNote);
    return w;
  }

  // ---------- 結果 ----------

  result(): ResultSet3D {
    const { nx, ny, nz, n, h, cur, solid } = this;
    const vs = this.velScale;
    const ps = this.pressScale / 3;
    const speed = this.fSpeed;
    const uxF = this.fUx;
    const uyF = this.fUy;
    const uzF = this.fUz;
    const press = this.fPress;
    const vort = this.fVort;

    // 分布関数からマクロ量を物理単位で取り出す
    for (let c = 0; c < n; c++) {
      if (solid[c]) {
        speed[c] = uxF[c] = uyF[c] = uzF[c] = press[c] = 0;
        continue;
      }
      let rho = 0;
      for (let q = 0; q < Q; q++) rho += cur[q * n + c];
      const ux = (cur[1 * n + c] - cur[2 * n + c] + cur[7 * n + c] - cur[8 * n + c] + cur[9 * n + c] - cur[10 * n + c] + cur[11 * n + c] - cur[12 * n + c] + cur[13 * n + c] - cur[14 * n + c]) / rho;
      const uy = (cur[3 * n + c] - cur[4 * n + c] + cur[7 * n + c] - cur[8 * n + c] - cur[9 * n + c] + cur[10 * n + c] + cur[15 * n + c] - cur[16 * n + c] + cur[17 * n + c] - cur[18 * n + c]) / rho;
      const uz = (cur[5 * n + c] - cur[6 * n + c] + cur[11 * n + c] - cur[12 * n + c] - cur[13 * n + c] + cur[14 * n + c] + cur[15 * n + c] - cur[16 * n + c] - cur[17 * n + c] + cur[18 * n + c]) / rho;
      uxF[c] = ux * vs;
      uyF[c] = uy * vs;
      uzF[c] = uz * vs;
      speed[c] = Math.hypot(uxF[c], uyF[c], uzF[c]);
      press[c] = (rho - 1) * ps;
    }
    // 渦度の大きさ |∇×u|（内部は中心差分、端は片側差分。部品の中の速度は 0）
    const sx = 1;
    const sy = nx;
    const sz = nx * ny;
    for (let k = 0; k < nz; k++) {
      const km = k > 0 ? k - 1 : k;
      const kp = k < nz - 1 ? k + 1 : k;
      for (let j = 0; j < ny; j++) {
        const jm = j > 0 ? j - 1 : j;
        const jp = j < ny - 1 ? j + 1 : j;
        for (let i = 0; i < nx; i++) {
          const idx = (k * ny + j) * nx + i;
          if (solid[idx]) {
            vort[idx] = 0;
            continue;
          }
          const im = i > 0 ? i - 1 : i;
          const ip = i < nx - 1 ? i + 1 : i;
          const dx = (ip - im) * h;
          const dy = (jp - jm) * h;
          const dz = (kp - km) * h;
          const xp = idx + (ip - i) * sx;
          const xm = idx + (im - i) * sx;
          const yp = idx + (jp - j) * sy;
          const ym = idx + (jm - j) * sy;
          const zp = idx + (kp - k) * sz;
          const zm = idx + (km - k) * sz;
          const wx = (uzF[yp] - uzF[ym]) / dy - (uyF[zp] - uyF[zm]) / dz;
          const wy = (uxF[zp] - uxF[zm]) / dz - (uzF[xp] - uzF[xm]) / dx;
          const wz = (uyF[xp] - uyF[xm]) / dx - (uxF[yp] - uxF[ym]) / dy;
          vort[idx] = Math.hypot(wx, wy, wz);
        }
      }
    }

    const mask = this.fluidMask;
    const fields = [
      { key: 'speed', label: '流速', unit: 'm/s', data: speed, mask },
      { key: 'ux', label: '流速 x', unit: 'm/s', data: uxF, mask },
      { key: 'uy', label: '流速 y', unit: 'm/s', data: uyF, mask },
      { key: 'uz', label: '流速 z', unit: 'm/s', data: uzF, mask },
      { key: 'pressure', label: '圧力', unit: 'Pa', data: press, mask, diverging: true },
      { key: 'vorticity', label: '渦度の大きさ', unit: '1/s', data: vort, mask },
    ];

    const [drag, liftA, liftB] = this.forces();
    const time = this.stepCount * this.dt;
    // 動圧 × 基準面積
    const qa = 0.5 * this.rhoPhys * this.uPhys * this.uPhys * this.refArea;
    const coef = (v: number): number => (this.uIn > 0 && qa > 0 ? v / qa : 0);
    const [pa, pb] = this.perp;
    const scalars: ScalarValue[] = [
      { key: 'Re', label: 'レイノルズ数', unit: '', value: this.rePhysical },
      { key: 'drag', label: '抗力', unit: 'N', value: drag },
      { key: 'liftA', label: `揚力 ${AXIS_NAME[pa]} 方向`, unit: 'N', value: liftA },
      { key: 'liftB', label: `揚力 ${AXIS_NAME[pb]} 方向`, unit: 'N', value: liftB },
      { key: 'Cd', label: '抗力係数', unit: '', value: coef(drag) },
      { key: 'ClA', label: `揚力係数 ${AXIS_NAME[pa]} 方向`, unit: '', value: coef(liftA) },
      { key: 'ClB', label: `揚力係数 ${AXIS_NAME[pb]} 方向`, unit: '', value: coef(liftB) },
      { key: 'time', label: '経過時間', unit: 's', value: time },
      { key: 'latticeU', label: '格子単位の流入速度', unit: '', value: this.uLat },
      { key: 'tau', label: '緩和時間 τ', unit: '', value: this.tau },
      { key: 'smagorinskyCs', label: 'Smagorinsky 定数', unit: '', value: this.cs },
      { key: 'steps', label: 'LBM のステップ数', unit: '', value: this.stepCount },
      { key: 'flowThroughs', label: '風洞を通り抜けた回数', unit: '回', value: this.flowThroughs() },
      { key: 'refArea', label: '基準面積（流れの向きの投影面積）', unit: 'm²', value: this.refArea },
      { key: 'length', label: '代表長さ D', unit: 'm', value: this.length },
      { key: 'cellSize', label: 'セルの一辺', unit: 'mm', value: h * 1000 },
      { key: 'cells', label: '格子のセル数', unit: '個', value: n },
      { key: 'cellsInside', label: '部品の中のセル数', unit: '個', value: this.cellsInside },
    ];

    const history: History[] = [
      { key: 'drag', label: '抗力', unit: 'N', t: this.histT.slice(), values: this.histDrag.slice() },
      { key: 'liftA', label: `揚力 ${AXIS_NAME[pa]} 方向`, unit: 'N', t: this.histT.slice(), values: this.histLiftA.slice() },
      { key: 'liftB', label: `揚力 ${AXIS_NAME[pb]} 方向`, unit: 'N', t: this.histT.slice(), values: this.histLiftB.slice() },
    ];

    return { analysis: 'flow', grid: this.grid, fields, scalars, history, warnings: this.buildWarnings() };
  }
}

/** 格子と部品のセルを直接渡して作る（テスト・診断用。Study3D から作るには createFlow3DSolver） */
export function createFlow3DCore(opts: Flow3DCoreOptions): Flow3DCore {
  return new Flow3DImpl(opts);
}

/** 三角形から、流れの向き（axis）へ投影した面積 [m²]。閉じた形なら ½ Σ |n·e|·面積 */
function projectedArea(mesh: Study3D['mesh'], axis: 0 | 1 | 2, triArea: Float64Array): number {
  const { positions: p, indices: idx } = mesh;
  let sum = 0;
  for (let t = 0; t < triArea.length; t++) {
    const a = idx[3 * t] * 3;
    const b = idx[3 * t + 1] * 3;
    const c = idx[3 * t + 2] * 3;
    const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    // 法線の axis 成分（外積の大きさの半分が面積なので、そのまま投影面積になる）
    const nn = axis === 0 ? u[1] * v[2] - u[2] * v[1] : axis === 1 ? u[2] * v[0] - u[0] * v[2] : u[0] * v[1] - u[1] * v[0];
    sum += Math.abs(nn) / 2;
  }
  return sum / 2;
}

export const createFlow3DSolver: Solver3DFactory = (study: Study3D): Solver3D => {
  const grid = studyGrid(study);
  const flow = study.flow ?? flow3DDefaults();
  const { axis } = flowAxis(flow.direction);
  const fluid = getMaterial(flow.fluidId);
  const vox = voxelizeMesh(study.mesh, grid);
  const bounds = mesh3DBounds(study.mesh)!; // studyGrid が三角形なしを先にはじいている
  const { triArea } = meshMetrics(study.mesh);

  // 代表長さ D = 流れに垂直な寸法の最大（flowBounds と同じ）
  const cross = [0, 1, 2].filter((a) => a !== axis).map((a) => bounds.max[a] - bounds.min[a]);
  const length = Math.max(...cross);
  const refArea = projectedArea(study.mesh, axis, triArea);

  const warnings: string[] = [];
  if (flow.thermal?.enabled === true) {
    warnings.push('温度の計算は次の段階です。今は流れだけを計算します（温度の設定は使っていません）。');
  }
  if (vox.count === 0) {
    warnings.push('部品の中にセルが 1 つもありません。セルが部品より大きいか、3D モデルが閉じた立体になっていません。セルを小さくしてください。');
  } else if (vox.count < 200) {
    warnings.push(`部品の中のセルが ${vox.count} 個しかなく、形の細かさが失われています。セルを小さくすると結果が信頼できるようになります。`);
  }
  if (vox.openRays > 0) {
    warnings.push(
      `3D モデルが閉じた立体になっていない可能性があります（${vox.openRays} 本の光線で、表面を通る回数が奇数でした）。` +
        '穴や重なりがあると、部品の中の判定がずれます。モデルを修復してから読み込み直してください。',
    );
  }
  if (vox.thinRays > 0) {
    warnings.push(
      `薄い部分が消えている可能性があります（x 方向の厚さがセル 1 つ（${(grid.h * 1000).toPrecision(2)} mm）に満たない部分が ${vox.thinRays} か所）。` +
        'セルを小さくするか、薄い部分を厚くしてください。',
    );
  }
  // 球での照合（flow3d.test.ts）: 部品の幅 D が 8 セルで Cd が式の約 1.4 倍、12 セル以上で約 1.2 倍。粗いと抗力が大きめに出る
  const cellsAcross = length / grid.h;
  if (vox.count > 0 && cellsAcross < 12) {
    warnings.push(
      `部品の幅が ${cellsAcross.toFixed(0)} セルしかないため、抗力・抗力係数は 2〜4 割ほど大きめに出ます（球で確かめた目安）。` +
        '数字で比べたいときは、計算の細かさを上げて部品の幅を 12 セル以上にしてください。流れのようす（渦・流線）の傾向は今のままでも見られます。',
    );
  }
  if (vox.meshVolume > 0 && vox.count > 0) {
    const ratio = (vox.count * grid.h ** 3) / vox.meshVolume;
    if (Math.abs(ratio - 1) > 0.1) {
      warnings.push(`格子で表した体積は元の形の ${(ratio * 100).toFixed(0)}% です（階段状に近似するため）。セルを小さくすると形が近づきます。`);
    }
  }

  return createFlow3DCore({
    grid,
    solid: vox.inside,
    direction: flow.direction,
    walls: flow.walls,
    inletVelocity: flow.inletVelocity,
    rho: fluid.rho,
    viscosity: fluid.viscosity ?? 1.5e-5,
    length,
    refArea,
    advanced: flow.advanced,
    extraWarnings: warnings,
    cellsInside: vox.count,
  });
};
