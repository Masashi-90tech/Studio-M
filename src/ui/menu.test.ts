import { describe, expect, it } from 'vitest';
import { nextMenuIndex } from './menu';

describe('メニューの矢印キー', () => {
  const n = (current: number, key: string, count = 3) => nextMenuIndex({ current, count, key });
  it('下・上でぐるっと回る', () => {
    expect(n(-1, 'ArrowDown')).toBe(0);
    expect(n(0, 'ArrowDown')).toBe(1);
    expect(n(2, 'ArrowDown')).toBe(0);
    expect(n(-1, 'ArrowUp')).toBe(2);
    expect(n(0, 'ArrowUp')).toBe(2);
    expect(n(2, 'ArrowUp')).toBe(1);
  });
  it('Home / End で先頭・末尾', () => {
    expect(n(1, 'Home')).toBe(0);
    expect(n(1, 'End')).toBe(2);
  });
  it('関係ないキーと項目なしは -1', () => {
    expect(n(1, 'a')).toBe(-1);
    expect(n(0, 'ArrowDown', 0)).toBe(-1);
  });
});
