// 電磁波解析（レーダー・電波）: 2D FDTD（Yee格子）。
//
// 【方程式と偏波】
//   TM = (Ez, Hx, Hy)、TE = (Hz, Ex, Ey)。どちらも同じ形に直して一つのコードで解く。
//     F  = 格子中心のスカラー場（TM: Ez、TE: η0·Hz）
//     Gx, Gy = 格子の辺にある2成分（TM: η0·Hx, η0·Hy、TE: -Ex, -Ey）
//   F(i,j)   は (i+½, j+½)、Gx(i,j) は (i+½, j+1)、Gy(i,j) は (i+1, j+½)（単位はセル幅 h）。
//   更新式（損失・材料は各係数配列に畳み込む）
//     Gx = caGx·Gx − cbGx·(F(i,j+1) − F(i,j))
//     Gy = caGy·Gy + cbGy·(F(i+1,j) − F(i,j))
//     F  = caF·F  + cbF·((Gy(i,j) − Gy(i−1,j)) − (Gx(i,j) − Gx(i,j−1)))
//   電場の単位は V/m のまま、磁場は η0 倍して同じ単位にしている（c·dt/h = Sc が結合係数）。
//   TM は F が電場なので F の係数に εr・σ が入り、TE は辺の電場 G の係数に入る（辺の材料は両隣のセルの平均）。
//
// 【入射波（平面波）】散乱場定式化を使う。
//   解くのは「散乱波 = 全体 − 入射波」だけで、入射波は解析的な平面波として与える。
//   物体のセル（比誘電率・損失が背景と違うセル）には分極電流に相当する項
//     −(εr − εb)·∂Ei/∂t − σ·Ei
//   を足し、完全導体のセルでは散乱場 = −入射場（接線電場が 0）に固定する。
//   これで TF/SF の境界面もソフトソースの端の回折もなく、斜め入射・全領域の物体を同じ形で扱える。
//   入射波は「格子の数値分散関係を解いた波数」で作るので、離散方程式の厳密解になっており、
//   数値分散で散乱波と位相がずれることがない。基準計算（物体なしの第2の計算）も要らない:
//   入射波の電力は解析的に 1 なので、透過率・反射率はそのまま散乱場から出せる。
//
// 【点波源】F に直接足すソフトソース。物体なしの基準計算を同時に走らせ、散乱波 = 全体 − 基準 とする。
//
// 【吸収境界】CPML（κ = 1、σ は 3 次で漸増、α は逆向きに漸減）を 4 辺の内側に置く。
//   ψ は PML 帯の中だけに持つ。外周の 1 セルは PEC 壁（PML の外側なので影響しない）。
//
// 【定常の取り方】CW は 1 周期がちょうど整数ステップになるよう dt を少し縮め、
//   1 周期ごとの離散フーリエ和（sin/cos の積算）で振幅・位相を出す。
//   パルスは全ステップを積算し、周波数 f での伝達関数として振幅を出す。
//
// ホットループの中ではメモリ確保をしない（全部 Float32Array を使い回す）。

import { getMaterial } from '../core/materials';
import type { Field, History, Project, Raster, ResultSet, ScalarValue, Solver, SolverFactory, SolverStatus } from '../core/types';

// ---------- 定数 ----------

const C0 = 299792458;
const EPS0 = 8.8541878128e-12;
const ETA0 = 376.730313668;
/** PML の σ の次数 */
const PML_ORDER = 3;
/** PML の α の最大値 [S/m]（低周波・近接場の吸収を助ける） */
const PML_ALPHA_MAX = 0.05;
/** 2D の安定限界 1/√2 の少し手前 */
const COURANT_MAX = 0.7;
/** 履歴に残すサンプルの最大数 */
const HISTORY_MAX = 2000;
/** 時間チェックの間隔（ステップ） */
const CHUNK = 4;
/** CW の立ち上げ時間 [周期] */
const RAMP_PERIODS = 3;
/** 下限 dB */
const INTENSITY_FLOOR_DB = -40;

// ---------- 公開: 誘電体スラブの解析解 ----------

export interface SlabResult {
  /** 電力透過率 0〜1 */
  transmission: number;
  /** 電力反射率 0〜1 */
  reflection: number;
  /** 吸収率 0〜1（= 1 − 透過 − 反射） */
  absorption: number;
}

/**
 * 空気中に置いた誘電体スラブへの垂直入射の電力透過率・反射率（ファブリ・ペロー、多重反射込み）。
 * 複素比誘電率 εc = εr(1 − j·tanδ)、屈折率 n = √εc。厚さ d、真空波長 λ0 = c/f として
 *   r12 = (1 − n)/(1 + n)、t12 = 2/(1 + n)、t23 = 2n/(1 + n)、δ = 2π n d/λ0
 *   t = t12·t23·e^{-jδ} / (1 − r12²·e^{-2jδ})、r = r12(1 − e^{-2jδ}) / (1 − r12²·e^{-2jδ})
 *   透過率 = |t|²、反射率 = |r|²（両側とも空気なので屈折率の比は 1）
 * 無損失なら T + R = 1。半波長板（d = λ0/(2n) の整数倍）で T = 1、四分の一波長で T は最小になる。
 */
export function slabTransmission(epsR: number, tanD: number, thicknessM: number, freqHz: number): SlabResult {
  // n = √(εr(1 − j tanδ)) = nr − j·ni（ni ≥ 0）
  const zr = epsR;
  const zi = -epsR * tanD;
  const m = Math.hypot(zr, zi);
  const nr = Math.sqrt(Math.max(0, (m + zr) / 2));
  const ni = -Math.sqrt(Math.max(0, (m - zr) / 2)); // 虚部は負（損失）
  const k0d = (2 * Math.PI * freqHz * thicknessM) / C0;
  // δ = a + j·b
  const a = k0d * nr;
  const b = k0d * ni;
  // 複素数の小さな演算
  const mul = (x: [number, number], y: [number, number]): [number, number] => [x[0] * y[0] - x[1] * y[1], x[0] * y[1] + x[1] * y[0]];
  const div = (x: [number, number], y: [number, number]): [number, number] => {
    const d = y[0] * y[0] + y[1] * y[1];
    return [(x[0] * y[0] + x[1] * y[1]) / d, (x[1] * y[0] - x[0] * y[1]) / d];
  };
  const n: [number, number] = [nr, ni];
  const onePlusN: [number, number] = [1 + nr, ni];
  const oneMinusN: [number, number] = [1 - nr, -ni];
  const r12 = div(oneMinusN, onePlusN);
  const t12 = div([2, 0], onePlusN);
  const t23 = div(mul([2, 0], n), onePlusN);
  // e^{-jδ} = e^{b}·(cos a − j sin a)、e^{-2jδ} = e^{2b}·(cos 2a − j sin 2a)
  const e1: [number, number] = [Math.exp(b) * Math.cos(a), -Math.exp(b) * Math.sin(a)];
  const e2: [number, number] = [Math.exp(2 * b) * Math.cos(2 * a), -Math.exp(2 * b) * Math.sin(2 * a)];
  const r12sq = mul(r12, r12);
  const rr = mul(r12sq, e2);
  const den: [number, number] = [1 - rr[0], -rr[1]];
  const t = div(mul(mul(t12, t23), e1), den);
  const r = div(mul(r12, [1 - e2[0], -e2[1]]), den);
  const T = t[0] * t[0] + t[1] * t[1];
  const R = r[0] * r[0] + r[1] * r[1];
  return { transmission: T, reflection: R, absorption: Math.max(0, 1 - T - R) };
}

