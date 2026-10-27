import { describe, expect, it } from 'vitest';
import { boxEdges, windArrowStarts, windArrows } from './flow-scene';

const box = { min: [0, 0, 0] as [number, number, number], max: [4, 2, 1] as [number, number, number] };

describe('風洞の枠', () => {
  it('12 本の辺。どの辺も、軸に平行で、長さは箱の寸法のどれか', () => {
    const e = boxEdges(box);
    expect(e.length).toBe(12 * 2 * 3);
    const lens: number[] = [];
    for (let i = 0; i < 12; i++) {
      const d = [0, 1, 2].map((a) => e[(i * 2 + 1) * 3 + a] - e[i * 2 * 3 + a]);
      expect(d.filter((v) => Math.abs(v) > 1e-9)).toHaveLength(1);
      lens.push(Math.max(...d.map(Math.abs)));
    }
    lens.sort();
    expect(lens).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4]);
  });
});

describe('風の矢印', () => {
  it('+x なら、x の小さい側（流入の面の内側）から x の正の向きへ。根もとは 5 か所で、断面の中に収まる', () => {
    const starts = windArrowStarts({ box, direction: '+x' });
    expect(starts).toHaveLength(5);
    for (const s of starts) {
      expect(s[0]).toBeGreaterThan(0);
      expect(s[0]).toBeLessThan(0.5);
      expect(s[1]).toBeGreaterThan(0);
      expect(s[1]).toBeLessThan(2);
      expect(s[2]).toBeGreaterThan(0);
      expect(s[2]).toBeLessThan(1);
    }
    expect(starts[0]).toEqual([starts[0][0], 1, 0.5]); // 中心
    const a = windArrows({ box, direction: '+x' });
    // 1 本 = 軸の線 1 + 矢じり 4 = 5 線分
    expect(a.length).toBe(5 * 5 * 2 * 3);
    // 最初の線: 根もと → 先端（x が 0.22 × 4 = 0.88 だけ増える）
    expect(a[3] - a[0]).toBeCloseTo(0.88, 5);
    expect(a[4]).toBeCloseTo(a[1], 6);
  });

  it('向きが −z なら、z の大きい側から下向き。矢じりは先端より上（来た側）にある', () => {
    const a = windArrows({ box, direction: '-z' });
    const z0 = a[2];
    const z1 = a[5];
    expect(z0).toBeGreaterThan(0.9);
    expect(z1).toBeLessThan(z0);
    // 矢じりの線（2 本目）は、先端から始まって、先端より z が大きい点へ戻る
    expect(a[6 + 2]).toBeCloseTo(z1, 6);
    expect(a[9 + 2]).toBeGreaterThan(z1);
  });
});
