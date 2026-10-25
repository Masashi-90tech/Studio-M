import { describe, expect, it } from 'vitest';
import { dbInsight, exponentWords, joinInsight, powerInsight, ratioInsight } from './insight';

const terms = [
  { key: 'P', symbol: 'P', exp: 1 },
  { key: 'L', symbol: 'L', exp: 3 },
  { key: 'E', symbol: 'E', exp: -1 },
];
const base = { P: 100, L: 0.2, E: 70e9 };

describe('powerInsight', () => {
  const f = powerInsight('δ', terms);
  it('1 つ動かしたら理由つき', () => {
    expect(f({ ...base, L: 0.4 }, base)).toBe('L が 2 倍 → δ は 8 倍（3 乗だから）');
    expect(f({ ...base, P: 200 }, base)).toBe('P が 2 倍 → δ は 2 倍（比例だから）');
    expect(f({ ...base, E: 140e9 }, base)).toBe('E が 2 倍 → δ は半分（反比例だから）');
  });
  it('反比例の言い方', () => {
    const g = powerInsight('ΔT', [{ key: 'A', symbol: 'A', exp: -1 }]);
    expect(g({ A: 3 }, { A: 1 })).toContain('反比例');
    expect(exponentWords(-2)).toBe('2 乗に反比例するから');
    expect(exponentWords(0.5)).toBe('平方根だから');
  });
  it('複数動かしたら合計の倍率', () => {
    expect(f({ ...base, L: 0.4, P: 200 }, base)).toBe('P が 2 倍、L が 2 倍 → δ は全部で 16 倍');
  });
  it('打ち消し合うと変わらない', () => {
    expect(f({ ...base, L: 0.4, E: 560e9 }, base)).toContain('打ち消し合って');
  });
  it('変化なし、または元が 0 なら null', () => {
    expect(f(base, base)).toBeNull();
    expect(f({ ...base, L: 0.2000001 }, base)).toBeNull();
    expect(f({ ...base, L: 1 }, { ...base, L: 0 })).toBeNull();
  });
});

describe('ratioInsight / dbInsight / joinInsight', () => {
  it('結果の倍率を言う', () => {
    const f = ratioInsight('u', { k: 'k', F: 'F' }, (v) => v.F / v.k);
    expect(f({ k: 2, F: 1 }, { k: 1, F: 1 })).toBe('k が 2 倍 → u は半分');
    expect(f({ k: 2, F: 2 }, { k: 1, F: 1 })).toContain('ほぼ変わりません');
  });
  it('dB は差で言う', () => {
    const f = dbInsight('dB', { r: 'P₂/P₁' }, (v) => 10 * Math.log10(v.r));
    expect(f({ r: 2 }, { r: 1 })).toBe('P₂/P₁ が 2 倍 → dB は +3.01 dB');
    expect(f({ r: 0.5 }, { r: 1 })).toBe('P₂/P₁ が半分 → dB は −3.01 dB');
  });
  it('joinInsight', () => {
    expect(joinInsight('a', 'b')).toBe('a。b');
    expect(joinInsight(null, 'b')).toBe('b');
    expect(joinInsight(null, null)).toBeNull();
  });
});