// ---------- 数値分散 ----------

/**
 * Yee 格子の数値分散関係
 *   sin²(ωdt/2) = (Sc/n)²·(sin²(κ cosθ/2) + sin²(κ sinθ/2))
 * を κ（1セルあたりの位相 [rad]）について解く。n は媒質の屈折率。
 */
function numericalWavenumber(wdt: number, sc: number, n: number, theta: number): number {
  const target = (Math.sin(wdt / 2) ** 2 * n * n) / (sc * sc);
  const cx = Math.cos(theta);
  const cy = Math.sin(theta);
  const g = (k: number) => Math.sin((k * cx) / 2) ** 2 + Math.sin((k * cy) / 2) ** 2;
  if (g(Math.PI) <= target) return (wdt * n) / sc; // 格子で表せない粗さ。連続の波数で代用
  let lo = 0;
  let hi = Math.PI;
  for (let it = 0; it < 60; it++) {
    const mid = 0.5 * (lo + hi);
    if (g(mid) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// ---------- PML ----------

interface PmlProfile {
  /** G の位置（x = i+1）に使う係数 */
  bGx: Float32Array;
  aGx: Float32Array;
  /** F の位置（x = i+½）に使う係数 */
  bFx: Float32Array;
  aFx: Float32Array;
  bGy: Float32Array;
  aGy: Float32Array;
  bFy: Float32Array;
  aFy: Float32Array;
}

/** 1方向ぶんの CPML 係数。len セルの両端 np セルが PML、pos = k + offset が位置 */
function pmlAxis(len: number, np: number, offset: number, sigMax: number, alphaMax: number, sc: number): { b: Float32Array; a: Float32Array } {
  const b = new Float32Array(len).fill(1);
  const a = new Float32Array(len);
  if (np <= 0) return { b, a };
  for (let k = 0; k < len; k++) {
    const pos = k + offset;
    const depth = Math.max(np - pos, pos - (len - np), 0);
    if (depth <= 0) continue;
    const x = Math.min(depth, np) / np;
    const sig = sigMax * x ** PML_ORDER;
    const al = alphaMax * (1 - x);
    const bb = Math.exp(-(sig + al) * sc);
    b[k] = bb;
    a[k] = (sig / (sig + al)) * (bb - 1);
  }
  return { b, a };
}

function buildPml(nx: number, ny: number, np: number, sc: number, nBg: number, h: number): PmlProfile {
  // 最適値の目安 σ_opt = 0.8(m+1)/(η h √εr)。無次元化して σ_n = σ·η0·h
  const sigMax = (0.8 * (PML_ORDER + 1)) / nBg;
  const alphaMax = PML_ALPHA_MAX * ETA0 * h;
  const gx = pmlAxis(nx, np, 1, sigMax, alphaMax, sc);
  const fx = pmlAxis(nx, np, 0.5, sigMax, alphaMax, sc);
  const gy = pmlAxis(ny, np, 1, sigMax, alphaMax, sc);
  const fy = pmlAxis(ny, np, 0.5, sigMax, alphaMax, sc);
  return { bGx: gx.b, aGx: gx.a, bFx: fx.b, aFx: fx.a, bGy: gy.b, aGy: gy.a, bFy: fy.b, aFy: fy.a };
}

// ---------- 材料の係数 ----------

interface Coeffs {
  caF: Float32Array;
  cbF: Float32Array;
  caGx: Float32Array;
  cbGx: Float32Array;
  caGy: Float32Array;
  cbGy: Float32Array;
}

/** セルごとの材料（比誘電率・導電率・完全導体） */
interface CellMaterials {
  eps: Float32Array;
  sig: Float32Array;
  pec: Uint8Array;
}

/** 損失を半ステップずつ陰的に扱う標準の係数 Ca = (1 − α)/(1 + α)、Cb = (Sc/εr)/(1 + α)、α = σ dt/(2 ε0 εr) */
function lossCoeff(eps: number, sig: number, dt: number, sc: number): { ca: number; cb: number } {
  const alpha = (sig * dt) / (2 * EPS0 * eps);
  return { ca: (1 - alpha) / (1 + alpha), cb: sc / eps / (1 + alpha) };
}

function buildCoeffs(te: boolean, nx: number, ny: number, mat: CellMaterials, dt: number, sc: number): Coeffs {
  const n = nx * ny;
  const co: Coeffs = {
    caF: new Float32Array(n).fill(1),
    cbF: new Float32Array(n).fill(sc),
    caGx: new Float32Array(n).fill(1),
    cbGx: new Float32Array(n).fill(sc),
    caGy: new Float32Array(n).fill(1),
    cbGy: new Float32Array(n).fill(sc),
  };
  if (!te) {
    // TM: F = Ez に材料が入る。完全導体は Ez = 0
    for (let c = 0; c < n; c++) {
      if (mat.pec[c]) {
        co.caF[c] = 0;
        co.cbF[c] = 0;
      } else {
        const k = lossCoeff(mat.eps[c], mat.sig[c], dt, sc);
        co.caF[c] = k.ca;
        co.cbF[c] = k.cb;
      }
    }
    return co;
  }
  // TE: 辺の電場 G に材料が入る。辺の材料は両隣の平均、片側でも金属なら辺は完全導体（接線電場 0）
  const edge = (c: number, c2: number, ca: Float32Array, cb: Float32Array) => {
    if (mat.pec[c] || mat.pec[c2]) {
      ca[c] = 0;
      cb[c] = 0;
      return;
    }
    const k = lossCoeff(0.5 * (mat.eps[c] + mat.eps[c2]), 0.5 * (mat.sig[c] + mat.sig[c2]), dt, sc);
    ca[c] = k.ca;
    cb[c] = k.cb;
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      edge(c, j < ny - 1 ? c + nx : c, co.caGx, co.cbGx);
      edge(c, i < nx - 1 ? c + 1 : c, co.caGy, co.cbGy);
    }
  }
  return co;
}

// ---------- Yee 格子 ----------

class Yee {
  readonly F: Float32Array;
  readonly Gx: Float32Array;
  readonly Gy: Float32Array;
  // CPML の補助変数（PML 帯の中だけ）
  private readonly psiGy: Float32Array; // x 方向の帯: Gy の更新に使う ∂F/∂x
  private readonly psiGx: Float32Array; // y 方向の帯: Gx の更新に使う ∂F/∂y
  private readonly psiFx: Float32Array; // x 方向の帯: F の更新に使う ∂Gy/∂x
  private readonly psiFy: Float32Array; // y 方向の帯: F の更新に使う ∂Gx/∂y

  constructor(
    readonly nx: number,
    readonly ny: number,
    private readonly np: number,
    private readonly co: Coeffs,
    private readonly pml: PmlProfile,
    private readonly te: boolean,
    private readonly sc: number,
  ) {
    const n = nx * ny;
    this.F = new Float32Array(n);
    this.Gx = new Float32Array(n);
    this.Gy = new Float32Array(n);
    this.psiGy = new Float32Array(ny * 2 * np);
    this.psiFx = new Float32Array(ny * 2 * np);
    this.psiGx = new Float32Array(nx * 2 * np);
    this.psiFy = new Float32Array(nx * 2 * np);
  }

  /** G（TM では磁場、TE では電場）を半ステップ進める */
  updateG(): void {
    const { nx, ny, F, Gx, Gy, te } = this;
    const { caGx, cbGx, caGy, cbGy } = this.co;
    if (te) {
      for (let j = 1; j <= ny - 2; j++) {
        let c = j * nx + 1;
        for (let i = 1; i <= nx - 2; i++, c++) {
          const f = F[c];
          Gx[c] = caGx[c] * Gx[c] - cbGx[c] * (F[c + nx] - f);
          Gy[c] = caGy[c] * Gy[c] + cbGy[c] * (F[c + 1] - f);
        }
      }
    } else {
      // TM の G は磁場で無損失: 係数は一定（Ca = 1、Cb = Sc）なので配列を読まずに済ませる
      const sc = this.sc;
      for (let j = 1; j <= ny - 2; j++) {
        let c = j * nx + 1;
        for (let i = 1; i <= nx - 2; i++, c++) {
          const f = F[c];
          Gx[c] -= sc * (F[c + nx] - f);
          Gy[c] += sc * (F[c + 1] - f);
        }
      }
    }
    // Gx は j = 0 の行、Gy は i = 0 の列も F の更新で使う
    for (let c = 1; c <= nx - 2; c++) Gx[c] = caGx[c] * Gx[c] - cbGx[c] * (F[c + nx] - F[c]);
    for (let j = 1; j <= ny - 2; j++) {
      const c = j * nx;
      Gy[c] = caGy[c] * Gy[c] + cbGy[c] * (F[c + 1] - F[c]);
    }
    if (this.np > 0) {
      const p = this.pml;
      this.cpmlX(Gy, this.co.cbGy, 1, F, 1, 0, p.bGx, p.aGx, this.psiGy, 0, this.nx - 2, 1, this.ny - 2);
      this.cpmlY(Gx, this.co.cbGx, -1, F, nx, 0, p.bGy, p.aGy, this.psiGx, 1, this.nx - 2, 0, this.ny - 2);
    }
  }

  /** F を 1 ステップ進める */
  updateF(): void {
    const { nx, ny, F, Gx, Gy } = this;
    const { caF, cbF } = this.co;
    if (this.te) {
      // TE の F は磁場で無損失（Ca = 1、Cb = Sc）
      const sc = this.sc;
      for (let j = 1; j <= ny - 2; j++) {
        let c = j * nx + 1;
        for (let i = 1; i <= nx - 2; i++, c++) {
          F[c] += sc * (Gy[c] - Gy[c - 1] - (Gx[c] - Gx[c - nx]));
        }
      }
    } else {
      for (let j = 1; j <= ny - 2; j++) {
        let c = j * nx + 1;
        for (let i = 1; i <= nx - 2; i++, c++) {
          F[c] = caF[c] * F[c] + cbF[c] * (Gy[c] - Gy[c - 1] - (Gx[c] - Gx[c - nx]));
        }
      }
    }
    if (this.np > 0) {
      const p = this.pml;
      this.cpmlX(F, cbF, 1, Gy, 0, -1, p.bFx, p.aFx, this.psiFx, 1, this.nx - 2, 1, this.ny - 2);
      this.cpmlY(F, cbF, -1, Gx, 0, -nx, p.bFy, p.aFy, this.psiFy, 1, this.nx - 2, 1, this.ny - 2);
    }
  }

  /**
   * x 方向の PML 帯（左右 np 列）の補正。差分は src[c+o1] − src[c+o0]。
   * ψ ← b·ψ + a·差分、dst[c] += sgn·cb[c]·ψ
   */
  private cpmlX(
    dst: Float32Array,
    cb: Float32Array,
    sgn: number,
    src: Float32Array,
    o1: number,
    o0: number,
    b: Float32Array,
    a: Float32Array,
    psi: Float32Array,
    ilo: number,
    ihi: number,
    jlo: number,
    jhi: number,
  ): void {
    const { nx, np } = this;
    const w2 = 2 * np;
    for (let j = jlo; j <= jhi; j++) {
      const row = j * nx;
      const prow = j * w2;
      const lEnd = Math.min(np - 1, ihi);
      for (let i = ilo; i <= lEnd; i++) {
        const c = row + i;
        const pi = prow + i;
        const p = b[i] * psi[pi] + a[i] * (src[c + o1] - src[c + o0]);
        psi[pi] = p;
        dst[c] += sgn * cb[c] * p;
      }
      for (let i = Math.max(nx - np, ilo); i <= ihi; i++) {
        const c = row + i;
        const pi = prow + i - nx + w2;
        const p = b[i] * psi[pi] + a[i] * (src[c + o1] - src[c + o0]);
        psi[pi] = p;
        dst[c] += sgn * cb[c] * p;
      }
    }
  }

  /** y 方向の PML 帯（上下 np 行）の補正。cpmlX と同じ式 */
  private cpmlY(
    dst: Float32Array,
    cb: Float32Array,
    sgn: number,
    src: Float32Array,
    o1: number,
    o0: number,
    b: Float32Array,
    a: Float32Array,
    psi: Float32Array,
    ilo: number,
    ihi: number,
    jlo: number,
    jhi: number,
  ): void {
    const { nx, ny, np } = this;
    const w2 = 2 * np;
    const rows = (j: number, sy: number) => {
      const bj = b[j];
      const aj = a[j];
      const row = j * nx;
      const prow = sy * nx;
      for (let i = ilo; i <= ihi; i++) {
        const c = row + i;
        const p = bj * psi[prow + i] + aj * (src[c + o1] - src[c + o0]);
        psi[prow + i] = p;
        dst[c] += sgn * cb[c] * p;
      }
    };
    const bEnd = Math.min(np - 1, jhi);
    for (let j = jlo; j <= bEnd; j++) rows(j, j);
    for (let j = Math.max(ny - np, jlo); j <= jhi; j++) rows(j, j - ny + w2);
  }
}

// ---------- 離散フーリエ和 ----------

/** F の sin/cos 積算。CW は 1 周期ごとに入れ替えて 0 に戻し、パルスは積算し続ける */
class Phasor {
  s: Float32Array;
  c: Float32Array;
  /** 直近に完成した値 */
  ss: Float32Array;
  sc: Float32Array;

  constructor(n: number) {
    this.s = new Float32Array(n);
    this.c = new Float32Array(n);
    this.ss = new Float32Array(n);
    this.sc = new Float32Array(n);
  }

  accumulate(f: Float32Array, sk: number, ck: number): void {
    const s = this.s;
    const c = this.c;
    for (let i = 0; i < f.length; i++) {
      const v = f[i];
      s[i] += v * sk;
      c[i] += v * ck;
    }
  }

  snapshot(windowed: boolean): void {
    if (windowed) {
      const ts = this.ss;
      this.ss = this.s;
      this.s = ts;
      const tc = this.sc;
      this.sc = this.c;
      this.c = tc;
      this.s.fill(0);
      this.c.fill(0);
    } else {
      this.ss.set(this.s);
      this.sc.set(this.c);
    }
  }
}

// ---------- 入射波の補間（遅延つき波形の参照） ----------

/** 4 点ラグランジュ補間の重み。節点は p1 − 1, p1, p1 + 1, p1 + 2 で、位置は p1 + τ（0 ≤ τ < 1） */
function lagrange4(tau: number, out: Float32Array, o: number): void {
  out[o] = (-tau * (tau - 1) * (tau - 2)) / 6;
  out[o + 1] = ((tau + 1) * (tau - 1) * (tau - 2)) / 2;
  out[o + 2] = (-(tau + 1) * tau * (tau - 2)) / 2;
  out[o + 3] = ((tau + 1) * tau * (tau - 1)) / 6;
}

/**
 * 物体セル（または辺）に当てる入射波の点群。
 * 点ごとの波形は ring[m − ci − 1 … m − ci + 2] の補間（ring は各ステップの波形 f の履歴）。
 */
class IncidentSet {
  readonly count: number;
  readonly idx: Int32Array;
  readonly ci: Int32Array;
  readonly w: Float32Array;
  readonly amp: Float32Array;
  readonly kNew: Float32Array;
  readonly kOld: Float32Array;
  readonly prev: Float32Array;

  /**
   * @param target 値を足す配列
   * @param pec true なら完全導体（散乱場 = −入射場に固定）
   */
  constructor(
    readonly target: Float32Array,
    readonly pec: boolean,
    idx: number[],
    delay: number[],
    amp: number[],
    kNew: number[],
    kOld: number[],
  ) {
    const n = idx.length;
    this.count = n;
    this.idx = Int32Array.from(idx);
    this.ci = new Int32Array(n);
    this.w = new Float32Array(4 * n);
    for (let p = 0; p < n; p++) {
      const ci = Math.ceil(delay[p]);
      this.ci[p] = ci;
      lagrange4(ci - delay[p], this.w, 4 * p);
    }
    this.amp = Float32Array.from(amp);
    this.kNew = Float32Array.from(kNew);
    this.kOld = Float32Array.from(kOld);
    this.prev = new Float32Array(n);
  }

  /** 時刻スロット m の入射波を目標配列へ反映する */
  apply(ring: Float64Array, mask: number, m: number): void {
    const { idx, ci, w, amp, kNew, kOld, prev, target, count } = this;
    if (this.pec) {
      for (let p = 0; p < count; p++) {
        const b = m - ci[p];
        const q = 4 * p;
        const v = amp[p] * (w[q] * ring[(b - 1) & mask] + w[q + 1] * ring[b & mask] + w[q + 2] * ring[(b + 1) & mask] + w[q + 3] * ring[(b + 2) & mask]);
        target[idx[p]] = -v;
      }
      return;
    }
    for (let p = 0; p < count; p++) {
      const b = m - ci[p];
      const q = 4 * p;
      const v = amp[p] * (w[q] * ring[(b - 1) & mask] + w[q + 1] * ring[b & mask] + w[q + 2] * ring[(b + 1) & mask] + w[q + 3] * ring[(b + 2) & mask]);
      target[idx[p]] += kOld[p] * prev[p] - kNew[p] * v;
      prev[p] = v;
    }
  }
}

// ---------- 公開する型 ----------

/** 通常の Solver に、テストや診断に使う情報を足したもの */
export interface EMSolver extends Solver {
  /** FDTD を指定ステップだけ進める（時間予算なし） */
  advance(steps: number): void;
  readonly stepCount: number;
  /** 1ステップの物理時間 [s]（1 周期が整数ステップになるよう調整後） */
  readonly dt: number;
  /** 1 周期のステップ数 */
  readonly stepsPerPeriod: number;
  /** 定常とみなすまでのステップ数（CW）／パルスが通過し終えるまでのステップ数 */
  readonly settleSteps: number;
  /** 1 波長あたりのセル数（最短波長） */
  readonly cellsPerWavelength: number;
  /** 実効のクーラン数 */
  readonly courant: number;
}

interface LineCells {
  cells: Int32Array;
}

// ---------- ソルバー本体 ----------

/**
 * 電磁波ソルバー。
 *
 * 透過率・反射率（平面波のみ）の定義:
 * - 入射波の電力 = 1（振幅 1 V/m の平面波、媒質中の電場振幅で比較）。
 * - 透過率 = 物体の後ろ（物体の後端から媒質中の半波長、進行方向に垂直な線。物体がなければ領域の 80% の位置。
 *   PML の内側で、線の長さは物体の横幅と領域の弦の両方の中央 60%）での
 *   全電場の電力（振幅²）の平均 ÷ 入射波の同じ量（= 1）。基準計算（物体なし）の同じ量に相当する。
 * - 反射率 = 物体の前（物体の前端から半波長、なければ 15% の位置の線）での散乱波（全体 − 入射波）の電力の平均 ÷ 入射波の電力。
 *   斜め入射では反射波が測定線の一部にしか当たらないため、反射率は小さめに出る（下限の目安）。
 * 1 周期ごとに更新し、履歴にも残す。
 */
class EMSolverImpl implements EMSolver {
  readonly analysis = 'em' as const;

  private readonly nx: number;
  private readonly ny: number;
  private readonly n: number;
  private readonly h: number;
  private readonly te: boolean;
  private readonly plane: boolean;
  private readonly pulse: boolean;

  readonly dt: number;
  readonly stepsPerPeriod: number;
  readonly courant: number;
  readonly cellsPerWavelength: number;
  settleSteps = 0;
  stepCount = 0;

  private readonly freq: number;
  private readonly omega: number;
  private readonly period: number;
  private readonly nBg: number;
  private readonly lambdaBg: number;
  /** F → 表示する電場への換算（TE は F = η0·Hz なので n 倍になっている） */
  private readonly fScale: number;
  private readonly pecMask: Uint8Array;
  private readonly warnings: string[] = [];

  private readonly main: Yee;
  private ref: Yee | null = null;
  private readonly accMain: Phasor;
  private accRef: Phasor | null = null;
  private readonly sinTab: Float64Array;
  private readonly cosTab: Float64Array;
  /** 物体が無い平面波では散乱波が恒等的に 0 なので計算を省く */
  private readonly quiet: boolean;

  // 波形
  private readonly pulseTau: number;
  private readonly pulseT0: number;
  /** 波形 f(t) の sin/cos 積算（入射波の位相基準） */
  private wavS = 0;
  private wavC = 0;
  private readonly norm: number;

  // 平面波
  private ring: Float64Array = new Float64Array(1);
  private ringMask = 0;
  private readonly theta: number; // 時刻スロットの位置オフセット（TE の電場は半ステップ）
  private sets: IncidentSet[] = [];
  private fCi: Int32Array = new Int32Array(0);
  private fW: Float32Array = new Float32Array(0);
  private cosPhi: Float32Array = new Float32Array(0);
  private sinPhi: Float32Array = new Float32Array(0);
  private lineT: LineCells = { cells: new Int32Array(0) };
  private lineR: LineCells = { cells: new Int32Array(0) };

  // 点波源
  private srcIdx = 0;
  private srcAmp = 0;
  private refIdx = 0;
  private calib = 1;

  // 結果
  private tPct = 100;
  private rPct = 0;
  private lastDelta: number | undefined;
  private histStride = 1;
  private snapCount = 0;
  private snapId = 0;
  private builtSnapId = -1;
  private unstable = false;
  private histT: number[] = [];
  private histTx: number[] = [];
  private histRf: number[] = [];
  private readonly fField: Field;
  private readonly fAmp: Field;
  private readonly fScat: Field;
  private readonly fInt: Field;
  private readonly incInst: Float32Array;

  constructor(project: Project, raster: Raster) {
    const em = project.em;
    const adv = em.advanced ?? {};
    const { nx, ny, h } = raster;
    const n = nx * ny;
    this.nx = nx;
    this.ny = ny;
    this.n = n;
    this.h = h;
    this.te = em.polarization === 'TE';
    this.plane = em.source === 'plane';
    this.pulse = adv.waveform === 'pulse';
    this.freq = em.frequencyGHz * 1e9;
    this.omega = 2 * Math.PI * this.freq;
    this.period = 1 / this.freq;
    this.theta = this.te ? 0.5 : 0;

    // ---- 材料 ----
    const bg = getMaterial(em.mediumId);
    const epsB = bg.conductor ? 1 : (bg.epsR ?? 1);
    if (bg.conductor) this.warnings.push('背景の媒質に金属は選べないため、空気として扱います。');
    if ((bg.tanD ?? 0) > 0 && !bg.conductor) {
      this.warnings.push('背景の媒質の損失は無視しています（入射波は減衰せずに伝わります）。');
    }
    this.nBg = Math.sqrt(epsB);
    this.lambdaBg = C0 / this.freq / this.nBg;
    this.fScale = this.te ? this.nBg : 1;

    const mat: CellMaterials = { eps: new Float32Array(n).fill(epsB), sig: new Float32Array(n), pec: new Uint8Array(n) };
    const cache = new Map<string, { eps: number; sig: number; pec: boolean }>();
    let nMax = this.nBg;
    let anyConductor = false;
    let hasObjects = false;
    let sMinI = nx;
    let sMaxI = -1;
    let sMinJ = ny;
    let sMaxJ = -1;
    for (let c = 0; c < n; c++) {
      if (!raster.solid[c]) continue;
      const id = raster.materialId[c];
      if (id == null) continue;
      let m = cache.get(id);
      if (!m) {
        const mt = getMaterial(id);
        const eps = mt.epsR ?? 1;
        m = { eps, sig: 2 * Math.PI * this.freq * EPS0 * eps * (mt.tanD ?? 0), pec: mt.conductor === true };
        cache.set(id, m);
      }
      if (m.pec) {
        mat.pec[c] = 1;
        anyConductor = true;
      } else {
        mat.eps[c] = m.eps;
        mat.sig[c] = m.sig;
        nMax = Math.max(nMax, Math.sqrt(m.eps));
      }
      if (m.pec || Math.abs(m.eps - epsB) > 1e-5 || m.sig > 0) hasObjects = true;
      const i = c % nx;
      const j = (c - i) / nx;
      sMinI = Math.min(sMinI, i);
      sMaxI = Math.max(sMaxI, i);
      sMinJ = Math.min(sMinJ, j);
      sMaxJ = Math.max(sMaxJ, j);
    }
    this.pecMask = mat.pec;

    // ---- 解像度 ----
    const lambda0 = C0 / this.freq;
    const lambdaMin = lambda0 / nMax;
    this.cellsPerWavelength = lambdaMin / h;
    if (this.cellsPerWavelength < 10) {
      this.warnings.push(
        `格子が粗いため結果の精度が落ちます（媒質中の最短波長 ${(lambdaMin * 1e3).toFixed(2)} mm に対して 1 波長あたり ${this.cellsPerWavelength.toFixed(1)} セル。10 セル以上を推奨）。格子を細かくしてください。`,
      );
    }

    // ---- 時間刻み ----
    let courant = adv.courant ?? 0.5;
    if (!(courant > 0)) courant = 0.5;
    if (courant > COURANT_MAX) {
      this.warnings.push(`クーラン数が 2D の安定限界（1/√2 ≈ 0.707）に近すぎるため ${COURANT_MAX} に下げました。`);
      courant = COURANT_MAX;
    }
    const dt0 = (courant * h) / C0;
    this.stepsPerPeriod = Math.max(4, Math.ceil(this.period / dt0));
    this.dt = this.period / this.stepsPerPeriod;
    const sc = (C0 * this.dt) / h;
    this.courant = sc;
    const wdt = this.omega * this.dt;
    const nper = this.stepsPerPeriod;
    this.sinTab = new Float64Array(nper);
    this.cosTab = new Float64Array(nper);
    for (let k = 0; k < nper; k++) {
      this.sinTab[k] = Math.sin((2 * Math.PI * k) / nper);
      this.cosTab[k] = Math.cos((2 * Math.PI * k) / nper);
    }

    // ---- PML ----
    let np = Math.max(0, Math.round(adv.pmlCells ?? 12));
    const npMax = Math.max(0, Math.floor((Math.min(nx, ny) - 4) / 2));
    if (np > npMax) {
      this.warnings.push(`解析領域に対して吸収境界（PML）が厚すぎるため ${npMax} セルに減らしました。`);
      np = npMax;
    }
    const pml = buildPml(nx, ny, np, sc, this.nBg, h);
    let inPml = false;
    for (let c = 0; c < n && !inPml; c++) {
      if (!raster.solid[c]) continue;
      const i = c % nx;
      const j = (c - i) / nx;
      if (i < np || i >= nx - np || j < np || j >= ny - np) inPml = true;
    }
    if (inPml) {
      this.warnings.push(
        `形状が吸収境界（PML、領域の外周 ${np} セル）にかかっています。PML の中は電波が吸収されるため、物体は領域の内側に置いてください。`,
      );
    }
    if (anyConductor) this.warnings.push('金属は完全導体として扱います（表皮効果や金属の損失は考えません）。');
    this.warnings.push('2D の結果は奥行き方向に無限に長い物体（断面）の傾向を表します。実物の有限の大きさや縁の回折とは一致しません。');

    // ---- 波形 ----
    this.pulseTau = 2 * this.period;
    this.pulseT0 = 3 * this.pulseTau;
    let s0 = 0;
    let c0 = 0;
    if (this.pulse) {
      const tEnd = this.pulseT0 + 4 * this.pulseTau;
      for (let k = 0; k * this.dt <= tEnd; k++) {
        const f = this.waveAt(k * this.dt);
        s0 += f * Math.sin(this.omega * k * this.dt);
        c0 += f * Math.cos(this.omega * k * this.dt);
      }
    } else {
      s0 = nper / 2;
    }
    this.wavS = s0;
    this.wavC = c0;
    this.norm = Math.hypot(s0, c0);

    // ---- 計算の準備 ----
    this.accMain = new Phasor(n);
    this.incInst = new Float32Array(n);
    const coMain = buildCoeffs(this.te, nx, ny, mat, this.dt, sc);
    this.main = new Yee(nx, ny, np, coMain, pml, this.te, sc);

    // 領域の対角を波が渡る時間と、物体の中を通る時間の見積もり
    const diag = Math.hypot(nx, ny);
    let crossSteps = (diag * this.nBg) / sc;
    if (sMaxI >= 0) crossSteps += (2 * Math.hypot(sMaxI - sMinI + 1, sMaxJ - sMinJ + 1) * nMax) / sc;

    let quiet = false;
    if (this.plane) {
      const theta = (em.angleDeg * Math.PI) / 180;
      const cs = Math.cos(theta);
      const sn = Math.sin(theta);
      const kappa = numericalWavenumber(wdt, sc, this.nBg, theta);
      const xUp = cs >= 0 ? 0 : nx;
      const yUp = sn >= 0 ? 0 : ny;
      const delayAt = (x: number, y: number) => (kappa * ((x - xUp) * cs + (y - yUp) * sn)) / wdt;
      const maxDelay = delayAt(cs >= 0 ? nx : 0, sn >= 0 ? ny : 0);
      const size = 1 << Math.ceil(Math.log2(Math.ceil(maxDelay) + 12));
      this.ring = new Float64Array(size);
      this.ringMask = size - 1;

      // TE の電場成分の向き: G = (sy, −sx)/s（sx, sy は離散化した波数成分の sin）
      const sx = Math.sin((kappa * cs) / 2);
      const sy = Math.sin((kappa * sn) / 2);
      const sAbs = Math.hypot(sx, sy);
      const ampX = this.te ? sy / sAbs : 1;
      const ampY = this.te ? -sx / sAbs : 0;

      // 物体の点群（比誘電率・損失が背景と違うセル／辺、完全導体）
      const makeSet = (target: Float32Array, pec: boolean, list: { idx: number[]; d: number[]; amp: number[]; kn: number[]; ko: number[] }) =>
        new IncidentSet(target, pec, list.idx, list.d, list.amp, list.kn, list.ko);
      const newList = () => ({ idx: [] as number[], d: [] as number[], amp: [] as number[], kn: [] as number[], ko: [] as number[] });
      const addPoint = (l: ReturnType<typeof newList>, c: number, x: number, y: number, amp: number, eps: number, sig: number) => {
        const alpha = (sig * this.dt) / (2 * EPS0 * eps);
        const kd = (eps - epsB) / (eps * (1 + alpha));
        const ks = alpha / (1 + alpha);
        l.idx.push(c);
        l.d.push(delayAt(x, y) + 2);
        l.amp.push(amp);
        l.kn.push(kd + ks);
        l.ko.push(kd - ks);
      };
      const differs = (eps: number, sig: number) => Math.abs(eps - epsB) > 1e-5 || sig > 0;

      if (!this.te) {
        const lc = newList();
        const lp = newList();
        for (let j = 1; j <= ny - 2; j++) {
          for (let i = 1; i <= nx - 2; i++) {
            const c = j * nx + i;
            if (mat.pec[c]) addPoint(lp, c, i + 0.5, j + 0.5, 1, 1, 0);
            else if (differs(mat.eps[c], mat.sig[c])) addPoint(lc, c, i + 0.5, j + 0.5, 1, mat.eps[c], mat.sig[c]);
          }
        }
        if (lc.idx.length) this.sets.push(makeSet(this.main.F, false, lc));
        if (lp.idx.length) this.sets.push(makeSet(this.main.F, true, lp));
      } else {
        const gxC = newList();
        const gxP = newList();
        const gyC = newList();
        const gyP = newList();
        for (let j = 0; j <= ny - 2; j++) {
          for (let i = 1; i <= nx - 2; i++) {
            const c = j * nx + i;
            const c2 = c + nx;
            if (mat.pec[c] || mat.pec[c2]) addPoint(gxP, c, i + 0.5, j + 1, ampX, 1, 0);
            else {
              const eps = 0.5 * (mat.eps[c] + mat.eps[c2]);
              const sig = 0.5 * (mat.sig[c] + mat.sig[c2]);
              if (differs(eps, sig)) addPoint(gxC, c, i + 0.5, j + 1, ampX, eps, sig);
            }
          }
        }
        for (let j = 1; j <= ny - 2; j++) {
          for (let i = 0; i <= nx - 2; i++) {
            const c = j * nx + i;
            const c2 = c + 1;
            if (mat.pec[c] || mat.pec[c2]) addPoint(gyP, c, i + 1, j + 0.5, ampY, 1, 0);
            else {
              const eps = 0.5 * (mat.eps[c] + mat.eps[c2]);
              const sig = 0.5 * (mat.sig[c] + mat.sig[c2]);
              if (differs(eps, sig)) addPoint(gyC, c, i + 1, j + 0.5, ampY, eps, sig);
            }
          }
        }
        if (gxC.idx.length) this.sets.push(makeSet(this.main.Gx, false, gxC));
        if (gxP.idx.length) this.sets.push(makeSet(this.main.Gx, true, gxP));
        if (gyC.idx.length) this.sets.push(makeSet(this.main.Gy, false, gyC));
        if (gyP.idx.length) this.sets.push(makeSet(this.main.Gy, true, gyP));
      }
      quiet = this.sets.length === 0;

      // 全セルの入射波（表示・振幅用）。F の時刻は TE では電場より半ステップ進んでいる
      this.fCi = new Int32Array(n);
      this.fW = new Float32Array(4 * n);
      this.cosPhi = new Float32Array(n);
      this.sinPhi = new Float32Array(n);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const c = j * nx + i;
          const d = delayAt(i + 0.5, j + 0.5);
          const dTot = d + (this.te ? 1.5 : 2);
          const ci = Math.ceil(dTot);
          this.fCi[c] = ci;
          lagrange4(ci - dTot, this.fW, 4 * c);
          const phi = wdt * (d + 2);
          this.cosPhi[c] = Math.cos(phi);
          this.sinPhi[c] = Math.sin(phi);
        }
      }

      // 測定線
      const lines = this.buildLines(np, cs, sn, raster.solid);
      this.lineR = lines.front;
      this.lineT = lines.back;
    } else {
      // 点波源。物体があれば物体なしの基準計算を同時に走らせる
      const si = Math.min(nx - 2, Math.max(1, Math.floor(em.pointX / h)));
      const sj = Math.min(ny - 2, Math.max(1, Math.floor(em.pointY / h)));
      this.srcIdx = sj * nx + si;
      if (si < np || si >= nx - np || sj < np || sj >= ny - np) {
        this.warnings.push('点波源が吸収境界（PML）の中にあります。波源は領域の内側に置いてください。');
      }
      // 観測点: 波源から最も広く空いている向きへ、3 波長（収まらなければ手前）
      const room = [
        { dx: 1, dy: 0, d: nx - np - 1 - si },
        { dx: -1, dy: 0, d: si - np },
        { dx: 0, dy: 1, d: ny - np - 1 - sj },
        { dx: 0, dy: -1, d: sj - np },
      ].sort((a, b) => b.d - a.d)[0];
      const rCells = Math.max(3, Math.min((3 * this.lambdaBg) / h, 0.8 * Math.max(room.d, 0)));
      const r = Math.round(rCells);
      this.refIdx = Math.min(nx - 2, Math.max(1, si + room.dx * r)) + Math.min(ny - 2, Math.max(1, sj + room.dy * r)) * nx;
      // 自由空間でその点の振幅がおよそ 1 になる強さ（2D 線電流の遠方解）。実測で校正する
      const k = (2 * Math.PI * this.nBg) / lambda0;
      const k0h = (2 * Math.PI * h) / lambda0;
      this.srcAmp = (4 * sc) / (k0h * (this.te ? 1 : epsB)) / Math.sqrt(2 / (Math.PI * k * r * h));
      if (hasObjects) {
        const refMat: CellMaterials = { eps: new Float32Array(n).fill(epsB), sig: new Float32Array(n), pec: new Uint8Array(n) };
        this.ref = new Yee(nx, ny, np, buildCoeffs(this.te, nx, ny, refMat, this.dt, sc), pml, this.te, sc);
        this.accRef = new Phasor(n);
      }
      quiet = false;
    }
    this.quiet = quiet;

    // ---- 終了・定常の目安 ----
    const lead = this.pulse ? this.pulseT0 / this.dt + 4 * (this.pulseTau / this.dt) : (RAMP_PERIODS + 5) * nper;
    this.settleSteps = Math.ceil(crossSteps + lead);

    // ---- 出力バッファ ----
    const mask = new Uint8Array(n);
    for (let c = 0; c < n; c++) mask[c] = this.pecMask[c] ? 0 : 1;
    const mk = (key: string, label: string, unit: string, diverging?: boolean): Field => ({
      key,
      label,
      unit,
      data: new Float32Array(n),
      mask,
      ...(diverging ? { diverging: true } : {}),
    });
    this.fField = mk('field', this.te ? '瞬時の電場（Hz を η0 倍して電場の単位に換算）' : '瞬時の電場 Ez', 'V/m', true);
    this.fAmp = mk('amplitude', '電場の振幅', 'V/m');
    this.fScat = mk('scattered', '散乱波の振幅', 'V/m');
    this.fInt = mk('intensity', '電力密度（相対）', 'dB');
  }

  // ---------- 波形 ----------

  /** 入射波の波形 f(t)。CW は立ち上げ付きの sin、パルスはガウス包絡の sin */
  private waveAt(t: number): number {
    if (this.pulse) {
      const u = (t - this.pulseT0) / this.pulseTau;
      return Math.exp(-u * u) * Math.sin(this.omega * (t - this.pulseT0));
    }
    if (t <= 0) return 0;
    const ramp = RAMP_PERIODS * this.period;
    const r = t >= ramp ? 1 : 0.5 * (1 - Math.cos((Math.PI * t) / ramp));
    return r * Math.sin(this.omega * t);
  }

  // ---------- 測定線 ----------

  /**
   * 進行方向（cs, sn）に垂直な測定線（前: 反射、後ろ: 透過）。PML の内側の長方形の中に置く。
   *
   * 物体があるときは、物体のすぐ近く（進行方向の前後端から媒質中の 1 波長）に置き、線の長さは
   * 「内側の長方形を横切る弦」と「物体の横幅」の両方の中央 60% に収める。
   * 有限の大きさの板は縁で回折するので、遠くで測ると縁からの干渉縞（フレネル回折）が混ざって
   * 透過率が 100% を超えたりする。物体のすぐ後ろ（半波長）の中央付近なら、板の中央の 1 次元に近い値が取れる。
   * 物体がなければ（または近くに置けなければ）領域の進行方向 15% と 80% の位置、弦の中央 60%。
   */
  private buildLines(np: number, cs: number, sn: number, solid: Uint8Array): { front: LineCells; back: LineCells } {
    const { nx, ny } = this;
    const x0 = np;
    const x1 = nx - np;
    const y0 = np;
    const y1 = ny - np;
    const xc = 0.5 * (x0 + x1);
    const yc = 0.5 * (y0 + y1);
    const pHalf = 0.5 * ((x1 - x0) * Math.abs(cs) + (y1 - y0) * Math.abs(sn));
    const tx = -sn;
    const ty = cs;

    // 物体の進行方向・横方向の広がり（セル中心の射影）
    let pMin = Infinity;
    let pMax = -Infinity;
    let sMin = Infinity;
    let sMax = -Infinity;
    for (let c = 0; c < solid.length; c++) {
      if (!solid[c]) continue;
      const i = c % nx;
      const dx = i + 0.5 - xc;
      const dy = (c - i) / nx + 0.5 - yc;
      const p = dx * cs + dy * sn;
      const q = dx * tx + dy * ty;
      if (p < pMin) pMin = p;
      if (p > pMax) pMax = p;
      if (q < sMin) sMin = q;
      if (q > sMax) sMax = q;
    }
    const hasObj = pMax >= pMin;

    // 線の位置
    let pFront = -pHalf + 2 * pHalf * 0.15;
    let pBack = -pHalf + 2 * pHalf * 0.8;
    if (hasObj) {
      const gap = Math.max((0.5 * this.lambdaBg) / this.h, 4);
      const f = Math.max(pMin - 0.5 - gap, -pHalf + 2);
      const b = Math.min(pMax + 0.5 + gap, pHalf - 2);
      if (f < pMin - 1) pFront = f;
      if (b > pMax + 1) pBack = b;
    }

    const make = (p: number): LineCells => {
      const bx = xc + p * cs;
      const by = yc + p * sn;
      let lo = -Infinity;
      let hi = Infinity;
      const clip = (b: number, t: number, a0: number, a1: number) => {
        if (Math.abs(t) < 1e-9) {
          if (b < a0 || b > a1) {
            lo = Infinity;
            hi = -Infinity;
          }
          return;
        }
        const s0 = (a0 - b) / t;
        const s1 = (a1 - b) / t;
        lo = Math.max(lo, Math.min(s0, s1));
        hi = Math.min(hi, Math.max(s0, s1));
      };
      clip(bx, tx, x0, x1);
      clip(by, ty, y0, y1);
      if (!(hi > lo)) return { cells: new Int32Array(0) };
      const len = hi - lo;
      let a = lo + 0.2 * len;
      let z = hi - 0.2 * len;
      if (hasObj) {
        const olen = sMax - sMin + 1;
        const oa = sMin - 0.5 + 0.2 * olen;
        const oz = sMax + 0.5 - 0.2 * olen;
        if (Math.max(a, oa) < Math.min(z, oz)) {
          a = Math.max(a, oa);
          z = Math.min(z, oz);
        }
      }
      const set = new Set<number>();
      for (let q = a; q <= z + 1e-9; q += 0.5) {
        const i = Math.min(nx - 1, Math.max(0, Math.floor(bx + q * tx)));
        const j = Math.min(ny - 1, Math.max(0, Math.floor(by + q * ty)));
        set.add(j * nx + i);
      }
      return { cells: Int32Array.from(set) };
    };
    return { front: make(pFront), back: make(pBack) };
  }

  // ---------- 時間発展 ----------

  advance(steps: number): void {
    for (let s = 0; s < steps && !this.unstable; s++) this.stepOnce();
  }

  private stepOnce(): void {
    const n0 = this.stepCount;
    if (this.plane) {
      // TM は電場が整数ステップ、TE は電場が半ステップの時刻にある
      const m = this.te ? n0 : n0 + 1;
      this.ring[m & this.ringMask] = this.waveAt((m + this.theta) * this.dt);
      if (!this.quiet) {
        this.main.updateG();
        if (this.te) for (const s of this.sets) s.apply(this.ring, this.ringMask, m);
        this.main.updateF();
        if (!this.te) for (const s of this.sets) s.apply(this.ring, this.ringMask, m);
      }
    } else {
      const src = this.srcAmp * this.waveAt((n0 + 1) * this.dt);
      this.main.updateG();
      this.main.updateF();
      this.main.F[this.srcIdx] += src;
      if (this.ref) {
        this.ref.updateG();
        this.ref.updateF();
        this.ref.F[this.srcIdx] += src;
      }
    }
    this.stepCount = n0 + 1;
    const k = this.stepCount % this.stepsPerPeriod;
    if (!this.quiet) {
      this.accMain.accumulate(this.main.F, this.sinTab[k], this.cosTab[k]);
      if (this.accRef && this.ref) this.accRef.accumulate(this.ref.F, this.sinTab[k], this.cosTab[k]);
    }
    if (k === 0) this.snapshot();
  }

  /** 1 周期ごとの処理: 積算の確定、透過率・反射率、校正、発散チェック */
  private snapshot(): void {
    const windowed = !this.pulse;
    if (!this.quiet) {
      this.accMain.snapshot(windowed);
      this.accRef?.snapshot(windowed);
    }
    this.snapId++;
    this.snapCount++;

    // 発散チェック（NaN は一気に広がるので数点で十分）
    const F = this.main.F;
    const probe = F[this.n >> 1] + F[this.n >> 2] + F[(3 * this.n) >> 2] + F[this.srcIdx];
    if (!Number.isFinite(probe)) {
      this.unstable = true;
      this.warnings.push('計算が発散しました。クーラン数を小さくするか、格子を細かくしてください。');
      return;
    }

    if (this.plane) {
      this.measureLines();
    } else if (this.stepCount >= this.settleSteps) {
      // 点波源: 定常に達したら、基準計算（なければ全体）の観測点の振幅で校正する
      const acc = this.accRef ?? this.accMain;
      const a = Math.hypot(acc.ss[this.refIdx], acc.sc[this.refIdx]) / this.norm;
      if (a > 1e-12) this.calib = a;
    }
  }

  /** 測定線での透過率・反射率（平面波）。入射波の電力は 1 */
  private measureLines(): void {
    const { ss, sc } = this.accMain;
    const inv = 1 / (this.norm * this.fScale);
    const ns = this.wavS / this.norm;
    const nc = this.wavC / this.norm;
    let tSum = 0;
    const lt = this.lineT.cells;
    for (let q = 0; q < lt.length; q++) {
      const c = lt[q];
      const cp = this.cosPhi[c];
      const sp = this.sinPhi[c];
      const a = ss[c] * inv + ns * cp + nc * sp;
      const b = sc[c] * inv + nc * cp - ns * sp;
      tSum += a * a + b * b;
    }
    let rSum = 0;
    const lr = this.lineR.cells;
    for (let q = 0; q < lr.length; q++) {
      const c = lr[q];
      const a = ss[c] * inv;
      const b = sc[c] * inv;
      rSum += a * a + b * b;
    }
    const tNew = lt.length ? (100 * tSum) / lt.length : 100;
    const rNew = lr.length ? (100 * rSum) / lr.length : 0;
    this.lastDelta = Math.abs(tNew - this.tPct) / 100;
    this.tPct = tNew;
    this.rPct = rNew;
    if (this.snapCount % this.histStride === 0) {
      this.histT.push(this.stepCount * this.dt * 1e9);
      this.histTx.push(tNew);
      this.histRf.push(rNew);
      if (this.histT.length > HISTORY_MAX) {
        const half = (arr: number[]) => arr.filter((_, i) => i % 2 === 0);
        this.histT = half(this.histT);
        this.histTx = half(this.histTx);
        this.histRf = half(this.histRf);
        this.histStride *= 2;
      }
    }
  }

  // ---------- Solver ----------

  step(budgetMs: number): SolverStatus {
    const t0 = performance.now();
    const finished = () => this.unstable || (this.pulse && this.stepCount >= this.settleSteps);
    while (!finished()) {
      for (let s = 0; s < CHUNK && !finished(); s++) this.stepOnce();
      if (performance.now() - t0 >= budgetMs) break;
    }
    return this.status();
  }

  private status(): SolverStatus {
    const progress = Math.min(1, this.stepCount / Math.max(1, this.settleSteps));
    const reached = this.stepCount >= this.settleSteps;
    let message: string;
    if (this.unstable) message = '計算が発散しました';
    else if (this.pulse) message = reached ? 'パルスが領域を通過しました' : 'パルスが領域を伝わっています';
    else message = reached ? '定常に達しました' : '波が領域に広がっています';
    return {
      done: this.pulse && reached && !this.unstable,
      progress,
      iteration: this.stepCount,
      residual: this.plane ? this.lastDelta : undefined,
      message,
    };
  }

  result(): ResultSet {
    const n = this.n;
    const pec = this.pecMask;
    const fld = this.fField.data;
    const F = this.main.F;

    // ---- 瞬時の電場 ----
    if (this.plane) {
      const inc = this.incInst;
      const ring = this.ring;
      const mask = this.ringMask;
      const m = this.te ? this.stepCount - 1 : this.stepCount;
      const { fCi, fW } = this;
      for (let c = 0; c < n; c++) {
        const b = m - fCi[c];
        const q = 4 * c;
        inc[c] = fW[q] * ring[(b - 1) & mask] + fW[q + 1] * ring[b & mask] + fW[q + 2] * ring[(b + 1) & mask] + fW[q + 3] * ring[(b + 2) & mask];
      }
      const inv = 1 / this.fScale;
      for (let c = 0; c < n; c++) fld[c] = pec[c] ? 0 : F[c] * inv + inc[c];
    } else {
      const inv = 1 / (this.fScale * this.calib);
      for (let c = 0; c < n; c++) fld[c] = pec[c] ? 0 : F[c] * inv;
    }

    // ---- 振幅（直近の 1 周期／積算から） ----
    if (this.builtSnapId !== this.snapId) {
      this.buildAmplitudes();
      this.builtSnapId = this.snapId;
    }

    const lambdaMm = this.lambdaBg * 1e3;
    const scalars: ScalarValue[] = [
      { key: 'frequency', label: '周波数', unit: 'GHz', value: this.freq / 1e9 },
      { key: 'wavelength', label: '波長（媒質中）', unit: 'mm', value: lambdaMm },
      { key: 'cellsPerWavelength', label: '1波長あたりのセル数', unit: '個', value: this.cellsPerWavelength },
    ];
    const history: History[] = [];
    if (this.plane) {
      scalars.push({ key: 'transmission', label: '透過率', unit: '%', value: this.tPct });
      scalars.push({ key: 'reflection', label: '反射率', unit: '%', value: this.rPct });
      history.push({ key: 'transmission', label: '透過率', unit: '%', t: this.histT.slice(), values: this.histTx.slice() });
      history.push({ key: 'reflection', label: '反射率', unit: '%', t: this.histT.slice(), values: this.histRf.slice() });
    }
    scalars.push({ key: 'time', label: '経過時間', unit: 'ns', value: this.stepCount * this.dt * 1e9 });

    return {
      analysis: 'em',
      nx: this.nx,
      ny: this.ny,
      h: this.h,
      fields: [this.fField, this.fAmp, this.fScat, this.fInt],
      scalars,
      history,
      warnings: this.warnings.slice(),
    };
  }

  /** 積算した複素振幅から、全体の振幅・散乱波の振幅・強度(dB) を作る */
  private buildAmplitudes(): void {
    const n = this.n;
    const amp = this.fAmp.data;
    const scat = this.fScat.data;
    const db = this.fInt.data;
    const pec = this.pecMask;
    const { ss, sc } = this.accMain;
    if (this.plane) {
      const inv = 1 / (this.norm * this.fScale);
      const ns = this.wavS / this.norm;
      const nc = this.wavC / this.norm;
      for (let c = 0; c < n; c++) {
        const es = ss[c] * inv;
        const ec = sc[c] * inv;
        const cp = this.cosPhi[c];
        const sp = this.sinPhi[c];
        const a = es + ns * cp + nc * sp;
        const b = ec + nc * cp - ns * sp;
        amp[c] = pec[c] ? 0 : Math.sqrt(a * a + b * b);
        scat[c] = pec[c] ? 0 : Math.sqrt(es * es + ec * ec);
      }
    } else {
      const inv = 1 / (this.norm * this.calib * this.fScale);
      const rs = this.accRef?.ss;
      const rc = this.accRef?.sc;
      for (let c = 0; c < n; c++) {
        const a = ss[c] * inv;
        const b = sc[c] * inv;
        amp[c] = pec[c] ? 0 : Math.sqrt(a * a + b * b);
        if (rs && rc) {
          const da = (ss[c] - rs[c]) * inv;
          const db2 = (sc[c] - rc[c]) * inv;
          scat[c] = pec[c] ? 0 : Math.sqrt(da * da + db2 * db2);
        } else {
          scat[c] = 0;
        }
      }
    }
    const floor = 10 ** (INTENSITY_FLOOR_DB / 20);
    for (let c = 0; c < n; c++) db[c] = 20 * Math.log10(Math.max(amp[c], floor));
  }
}

/** 電磁波（2D FDTD）ソルバーを作る */
export const createEMSolver: SolverFactory = (project, raster) => new EMSolverImpl(project, raster);
