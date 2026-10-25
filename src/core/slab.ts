// 誘電体スラブの透過・反射の解析解（垂直入射）。DOM にもソルバーにも依存しない純粋な式。
// 電磁波のソルバー（solvers/em.ts）と、判定の「おすすめの厚み」（workbench）が共有する。

const C0 = 299792458;

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
