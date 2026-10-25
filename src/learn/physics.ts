// 学びモードが使う小さな物理の式（解析ソルバーに依存しない）。DOM に触れない。
// 平板の透過・反射は src/core/slab.ts の slabTransmission を使う（コピーを持たない）。

/** 真空中の光速 [m/s] */
export const C0 = 299792458;

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
