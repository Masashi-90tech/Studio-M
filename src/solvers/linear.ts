// 熱・スカラー解析で共有する、5点ステンシルの連立一次方程式と反復解法。
//
// 各未知セル P について（Patankar の離散化方程式の形）
//     aP·x_P = aE·x_E + aW·x_W + aN·x_N + aS·x_S + b
// を解く。インデックスは Raster と同じ j * nx + i（j は上向き）。
// 隣が未知セルでない（領域外・固定値・物体など）場合、その係数は 0 にして、
// 寄与は aP と b に畳み込んでおくこと（配列の範囲外を読まないための約束）。

export interface Stencil5 {
  nx: number;
  ny: number;
  /** 1 = 未知セル。0 のセルは解かない（係数も 0 にしておく） */
  active: Uint8Array;
  aP: Float64Array;
  aE: Float64Array;
  aW: Float64Array;
  aN: Float64Array;
  aS: Float64Array;
  b: Float64Array;
}

export function createStencil(nx: number, ny: number): Stencil5 {
  const n = nx * ny;
  return {
    nx,
    ny,
    active: new Uint8Array(n),
    aP: new Float64Array(n),
    aE: new Float64Array(n),
    aW: new Float64Array(n),
    aN: new Float64Array(n),
    aS: new Float64Array(n),
    b: new Float64Array(n),
  };
}

/** 1セルぶんの残差  b + Σ a_nb·x_nb − aP·x_P */
function cellResidual(s: Stencil5, x: Float64Array, c: number): number {
  const nx = s.nx;
  let r = s.b[c] - s.aP[c] * x[c];
  if (s.aE[c] !== 0) r += s.aE[c] * x[c + 1];
  if (s.aW[c] !== 0) r += s.aW[c] * x[c - 1];
  if (s.aN[c] !== 0) r += s.aN[c] * x[c + nx];
  if (s.aS[c] !== 0) r += s.aS[c] * x[c - nx];
  return r;
}

/** 残差の絶対値の総和（L1 ノルム） */
export function residualL1(s: Stencil5, x: Float64Array): number {
  let sum = 0;
  for (let c = 0; c < s.active.length; c++) {
    if (s.active[c]) sum += Math.abs(cellResidual(s, x, c));
  }
  return sum;
}

/**
 * SOR（辞書式 Gauss–Seidel + 過緩和）を1回掃引する。x を直接更新し、最大の更新量を返す。
 * 掃引は j 昇順・i 昇順なので、+x 向きの流れ（上流が西側）で特に収束が速い。
 */
export function sorSweep(s: Stencil5, x: Float64Array, omega: number): number {
  const { nx, ny, active, aP, aE, aW, aN, aS, b } = s;
  let maxDelta = 0;
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const c = row + i;
      if (!active[c] || aP[c] <= 0) continue;
      let sum = b[c];
      if (aE[c] !== 0) sum += aE[c] * x[c + 1];
      if (aW[c] !== 0) sum += aW[c] * x[c - 1];
      if (aN[c] !== 0) sum += aN[c] * x[c + nx];
      if (aS[c] !== 0) sum += aS[c] * x[c - nx];
      const delta = omega * (sum / aP[c] - x[c]);
      x[c] += delta;
      const d = Math.abs(delta);
      if (d > maxDelta) maxDelta = d;
    }
  }
  return maxDelta;
}

/**
 * 前処理付き共役勾配法（係数行列が対称正定値のとき用: 熱伝導）。
 * 前処理は対称 Gauss–Seidel（SSOR, ω = 1）。条件数の悪い（材料の熱伝導率差が大きい）問題でも安定して収束する。
 * 方程式は  aP·x_P − Σ a_nb·x_nb = b  と読み替え、aE(P) = aW(P の東隣) が成り立つこと。
 */
export class PcgSolver {
  /** 現在の解（初期値は x0 のコピー） */
  readonly x: Float64Array;
  /** 残差ベクトルの L2 ノルム */
  rNorm = 0;
  /** 右辺ベクトルの L2 ノルム（相対残差の基準） */
  readonly bNorm: number;

  private readonly s: Stencil5;
  private readonly r: Float64Array;
  private readonly z: Float64Array;
  private readonly p: Float64Array;
  private readonly q: Float64Array;
  private rz = 0;

