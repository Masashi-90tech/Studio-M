import { describe, expect, it } from 'vitest';
import { formatNumber, formatQuantity, formatRange, inputNumber, pickUnit } from './format';

describe('formatNumber', () => {
  it('有効数字3桁で末尾の0を落とす', () => {
    expect(formatNumber(1234.5)).toBe('1230');
    expect(formatNumber(0.5)).toBe('0.5');
    expect(formatNumber(3.14159)).toBe('3.14');
    expect(formatNumber(0)).toBe('0');
  });
  it('極端な値は指数表記', () => {
    expect(formatNumber(1.5e-7)).toBe('1.5e-7');
    expect(formatNumber(2.5e9)).toBe('2.5e9');
  });
  it('有限でない値はダッシュ', () => {
    expect(formatNumber(NaN)).toBe('—');
    expect(formatNumber(Infinity)).toBe('—');
  });
});

describe('formatQuantity', () => {
  it('Pa は MPa などに', () => {
    expect(formatQuantity(12.3e6, 'Pa')).toBe('12.3 MPa');
    expect(formatQuantity(4500, 'Pa')).toBe('4.5 kPa');
    expect(formatQuantity(0.4, 'Pa')).toBe('0.4 Pa');
    expect(formatQuantity(2.1e9, 'Pa')).toBe('2.1 GPa');
  });
  it('m は mm / µm に', () => {
    expect(formatQuantity(0.0046, 'm')).toBe('4.6 mm');
    expect(formatQuantity(2, 'm')).toBe('2 m');
    expect(formatQuantity(3e-5, 'm')).toBe('30 µm');
  });
  it('N は mN / kN に', () => {
    expect(formatQuantity(0.012, 'N')).toBe('12 mN');
    expect(formatQuantity(50, 'N')).toBe('50 N');
    expect(formatQuantity(2500, 'N')).toBe('2.5 kN');
  });
  it('符号を保ち、0 は基準単位', () => {
    expect(formatQuantity(-3.2e6, 'Pa')).toBe('-3.2 MPa');
    expect(formatQuantity(0, 'Pa')).toBe('0 Pa');
  });
  it('接頭辞の対象でない単位はそのまま', () => {
    expect(formatQuantity(45.26, '°C')).toBe('45.3 °C');
    expect(formatQuantity(120, '')).toBe('120');
  });
});

describe('formatRange', () => {
  it('最大値に合わせて両端の接頭辞をそろえる', () => {
    expect(formatRange(0, 2.5e6, 'Pa')).toEqual({ min: '0', max: '2.5', unit: 'MPa' });
    expect(formatRange(-1e-3, 3e-3, 'm')).toEqual({ min: '-1', max: '3', unit: 'mm' });
  });
});

describe('pickUnit / inputNumber', () => {
  it('pickUnit は未知の単位をそのまま返す', () => {
    expect(pickUnit(5, 'kg')).toEqual({ scale: 1, unit: 'kg' });
  });
  it('inputNumber は小数桁を丸める', () => {
    expect(inputNumber(1.23456, 2)).toBe('1.23');
    expect(inputNumber(10, 3)).toBe('10');
  });
});
