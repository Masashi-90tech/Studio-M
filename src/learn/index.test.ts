import { describe, expect, it } from 'vitest';
import { LEARNING_PATH, LESSONS, getMathProvider, renderLessonList, renderLessonPanel, renderMathWindow } from './index';

describe('学びモードの入口', () => {
  it('解析の種類ごとに式の提供者があり、kind が一致する', () => {
    for (const kind of ['flow', 'heat', 'stress', 'scalar', 'em'] as const) expect(getMathProvider(kind).kind).toBe(kind);
  });
  it('レッスンと学ぶ順、部品が公開されている', () => {
    expect(LESSONS).toHaveLength(10);
    expect(LEARNING_PATH).toHaveLength(3);
    expect(typeof renderMathWindow).toBe('function');
    expect(typeof renderLessonPanel).toBe('function');
    expect(typeof renderLessonList).toBe('function');
  });
});
