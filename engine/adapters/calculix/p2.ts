// 6 節点三角形（CPS6。角 3 つ + 辺の中点 3 つ）の形状関数と、点の位置の逆引き。
//
// 局所座標 (ξ, η)。L1 = 1 − ξ − η, L2 = ξ, L3 = η。節点 1〜3 は角、4 は辺 1-2、5 は辺 2-3、6 は辺 3-1 の中点。
//   N1 = L1(2L1 − 1), N2 = L2(2L2 − 1), N3 = L3(2L3 − 1), N4 = 4 L1 L2, N5 = 4 L2 L3, N6 = 4 L3 L1
// 辺の中点は曲線に沿った位置（曲がった辺）でもよい。形状関数で位置も値も同じように補間する（アイソパラメトリック）。

/** 形状関数 N[0..5] */
export function shapeP2(xi: number, eta: number, out: ArrayLike<number> & { [i: number]: number }): void {
  const l1 = 1 - xi - eta;
  out[0] = l1 * (2 * l1 - 1);
  out[1] = xi * (2 * xi - 1);
  out[2] = eta * (2 * eta - 1);
  out[3] = 4 * l1 * xi;
  out[4] = 4 * xi * eta;
  out[5] = 4 * eta * l1;
}

/** 形状関数の ξ・η での微分 */
function derivP2(xi: number, eta: number, dxi: number[], deta: number[]): void {
  const l1 = 1 - xi - eta;
  dxi[0] = -(4 * l1 - 1);
  dxi[1] = 4 * xi - 1;
  dxi[2] = 0;
  dxi[3] = 4 * (l1 - xi);
  dxi[4] = 4 * eta;
  dxi[5] = -4 * eta;
  deta[0] = -(4 * l1 - 1);
  deta[1] = 0;
  deta[2] = 4 * eta - 1;
  deta[3] = -4 * xi;
  deta[4] = 4 * xi;
  deta[5] = 4 * (l1 - eta);
}

/** 6 つの節点の値 v を (ξ, η) で補間する */
export function interpP2(v: ArrayLike<number>, xi: number, eta: number): number {
  const l1 = 1 - xi - eta;
  return (
    v[0] * l1 * (2 * l1 - 1) +
    v[1] * xi * (2 * xi - 1) +
    v[2] * eta * (2 * eta - 1) +
    v[3] * 4 * l1 * xi +
    v[4] * 4 * xi * eta +
    v[5] * 4 * eta * l1
  );
}

/** 要素の面積（曲がった辺も含む）。ヤコビアンは 2 次式なので、3 点の積分で厳密 */
export function areaP2(xs: ArrayLike<number>, ys: ArrayLike<number>): number {
  const dxi = new Array<number>(6).fill(0);
  const deta = new Array<number>(6).fill(0);
  let area = 0;
  for (const [xi, eta] of [
    [1 / 6, 1 / 6],
    [2 / 3, 1 / 6],
    [1 / 6, 2 / 3],
  ]) {
    derivP2(xi, eta, dxi, deta);
    let xx = 0;
    let xe = 0;
    let yx = 0;
    let ye = 0;
    for (let a = 0; a < 6; a++) {
      xx += dxi[a] * xs[a];
      xe += deta[a] * xs[a];
      yx += dxi[a] * ys[a];
      ye += deta[a] * ys[a];
    }
    area += (xx * ye - xe * yx) / 6;
  }
  return area;
}

/**
 * 点 (px, py) が要素のどこか（ξ, η）を求める。角の三角形から始めて、ニュートン法で曲がった辺も考慮する。
 * 求められなければ null（つぶれた要素など）。要素の中かどうかは、返った (ξ, η) が三角形の中かで呼び出し側が判断する
 */
export function locateP2(xs: ArrayLike<number>, ys: ArrayLike<number>, px: number, py: number): { xi: number; eta: number } | null {
  const ax = xs[1] - xs[0];
  const ay = ys[1] - ys[0];
  const bx = xs[2] - xs[0];
  const by = ys[2] - ys[0];
  const det0 = ax * by - bx * ay;
  if (!(Math.abs(det0) > 0)) return null;
  let xi = ((px - xs[0]) * by - bx * (py - ys[0])) / det0;
  let eta = (ax * (py - ys[0]) - (px - xs[0]) * ay) / det0;
  const N = new Array<number>(6).fill(0);
  const dxi = new Array<number>(6).fill(0);
  const deta = new Array<number>(6).fill(0);
  const scale = Math.sqrt(Math.abs(det0));
  for (let it = 0; it < 12; it++) {
    shapeP2(xi, eta, N);
    derivP2(xi, eta, dxi, deta);
    let x = 0;
    let y = 0;
    let xx = 0;
    let xe = 0;
    let yx = 0;
    let ye = 0;
    for (let a = 0; a < 6; a++) {
      x += N[a] * xs[a];
      y += N[a] * ys[a];
      xx += dxi[a] * xs[a];
      xe += deta[a] * xs[a];
      yx += dxi[a] * ys[a];
      ye += deta[a] * ys[a];
    }
    const rx = px - x;
    const ry = py - y;
    const det = xx * ye - xe * yx;
    if (!(Math.abs(det) > 0)) return null;
    const dXi = (rx * ye - xe * ry) / det;
    const dEta = (xx * ry - rx * yx) / det;
    xi += dXi;
    eta += dEta;
    if (Math.hypot(rx, ry) < 1e-12 * scale && Math.abs(dXi) + Math.abs(dEta) < 1e-12) break;
  }
  if (!Number.isFinite(xi) || !Number.isFinite(eta)) return null;
  return { xi, eta };
}

/** (ξ, η) が三角形の中か（境界から tol まではみ出していてもよい） */
export function insideTriangle(xi: number, eta: number, tol = 1e-9): boolean {
  return xi >= -tol && eta >= -tol && 1 - xi - eta >= -tol;
}
