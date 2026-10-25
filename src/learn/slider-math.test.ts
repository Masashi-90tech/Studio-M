import { describe, expect, it } from 'vitest';
import { SLIDER_STEPS, sliderPos, sliderValue } from './slider-math';
import { mathVar } from './providers/common';

describe('スライダーの変換', () => {
  const v = mathVar({ key: 'L', symbol: 'L', label: '長さ', unit: 'm', value: 0.2 });
  it('範囲を自動で決めると対数で、元の値は真ん中', () => {
    expect(v.log).toBe(true);
    expect(v.min).toBeCloseTo(0.05, 12);
    expect(v.max).toBeCloseTo(0.8, 12);
    expect(sliderPos(v, 0.2)).toBe(SLIDER_STEPS / 2);
  });
  it('真ん中から 1/4 動かすと 2 倍、戻すと元の値そのもの', () => {
    expect(sliderValue(v, 150)).toBeCloseTo(0.4, 5);
    expect(sliderValue(v, 50)).toBeCloseTo(0.1, 5);
    expect(sliderValue(v, 100)).toBe(0.2);
  });
  it('線形・刻み', () => {
    const a = mathVar({ key: 'a', symbol: 'θ', label: '角度', unit: '°', value: 30, min: 0, max: 80, log: false, step: 5 });
    expect(a.log).toBeUndefined();
    expect(sliderValue(a, SLIDER_STEPS)).toBe(80);
    expect(sliderValue(a, 0)).toBe(0);
    expect(sliderValue(a, 120) % 5).toBe(0);
  });
  it('範囲外の元の値は範囲を広げる。0 や負でも壊れない', () => {
    const w = mathVar({ key: 'x', symbol: 'x', label: 'x', unit: '', value: 10, min: 1, max: 5 });
    expect(w.max).toBe(10);
    expect(sliderPos(w, 10)).toBe(SLIDER_STEPS);
    const z = mathVar({ key: 'z', symbol: 'z', label: 'z', unit: '', value: 0 });
    expect(z.min).toBeLessThan(0);
    expect(Number.isFinite(sliderValue(z, 37))).toBe(true);
  });
});