  constructor(s: Stencil5, x0: Float64Array) {
    this.s = s;
    const n = s.active.length;
    this.x = Float64Array.from(x0);
    this.r = new Float64Array(n);
    this.z = new Float64Array(n);
    this.p = new Float64Array(n);
    this.q = new Float64Array(n);

    let bb = 0;
    let rr = 0;
    for (let c = 0; c < n; c++) {
      if (!s.active[c]) continue;
      bb += s.b[c] * s.b[c];
      this.r[c] = cellResidual(s, this.x, c);
      rr += this.r[c] * this.r[c];
    }
    this.bNorm = Math.sqrt(bb);
    this.rNorm = Math.sqrt(rr);
    this.precondition();
    this.p.set(this.z);
    this.rz = this.dot(this.r, this.z);
  }

  /** 相対残差 ‖r‖ / ‖b‖ */
  get relResidual(): number {
    return this.bNorm > 0 ? this.rNorm / this.bNorm : 0;
  }

  /** CG を1反復進める */
  iterate(): void {
    const { s, x, r, p, q } = this;
    const nx = s.nx;
    const n = s.active.length;
    // q = A·p
    for (let c = 0; c < n; c++) {
      if (!s.active[c]) continue;
      let v = s.aP[c] * p[c];
      if (s.aE[c] !== 0) v -= s.aE[c] * p[c + 1];
      if (s.aW[c] !== 0) v -= s.aW[c] * p[c - 1];
      if (s.aN[c] !== 0) v -= s.aN[c] * p[c + nx];
      if (s.aS[c] !== 0) v -= s.aS[c] * p[c - nx];
      q[c] = v;
    }
    const pq = this.dot(p, q);
    if (!(pq > 0) || !(this.rz > 0)) {
      // 退化（解が厳密に求まった等）: これ以上進めない
      this.rNorm = 0;
      return;
    }
    const alpha = this.rz / pq;
    let rr = 0;
    for (let c = 0; c < n; c++) {
      if (!s.active[c]) continue;
      x[c] += alpha * p[c];
      r[c] -= alpha * q[c];
      rr += r[c] * r[c];
    }
    this.rNorm = Math.sqrt(rr);
    this.precondition();
    const rzNew = this.dot(r, this.z);
    const beta = rzNew / this.rz;
    this.rz = rzNew;
    for (let c = 0; c < n; c++) {
      if (s.active[c]) p[c] = this.z[c] + beta * p[c];
    }
  }

  private dot(a: Float64Array, b: Float64Array): number {
    let sum = 0;
    for (let c = 0; c < a.length; c++) sum += a[c] * b[c];
    return sum;
  }

  /** z = M⁻¹ r  （M = (D−L) D⁻¹ (D−U)、対称 Gauss–Seidel） */
  private precondition(): void {
    const { s, r, z } = this;
    const { nx, active, aP, aE, aW, aN, aS } = s;
    const n = active.length;
    // 前進: (D−L) w = r
    for (let c = 0; c < n; c++) {
      if (!active[c]) continue;
      let v = r[c];
      if (aW[c] !== 0) v += aW[c] * z[c - 1];
      if (aS[c] !== 0) v += aS[c] * z[c - nx];
      z[c] = v / aP[c];
    }
    // 後退: (D−U) z = D w （z を w から上書きしていく）
    for (let c = n - 1; c >= 0; c--) {
      if (!active[c]) continue;
      let v = aP[c] * z[c];
      if (aE[c] !== 0) v += aE[c] * z[c + 1];
      if (aN[c] !== 0) v += aN[c] * z[c + nx];
      z[c] = v / aP[c];
    }
  }
}

/**
 * 残差の対数から進捗 0〜1 の目安を作る。
 * 初期残差 res0 から許容値 tol まで、対数軸で直線的に下がるものとみなす。
 */
export function progressFromResidual(res: number, res0: number, tol: number): number {
  if (!(res > tol)) return 1;
  const total = Math.log10(Math.max(res0, tol * 10)) - Math.log10(tol);
  const left = Math.log10(res) - Math.log10(tol);
  return Math.min(0.99, Math.max(0, 1 - left / total));
}

/** 履歴用の間引き付き時系列。点数が上限を超えたら1つおきに捨てる（グラフ描画を軽く保つ） */
export class SampledSeries {
  t: number[] = [];
  values: number[] = [];
  private stride = 1;
  private count = 0;

  constructor(private readonly maxPoints = 400) {}

  push(t: number, v: number): void {
    if (this.count++ % this.stride !== 0) return;
    this.t.push(t);
    this.values.push(v);
    if (this.t.length > this.maxPoints) {
      this.t = this.t.filter((_, k) => k % 2 === 0);
      this.values = this.values.filter((_, k) => k % 2 === 0);
      this.stride *= 2;
    }
  }
}
