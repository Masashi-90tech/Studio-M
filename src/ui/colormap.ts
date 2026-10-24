// カラーマップ（知覚的に均一な turbo / viridis と、正負用の青‐白‐赤）。
// 純粋関数だけで書いて、描画側は 256 段の LUT を引くだけにする。

export type ColormapName = 'turbo' | 'viridis' | 'diverging';
export type RGB = [number, number, number];

export const COLORMAP_LABELS: Record<ColormapName, string> = {
  turbo: 'Turbo（虹色・見やすい）',
  viridis: 'Viridis（落ち着いた色）',
  diverging: '青‐白‐赤（正負）',
};

const clamp01 = (t: number): number => (Number.isNaN(t) ? 0 : t < 0 ? 0 : t > 1 ? 1 : t);

/** Google の turbo の多項式近似 */
function turbo(t: number): RGB {
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  const c = (v: number): number => Math.round(255 * clamp01(v));
  return [c(r), c(g), c(b)];
}

const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

// viridis を 10 点で表し、間は線形補間する
const VIRIDIS: RGB[] = ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'].map(hex);

// 青 → 白 → 赤（ColorBrewer RdBu 風）
const DIVERGING: RGB[] = ['#2166ac', '#92c5de', '#f7f7f7', '#f4a582', '#b2182b'].map(hex);

function lerpStops(stops: RGB[], t: number): RGB {
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

/** t は 0〜1（範囲外は端に丸める） */
export function colormapRGB(name: ColormapName, t: number): RGB {
  const u = clamp01(t);
  switch (name) {
    case 'turbo':
      return turbo(u);
    case 'viridis':
      return lerpStops(VIRIDIS, u);
    case 'diverging':
      return lerpStops(DIVERGING, u);
  }
}

/** size 段の RGBA ルックアップ表（不透明） */
export function buildLUT(name: ColormapName, size = 256): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = colormapRGB(name, i / (size - 1));
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

export interface Range {
  min: number;
  max: number;
}

/** 有効セル（mask が 0 でなく有限値）の最小・最大。diverging のときは 0 中心の対称範囲にする */
export function fieldRange(data: ArrayLike<number>, mask?: Uint8Array, diverging = false): Range {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (mask && mask[i] === 0) continue;
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) return diverging ? { min: -1, max: 1 } : { min: 0, max: 1 };
  if (diverging) {
    const m = Math.max(Math.abs(min), Math.abs(max)) || 1;
    return { min: -m, max: m };
  }
  if (max - min < 1e-30) {
    // 一様な場のときは色が潰れないよう少しだけ幅を持たせる
    const pad = Math.abs(min) * 0.01 || 1;
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
}

/** 値を 0〜255 の LUT 番号にする */
export function lutIndex(v: number, r: Range, size = 256): number {
  const t = (v - r.min) / (r.max - r.min);
  const i = Math.round(clamp01(t) * (size - 1));
  return i;
}
