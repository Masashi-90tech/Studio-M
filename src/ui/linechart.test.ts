import { describe, expect, it } from 'vitest';
import { niceTicks, profileRange } from './linechart';

describe('niceTicks', () => {
  it('きりのよい間隔で範囲内の目盛りを返す', () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(0.3, 4.1, 4)).toEqual([1, 2, 3, 4]);
    const t = niceTicks(-37, 120, 4);
    expect(t[0]).toBeGreaterThanOrEqual(-37);
    expect(t[t.length - 1]).toBeLessThanOrEqual(120);
    expect(t.every((v) => v % 20 === 0 || v % 50 === 0)).toBe(true);
  });
  it('幅がないときは 1 つ、不正値は空', () => {
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(NaN, 1)).toEqual([]);
  });
});

describe('profileRange', () => {
  it('null を除いた最小・最大', () => {
    expect(profileRange([{ s: 0, v: null }, { s: 1, v: 3 }, { s: 2, v: -1 }])).toEqual({ min: -1, max: 3 });
    expect(profileRange([{ s: 0, v: null }])).toBeNull();
  });
});
