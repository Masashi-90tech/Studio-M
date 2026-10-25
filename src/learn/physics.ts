// 学びモードが使う小さな物理の式（解析ソルバーに依存しない）。DOM に触れない。

/** 真空中の光速 [m/s] */
export const C0 = 299792458;

export interface SlabResult {
  /** 電力透過率 0〜1 */
  transmission: number;
  /** 電力反射率 0〜1 */
  reflection: number;
}

type Cx = [number, number];
const mul = (x: Cx, y: Cx): Cx => [x[0] * y[0] - x[1] * y[1], x[0] * y[1] + x[1] * y[0]];
const div = (x: Cx, y: Cx): Cx => {
  const d = y[0] * y[0] + y[1] * y[1];
  return [(x[0] * y[0] + x[1] * y[1]) / d, (x[1] * y[0] - x[0] * y[1]) / d];
};

/**
 * 空気中に置いた誘電体の板への垂直入射の電力透過率・反射率（多重反射を足し合わせたファブリ・ペロー）。
 * 複素屈折率 n = √(εr(1 − j·tanδ))、位相 δ = 2π n d / λ0 として
 *   r12 = (1 − n)/(1 + n)、t12 = 2/(1 + n)、t23 = 2n/(1 + n)
 *   t = t12·t23·e^{−jδ} / (1 − r12²·e^{−2jδ})、r = r12(1 − e^{−2jδ}) / (1 − r12²·e^{−2jδ})
 * ソルバー（solvers/em.ts の slabTransmission）と同じ式。テストで一致を確かめている。
 */
export function slabPower(epsR: number, tanD: number, thicknessM: number, freqHz: number): SlabResult {
  const zr = epsR;
  const zi = -epsR * tanD;
  const m = Math.hypot(zr, zi);
  const nr = Math.sqrt(Math.max(0, (m + zr) / 2));
  const ni = -Math.sqrt(Math.max(0, (m - zr) / 2));
  const k0d = (2 * Math.PI * freqHz * thicknessM) / C0;
  const a = k0d * nr;
  const b = k0d * ni;
  const n: Cx = [nr, ni];
  const onePlusN: Cx = [1 + nr, ni];
  const oneMinusN: Cx = [1 - nr, -ni];
  const r12 = div(oneMinusN, onePlusN);
  const t12 = div([2, 0], onePlusN);
  const t23 = div(mul([2, 0], n), onePlusN);
  const e1: Cx = [Math.exp(b) * Math.cos(a), -Math.exp(b) * Math.sin(a)];
  const e2: Cx = [Math.exp(2 * b) * Math.cos(2 * a), -Math.exp(2 * b) * Math.sin(2 * a)];
  const rr = mul(mul(r12, r12), e2);
  const den: Cx = [1 - rr[0], -rr[1]];
  const t = div(mul(mul(t12, t23), e1), den);
  const r = div(mul(r12, [1 - e2[0], -e2[1]]), den);
  return { transmission: t[0] * t[0] + t[1] * t[1], reflection: r[0] * r[0] + r[1] * r[1] };
}

/** 空気中の波長 λ = c / f [m] */
export const wavelength = (freqHz: number): number => C0 / freqHz;

/** 比誘電率 εr の媒質中の波長 [m] */
export const wavelengthIn = (freqHz: number, epsR: number): number => C0 / freqHz / Math.sqrt(epsR);

/** 垂直入射の板が最もよく電波を通す厚み（媒質中の半波長）[m] */
export const halfWaveThickness = (freqHz: number, epsR: number): number => C0 / freqHz / (2 * Math.sqrt(epsR));

/** 電力比 → dB */
export const powerToDb = (ratio: number): number => 10 * Math.log10(ratio);

/** 振幅比 → dB */
export const amplitudeToDb = (ratio: number): number => 20 * Math.log10(ratio);

/** 自由空間の伝搬損失 [dB] = 20·log10(4π d f / c) */
export const freeSpaceLossDb = (distanceM: number, freqHz: number): number => 20 * Math.log10((4 * Math.PI * distanceM * freqHz) / C0);

const DEG = Math.PI / 180;
export const toRad = (deg: number): number => deg * DEG;
export const toDeg = (rad: number): number => rad / DEG;
