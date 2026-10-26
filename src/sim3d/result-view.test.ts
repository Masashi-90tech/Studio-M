import { describe, expect, it } from 'vitest';
import { cellIndex3D } from '../core/grid3d';
import type { Field3D, Grid3D, Mesh3D } from '../core/types';
import { colormapRGB, fieldRange } from '../ui/colormap';
import { fieldRange3D, hasValues, legendStops, resultField, sectionImage, sectionRange, vertexColors } from './result-view';

// 4 × 2 × 2 セルの立方体（1 辺 0.4 m 相当）: x が小さい半分は 20°C、大きい半分は 80°C。外側の余白のセルは mask 0
const grid: Grid3D = { nx: 6, ny: 4, nz: 4, h: 0.1, origin: [-0.1, -0.1, -0.1] };
function halfHot(): Field3D {
  const n = grid.nx * grid.ny * grid.nz;
  const data = new Float32Array(n);
  const mask = new Uint8Array(n);
  for (let k = 1; k < grid.nz - 1; k++)
    for (let j = 1; j < grid.ny - 1; j++)
      for (let i = 1; i < grid.nx - 1; i++) {
        const c = cellIndex3D(grid, i, j, k);
        mask[c] = 1;
        data[c] = i < 3 ? 20 : 80;
      }
  return { key: 'temp', label: '温度', unit: '°C', data, mask };
}

const rgbAt = (colors: Float32Array, v: number): number[] => [colors[v * 3], colors[v * 3 + 1], colors[v * 3 + 2]].map((c) => Math.round(c * 255));

describe('結果の色', () => {
  const field = halfHot();
  const range = fieldRange3D(field);

  it('範囲は部品の中のセルの最小・最大（20〜80）', () => {
    expect(range).toEqual({ min: 20, max: 80 });
    expect(fieldRange3D({ ...field, data: new Float32Array(field.data.length).fill(50) })).toEqual(fieldRange(new Float32Array(field.data.length).fill(50), field.mask));
    expect(resultField({ analysis: 'heat', grid, fields: [field], scalars: [], history: [], warnings: [] })).toBe(field);
  });

  it('表面の頂点の色: 低温側の頂点は最小の色、高温側の頂点は最大の色（半分ずつ高温・低温）', () => {
    // 頂点: 低温側 (0.05, 0.1, 0.1)、高温側 (0.35, 0.1, 0.1)、真ん中 (0.2, 0.1, 0.1)
    const mesh: Mesh3D = { positions: Float32Array.from([0.05, 0.1, 0.1, 0.35, 0.1, 0.1, 0.2, 0.1, 0.1]), indices: Uint32Array.from([0, 1, 2]) };
    const colors = vertexColors({ mesh, grid, field, range });
    const lo = colormapRGB('turbo', 0);
    const hi = colormapRGB('turbo', 1);
    expect(rgbAt(colors, 0)).toEqual(lo);
    expect(rgbAt(colors, 1)).toEqual(hi);
    const mid = rgbAt(colors, 2);
    expect(mid).not.toEqual(lo);
    expect(mid).not.toEqual(hi);
  });

  it('値が求められない頂点（部品から遠い）は灰色', () => {
    const mesh: Mesh3D = { positions: Float32Array.from([50, 50, 50]), indices: Uint32Array.from([0, 0, 0]) };
    const c = vertexColors({ mesh, grid, field, range });
    expect(c[0]).toBeCloseTo(c[1], 5);
    expect(c[1]).toBeCloseTo(c[2], 5);
  });

  it('切り口の画像: x 方向に切ると左が低温・右が高温。部品の外は透明', () => {
    const img = sectionImage({ grid, field, range, axis: 2, position: 0.1 })!; // Z で切る。u = X、v = Y
    expect(img.width).toBe(grid.nx * 2);
    expect(img.height).toBe(grid.ny * 2);
    expect(img.rgba).toHaveLength(img.width * img.height * 4);
    const px = (x: number, y: number): number[] => Array.from(img.rgba.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
    const lo = colormapRGB('turbo', 0);
    const hi = colormapRGB('turbo', 1);
    const midY = Math.floor(img.height / 2);
    // 部品は x = 0 .. 0.4 → 画像の x は 2 .. 10（余白 1 セル = 2 画素）。中心から離れた画素を見る
    expect(px(3, midY)).toEqual([...lo, 255]);
    expect(px(9, midY)).toEqual([...hi, 255]);
    expect(px(0, midY)[3]).toBe(0); // 余白（部品の外）
    expect(px(5, 0)[3]).toBe(0);
    // 画像の範囲は格子の範囲
    expect([img.u0, img.u1]).toEqual(sectionRange(grid, 0));
    expect([img.v0, img.v1]).toEqual(sectionRange(grid, 1));
  });

  it('部品の中のセルが 1 つもない結果（解かなかったとき）でも壊れない', () => {
    const empty: Field3D = { ...field, mask: new Uint8Array(field.mask.length) };
    expect(hasValues(field)).toBe(true);
    expect(hasValues(empty)).toBe(false);
    const mesh: Mesh3D = { positions: Float32Array.from([0.05, 0.1, 0.1]), indices: Uint32Array.from([0, 0, 0]) };
    const c = vertexColors({ mesh, grid, field: empty, range: fieldRange3D(empty) });
    expect(Array.from(c).every(Number.isFinite)).toBe(true);
    const img = sectionImage({ grid, field: empty, range: fieldRange3D(empty), axis: 2, position: 0.1 })!;
    expect(img.rgba.every((v) => v === 0)).toBe(true);
  });

  it('格子の外で切ると null', () => {
    expect(sectionImage({ grid, field, range, axis: 0, position: 5 })).toBeNull();
  });

  it('凡例の色は、小さい値から大きい値へ', () => {
    const s = legendStops('turbo', 5);
    expect(s).toHaveLength(5);
    const [r, g, b] = colormapRGB('turbo', 0);
    expect(s[0]).toBe(`#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`);
  });
});
