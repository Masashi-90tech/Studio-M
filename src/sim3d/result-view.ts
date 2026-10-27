// 3D の結果を色にする（DOM に依存しない）。
// - 表面の頂点の色: 頂点の位置の値を sampleField3D で求め、カラーマップに通す
// - 切り口の画像: 切る位置の平面を格子から細かくサンプリングして色にする
import { cellIndex3D, sampleField3D } from '../core/grid3d';
import type { Field3D, Grid3D, Mesh3D, ResultSet3D } from '../core/types';
import type { Axis, SectionImage } from '../mesh3d/types';
import { colormapRGB, fieldRange, lutIndex, buildLUT, type ColormapName, type Range } from '../ui/colormap';

/** 温度の表示に使うカラーマップ（2D と同じ Turbo） */
export const RESULT_COLORMAP: ColormapName = 'turbo';

/** 値のないところ（NaN）の色 */
const NO_VALUE: [number, number, number] = [0.72, 0.72, 0.72];

/** 正負のある場（圧力など）は青‐白‐赤、それ以外は Turbo */
export function colormapFor(field: Field3D): ColormapName {
  return field.diverging ? 'diverging' : RESULT_COLORMAP;
}

/** 表示する場。key があればそれ、なければ温度（temp）、それもなければ最初の場 */
export function resultField(result: ResultSet3D, key?: string): Field3D | undefined {
  return result.fields.find((f) => f.key === (key ?? 'temp')) ?? result.fields[0];
}

/** 値のあるセル（熱・強度は部品の中、流れは流体のセルで有限の値）が 1 つでもあるか。放熱の経路がなく解かなかったときなどは false */
export function hasValues(field: Field3D): boolean {
  for (let i = 0; i < field.data.length; i++) if (field.mask[i] === 1 && Number.isFinite(field.data[i])) return true;
  return false;
}

/** 部品の中のセルの最小・最大（一様なときは色が潰れないよう少し幅を持たせる） */
export function fieldRange3D(field: Field3D): Range {
  return fieldRange(field.data, field.mask, field.diverging);
}

/** 頂点ごとの色（r, g, b を 0〜1 で、頂点の数 × 3） */
export function vertexColors(opts: { mesh: Mesh3D; grid: Grid3D; field: Field3D; range: Range; colormap?: ColormapName }): Float32Array {
  const { mesh, grid, field, range } = opts;
  const lut = buildLUT(opts.colormap ?? RESULT_COLORMAP);
  const p = mesh.positions;
  const nv = Math.floor(p.length / 3);
  const out = new Float32Array(nv * 3);
  const q: [number, number, number] = [0, 0, 0];
  for (let v = 0; v < nv; v++) {
    q[0] = p[v * 3];
    q[1] = p[v * 3 + 1];
    q[2] = p[v * 3 + 2];
    const val = sampleField3D(grid, field.data, field.mask, q);
    if (!Number.isFinite(val)) {
      out[v * 3] = NO_VALUE[0];
      out[v * 3 + 1] = NO_VALUE[1];
      out[v * 3 + 2] = NO_VALUE[2];
      continue;
    }
    const i = lutIndex(val, range) * 4;
    out[v * 3] = lut[i] / 255;
    out[v * 3 + 1] = lut[i + 1] / 255;
    out[v * 3 + 2] = lut[i + 2] / 255;
  }
  return out;
}

/** 切る位置が格子の範囲内にあるか */
export function sectionRange(grid: Grid3D, axis: Axis): [number, number] {
  const n = [grid.nx, grid.ny, grid.nz][axis];
  return [grid.origin[axis], grid.origin[axis] + n * grid.h];
}

/** 画像の 1 辺の最大 */
const MAX_SECTION_PIXELS = 512;

/**
 * 切り口の画像。格子の 1 セルを 2 × 2 画素でサンプリングし、部品の外（mask が 0）は透明にする。
 * 切る位置が格子の外なら null
 */
export function sectionImage(opts: { grid: Grid3D; field: Field3D; range: Range; axis: Axis; position: number; colormap?: ColormapName }): SectionImage | null {
  const { grid, field, range, axis, position } = opts;
  const [lo, hi] = sectionRange(grid, axis);
  if (!(position >= lo && position <= hi)) return null;
  const u = ((axis + 1) % 3) as Axis;
  const v = ((axis + 2) % 3) as Axis;
  const n = [grid.nx, grid.ny, grid.nz];
  const [u0, u1] = sectionRange(grid, u);
  const [v0, v1] = sectionRange(grid, v);
  const width = Math.min(MAX_SECTION_PIXELS, n[u] * 2);
  const height = Math.min(MAX_SECTION_PIXELS, n[v] * 2);
  const lut = buildLUT(opts.colormap ?? RESULT_COLORMAP);
  const rgba = new Uint8Array(width * height * 4);
  const pt: [number, number, number] = [0, 0, 0];
  pt[axis] = position;
  for (let y = 0; y < height; y++) {
    pt[v] = v0 + ((y + 0.5) / height) * (v1 - v0);
    for (let x = 0; x < width; x++) {
      pt[u] = u0 + ((x + 0.5) / width) * (u1 - u0);
      const ci = Math.min(grid.nx - 1, Math.max(0, Math.floor((pt[0] - grid.origin[0]) / grid.h)));
      const cj = Math.min(grid.ny - 1, Math.max(0, Math.floor((pt[1] - grid.origin[1]) / grid.h)));
      const ck = Math.min(grid.nz - 1, Math.max(0, Math.floor((pt[2] - grid.origin[2]) / grid.h)));
      if (field.mask[cellIndex3D(grid, ci, cj, ck)] !== 1) continue; // 部品の外は透明
      const val = sampleField3D(grid, field.data, field.mask, pt);
      if (!Number.isFinite(val)) continue;
      const o = lutIndex(val, range) * 4;
      const k = (y * width + x) * 4;
      rgba[k] = lut[o];
      rgba[k + 1] = lut[o + 1];
      rgba[k + 2] = lut[o + 2];
      rgba[k + 3] = 255;
    }
  }
  return { axis, position, u0, u1, v0, v1, width, height, rgba };
}

/** 凡例（カラーバー）の色の並び。下から上へ、steps 個の #rrggbb */
export function legendStops(colormap: ColormapName = RESULT_COLORMAP, steps = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    const [r, g, b] = colormapRGB(colormap, i / (steps - 1));
    out.push(`#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`);
  }
  return out;
}
