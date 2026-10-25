import { describe, expect, it } from 'vitest';
import {
  applyChecks,
  canFinish,
  markStepComplete,
  newLessonState,
  parseBody,
  parseInline,
  progressFromState,
  quizVerdict,
  restoreLessonState,
  runCheck,
} from './lesson-logic';
import { buildStages } from './lesson-list';
import type { LearnContext, Lesson } from './types';
import { defaultProject } from '../core/project';

const ctx: LearnContext = { project: defaultProject(), result: null };
const lesson: Lesson = {
  id: 't',
  presetId: 'p',
  title: 'テスト',
  summary: '',
  level: '中学',
  topics: [],
  minutes: 5,
  steps: [
    { kind: 'theory', title: '理論', body: 'a' },
    { kind: 'try', title: '設定', instruction: 'やる', check: ({ project }) => project.thickness > 0.5 },
    { kind: 'quiz', question: 'Q', choices: ['x', 'y'], answer: 1, explanation: 'e' },
    { kind: 'practice', title: '実践', goal: 'g', check: () => { throw new Error('boom'); } },
    { kind: 'try', title: '手動', instruction: 'i' },
  ],
};

describe('本文の解析', () => {
  it('太字・コード・閉じていない記号', () => {
    expect(parseInline('a **b** c')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c', bold: false },
    ]);
    expect(parseInline('`=A1+B1` です')).toEqual([
      { text: '=A1+B1', bold: false, code: true },
      { text: ' です', bold: false },
    ]);
    expect(parseInline('2 ** 3')).toEqual([{ text: '2 ** 3', bold: false }]);
  });
  it('段落と箇条書き', () => {
    const blocks = parseBody('はじめ\nつづき\n\n- **一**: 説明\n- 二\n\nおわり');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'ul', 'p']);
    const [p, ul] = blocks;
    if (p.type !== 'p' || ul.type !== 'ul') throw new Error('型');
    expect(p.inlines[0].text).toBe('はじめ つづき');
    expect(ul.items).toHaveLength(2);
    expect(ul.items[0][0]).toEqual({ text: '一', bold: true });
  });
  it('段落の途中の箇条書き', () => {
    const blocks = parseBody('見出し\n- a\n- b\nあと');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'ul', 'p']);
  });
});

describe('ステップの状態', () => {
  it('check の例外は「まだ」になる', () => {
    expect(runCheck(lesson.steps[3], ctx)).toBe(false);
    expect(runCheck(lesson.steps[0], ctx)).toBe(false);
  });
  it('達成した try / practice だけ完了にして、戻さない', () => {
    let st = newLessonState(lesson);
    expect(applyChecks(lesson, st, ctx)).toBe(st);
    const p = defaultProject();
    p.thickness = 1;
    st = applyChecks(lesson, st, { project: p, result: null });
    expect(st.completed).toEqual({ 1: true });
    // 設定を戻しても「できた」は残る
    const again = applyChecks(lesson, st, ctx);
    expect(again.completed).toEqual({ 1: true });
    expect(markStepComplete(st, 1)).toBe(st);
  });
  it('クイズの判定', () => {
    expect(quizVerdict(lesson.steps[2], undefined)).toBeNull();
    expect(quizVerdict(lesson.steps[2], 0)).toBe('wrong');
    expect(quizVerdict(lesson.steps[2], 1)).toBe('correct');
    expect(quizVerdict(lesson.steps[0], 0)).toBeNull();
  });
  it('終えられる条件: 理論と確認問題が済んでいる', () => {
    let st = newLessonState(lesson);
    expect(canFinish(lesson, st)).toBe(false);
    st = markStepComplete(markStepComplete(st, 0), 2);
    expect(canFinish(lesson, st)).toBe(true);
  });
  it('保存された状態を、レッスンに合わせて直す', () => {
    const st = restoreLessonState(lesson, { stepIndex: 99, completed: { 0: true, 9: true, 1: false }, quizChoice: { 2: 1, 0: 1, 9: 1 }, done: true });
    expect(st.stepIndex).toBe(4);
    expect(st.completed).toEqual({ 0: true });
    expect(st.quizChoice).toEqual({ 2: 1 });
    expect(st.done).toBe(true);
    expect(restoreLessonState(lesson, null)).toEqual(newLessonState(lesson));
    expect(restoreLessonState(lesson, { stepIndex: -3 }).stepIndex).toBe(0);
  });
  it('保存用の進み具合', () => {
    const st = markStepComplete(newLessonState(lesson), 0);
    expect(progressFromState({ ...st, stepIndex: 2 })).toEqual({ done: false, step: 2, completedSteps: 1 });
  });
});

describe('一覧の段階', () => {
  const mk = (id: string, level: Lesson['level']): Lesson => ({ ...lesson, id, level });
  it('path の順に並べ、path にないものは level ごとにまとめる', () => {
    const list = [mk('a', '大学'), mk('b', '中学'), mk('c', '中学'), mk('d', '高校')];
    const stages = buildStages(list, [{ level: '中学', title: '入門', description: '', lessonIds: ['c', 'zzz', 'b'] }]);
    expect(stages.map((s) => s.lessons.map((l) => l.id))).toEqual([['c', 'b'], ['d'], ['a']]);
    expect(buildStages(list).map((s) => s.stage.level)).toEqual(['中学', '高校', '大学']);
  });
});
