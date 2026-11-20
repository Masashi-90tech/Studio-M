import { describe, expect, it } from 'vitest';
import { checkBalance } from './balance';

describe('力の釣り合いの検算', () => {
  it('反力が荷重と逆向きに等しければ合う', () => {
    const r = checkBalance({ reaction: { x: 0, y: 200000 }, applied: { x: 0, y: -200000 } });
    expect(r.ok).toBe(true);
    expect(r.residual).toBeCloseTo(0, 6);
  });

  it('2% 以内のずれは合う、それより大きいと合わない（実験 4 の 60292 N と 51434 N）', () => {
    expect(checkBalance({ reaction: { x: 0, y: 51434 * 1.015 }, applied: { x: 0, y: -51434 } }).ok).toBe(true);
    const bad = checkBalance({ reaction: { x: 0, y: 60292 }, applied: { x: 0, y: -51434 } });
    expect(bad.ok).toBe(false);
    expect(bad.relative).toBeGreaterThan(0.1);
  });

  it('向きが逆・NaN は合わない', () => {
    expect(checkBalance({ reaction: { x: 0, y: -100 }, applied: { x: 0, y: -100 } }).ok).toBe(false);
    expect(checkBalance({ reaction: { x: NaN, y: 0 }, applied: { x: 0, y: -100 } }).ok).toBe(false);
  });

  it('荷重がほぼ 0 のときは絶対値で見る', () => {
    expect(checkBalance({ reaction: { x: 1e-6, y: 0 }, applied: { x: 0, y: 0 } }).ok).toBe(true);
    expect(checkBalance({ reaction: { x: 0.5, y: 0 }, applied: { x: 0, y: 0 } }).ok).toBe(false);
  });
});
