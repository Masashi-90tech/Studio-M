import { describe, expect, it } from 'vitest';
import { buildLUT, colormapRGB, fieldRange, lutIndex } from './colormap';

describe('colormap', () => {
  it('turbo は暗い紺 → 緑 → 赤', () => {
    const lo = colormapRGB('turbo', 0);
    const mid = colormapRGB('turbo', 0.5);
    const hi = colormapRGB('turbo', 1);
    expect(lo[0] + lo[1] + lo[2]).toBeLessThan(200); // 暗い
    expect(mid[1]).toBeGreaterThan(mid[0]); // 中間は緑が強い
    expect(mid[1]).toBeGreaterThan(mid[2]);
    expect(hi[0]).toBeGreaterThan(hi[2]); // 赤っぽい
    expect(colormapRGB('turbo', 0.1)[2]).toBeGreaterThan(colormapRGB('turbo', 0.1)[0]); // 低い側は青系
  });

  it('viridis は暗い紫から黄色へ', () => {
    expect(colormapRGB('viridis', 0)).toEqual([68, 1, 84]);
    expect(colormapRGB('viridis', 1)).toEqual([253, 231, 37]);
  });

  it('diverging は中央が白、負が青、正が赤', () => {
    expect(colormapRGB('diverging', 0.5)).toEqual([247, 247, 247]);
    const neg = colormapRGB('diverging', 0);
    const pos = colormapRGB('diverging', 1);
    expect(neg[2]).toBeGreaterThan(neg[0]);
    expect(pos[0]).toBeGreaterThan(pos[2]);
  });

  it('範囲外・NaN は端に丸める', () => {
    expect(colormapRGB('viridis', -5)).toEqual(colormapRGB('viridis', 0));
    expect(colormapRGB('viridis', 7)).toEqual(colormapRGB('viridis', 1));
    expect(colormapRGB('turbo', NaN)).toEqual(colormapRGB('turbo', 0));
  });

  it('LUT は 256 段の不透明 RGBA', () => {
    const lut = buildLUT('turbo');
    expect(lut.length).toBe(256 * 4);
    expect(lut[3]).toBe(255);
    expect(lut[255 * 4 + 3]).toBe(255);
    expect(Array.from(lut.slice(0, 3))).toEqual(colormapRGB('turbo', 0));
  });

  it('fieldRange はマスクと非有限値を無視する', () => {
    const data = new Float32Array([1, 5, NaN, 100, -3]);
    const mask = new Uint8Array([1, 1, 1, 0, 1]);
    expect(fieldRange(data, mask)).toEqual({ min: -3, max: 5 });
  });

  it('diverging は 0 中心の対称範囲', () => {
    expect(fieldRange(new Float32Array([-2, 8]), undefined, true)).toEqual({ min: -8, max: 8 });
  });

  it('一様な場は幅を持たせ、空なら既定範囲', () => {
    const r = fieldRange(new Float32Array([25, 25, 25]));
    expect(r.max).toBeGreaterThan(r.min);
    expect(fieldRange(new Float32Array([NaN]))).toEqual({ min: 0, max: 1 });
  });

  it('lutIndex は範囲を 0〜255 に写す', () => {
    const r = { min: 0, max: 10 };
    expect(lutIndex(0, r)).toBe(0);
    expect(lutIndex(10, r)).toBe(255);
    expect(lutIndex(5, r)).toBe(128);
    expect(lutIndex(-4, r)).toBe(0);
    expect(lutIndex(99, r)).toBe(255);
  });
});
