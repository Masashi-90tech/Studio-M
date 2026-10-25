import { describe, expect, it } from 'vitest';
import { PROGRESS_KEY, countDone, loadProgress, nextLessonId, sanitizeProgress, saveProgress, updateLessonProgress, type StorageLike } from './progress';

function memory(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('進み具合の保存', () => {
  it('保存して読み戻せる', () => {
    const st = memory();
    const map = updateLessonProgress({}, 'heatsink', { done: true, step: 5, completedSteps: 6 }, 1000);
    expect(saveProgress(map, st)).toBe(true);
    expect(loadProgress(st)).toEqual({ heatsink: { done: true, step: 5, completedSteps: 6, updatedAt: 1000 } });
  });
  it('done は一度 true になったら戻らない。元の辞書は変えない', () => {
    const a = updateLessonProgress({}, 'x', { done: true }, 1);
    const b = updateLessonProgress(a, 'x', { done: false, step: 0 }, 2);
    expect(b.x.done).toBe(true);
    expect(a.x.updatedAt).toBe(1);
  });
  it('壊れた JSON や不正な項目は捨てて空から始める', () => {
    expect(loadProgress(memory({ [PROGRESS_KEY]: '{oops' }))).toEqual({});
    expect(loadProgress(memory({ [PROGRESS_KEY]: '[1,2]' }))).toEqual({});
    expect(sanitizeProgress({ a: { done: true, step: -3, completedSteps: 'x' }, b: 5, c: null })).toEqual({ a: { done: true } });
  });
  it('使えない環境（null・例外）でも落ちない', () => {
    expect(loadProgress(null)).toEqual({});
    expect(saveProgress({}, null)).toBe(false);
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadProgress(broken)).toEqual({});
    expect(saveProgress({ a: { done: true } }, broken)).toBe(false);
  });
  it('終えた数と次のレッスン', () => {
    const map = { a: { done: true }, b: { done: false }, c: { done: true } };
    expect(countDone(map, ['a', 'b', 'c'])).toBe(2);
    expect(nextLessonId(map, ['a', 'b', 'c'])).toBe('b');
    expect(nextLessonId(map, ['a', 'c'])).toBeNull();
  });
});
