import { describe, expect, it } from 'vitest';
import { formatPercentDiff, formatPow, formatSig, formatSub, formatValue, ratioText, superscript, toPrefixed } from './format';

describe('formatSig（有効数字と ×10ⁿ）', () => {
  it('ふつうの範囲はそのまま', () => {
    expect(formatSig(0.2)).toBe('0.2');
    expect(formatSig(100)).toBe('100');
    expect(formatSig(4.644412)).toBe('4.64');
    expect(formatSig(0)).toBe('0');
    expect(formatSig(0.0123456)).toBe('0.0123');
  });
  it('3 の倍数の指数で ×10ⁿ と書く', () => {
    expect(formatSig(68.9e9)).toBe('68.9×10⁹');
    expect(formatSig(1.67e-9)).toBe('1.67×10⁻⁹');
    expect(formatSig(24e9)).toBe('24×10⁹');
    expect(formatSig(299792458)).toBe('300×10⁶');
    expect(formatSig(5e-4)).toBe('500×10⁻⁶');
    expect(formatSig(12345)).toBe('12.3×10³');
  });
  it('丸めで桁が上がっても壊れない', () => {
    expect(formatSig(999999)).toBe('1×10⁶');
    expect(formatSig(0.99996)).toBe('1');
  });
  it('負の数と非有限', () => {
    expect(formatSig(-0.46)).toBe('−0.46');
    expect(formatSig(NaN)).toBe('—');
    expect(formatSig(Infinity)).toBe('—');
  });
  it('負の数は式に入れるときカッコで包む', () => {
    expect(formatSub(-0.46)).toBe('(−0.46)');
    expect(formatSub(2)).toBe('2');
  });
});

describe('接頭辞つきの値', () => {
  it('長さは m / mm / µm', () => {
    expect(formatValue(0.0047, 'm')).toBe('4.7 mm');
    expect(formatValue(0.2, 'm')).toBe('200 mm');
    expect(formatValue(1.5, 'm')).toBe('1.5 m');
    expect(formatValue(35e-6, 'm')).toBe('35 µm');
  });
  it('応力・周波数・力', () => {
    expect(formatValue(120e6, 'Pa')).toBe('120 MPa');
    expect(formatValue(68.9e9, 'Pa')).toBe('68.9 GPa');
    expect(formatValue(24e9, 'Hz')).toBe('24 GHz');
    expect(formatValue(100, 'N')).toBe('100 N');
    expect(formatValue(0.5, 'N')).toBe('500 mN');
  });
  it('接頭辞のない単位は ×10ⁿ のまま', () => {
    expect(formatValue(1.67e-9, 'm⁴')).toBe('1.67×10⁻⁹ m⁴');
    expect(formatValue(35.6, 'K')).toBe('35.6 K');
    expect(formatValue(96.5, '%')).toBe('96.5%');
    expect(formatValue(150, '')).toBe('150');
    expect(formatValue(-3.01, 'dB')).toBe('−3.01 dB');
  });
  it('toPrefixed', () => {
    expect(toPrefixed(0.0037, 'm')).toEqual({ value: 3.7, unit: 'mm' });
    expect(toPrefixed(0, 'm')).toEqual({ value: 0, unit: 'm' });
  });
});

describe('倍率・上付き', () => {
  it('倍率の言い方', () => {
    expect(ratioText(2)).toBe('2 倍');
    expect(ratioText(8)).toBe('8 倍');
    expect(ratioText(0.5)).toBe('半分');
    expect(ratioText(0.125)).toBe('0.125 倍（1/8）');
    expect(ratioText(0.25)).toBe('0.25 倍（1/4）');
    expect(ratioText(1.5)).toBe('1.5 倍');
    expect(ratioText(0.7)).toBe('0.7 倍');
  });
  it('累乗と上付き', () => {
    expect(superscript(-9)).toBe('⁻⁹');
    expect(superscript(10)).toBe('¹⁰');
    expect(formatPow(0.2, 3)).toBe('0.2³');
    expect(formatPow(1.67e-9, 3)).toBe('(1.67×10⁻⁹)³');
  });
  it('差の割合', () => {
    expect(formatPercentDiff(1.032)).toBe('+3.2%');
    expect(formatPercentDiff(0.99)).toBe('−1%');
    expect(formatPercentDiff(1.0001)).toBe('±0%');
  });
});
