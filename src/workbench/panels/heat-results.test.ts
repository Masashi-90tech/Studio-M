import { describe, expect, it } from 'vitest';
import type { Raster } from '../../core/types';
import { copperText, kEffRange } from './heat-results';

describe('熱の結果の追加表示（基板の情報）', () => {
  it('実効熱伝導率の範囲は、物体セルの有限な値だけで数える', () => {
    const raster = { solid: new Uint8Array([1, 1, 1, 0]), kEff: new Float32Array([0.3, 8.9, NaN, 999]) } as unknown as Raster;
    const r = kEffRange(raster)!;
    expect(r.min).toBeCloseTo(0.3, 5);
    expect(r.max).toBeCloseTo(8.9, 5);
    expect(kEffRange(null)).toBeNull();
    expect(kEffRange({ solid: new Uint8Array(2) } as unknown as Raster)).toBeNull();
  });
  it('銅箔の層を名前と厚さで並べる', () => {
    expect(copperText({ source: 'a', boardThicknessMm: 1.6, substrateId: 'fr4', layers: [{ name: 'F.Cu', thicknessUm: 35, polygons: [] }, { name: 'B.Cu', thicknessUm: 70, polygons: [] }] })).toBe('F.Cu 35 µm / B.Cu 70 µm');
    expect(copperText({ source: 'a', boardThicknessMm: 1.6, substrateId: 'fr4', layers: [] })).toContain('ありません');
  });
});
