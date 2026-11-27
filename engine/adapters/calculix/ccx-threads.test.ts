import { describe, expect, it } from 'vitest';
import { ccxThreads } from './ccx-run';

describe('ccxThreads', () => {
  it('既定は CPU の数（最大 8、最小 1）', () => {
    expect(ccxThreads({}, 4)).toBe('4');
    expect(ccxThreads({}, 16)).toBe('8');
    expect(ccxThreads({}, 0)).toBe('1');
  });
  it('STUDIO_M_CCX_THREADS（1〜64 の整数）があればそれを使う', () => {
    expect(ccxThreads({ STUDIO_M_CCX_THREADS: '1' }, 8)).toBe('1');
    expect(ccxThreads({ STUDIO_M_CCX_THREADS: '12' }, 8)).toBe('12');
  });
  it('不正な値（0・小数・文字・65 以上）は無視して既定に戻す', () => {
    for (const v of ['0', '2.5', 'abc', '', '65', '-3']) expect(ccxThreads({ STUDIO_M_CCX_THREADS: v }, 6)).toBe('6');
  });
});
