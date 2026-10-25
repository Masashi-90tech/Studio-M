// レッスンパネルの純粋な部品: 本文の解析、ステップの状態、クイズの判定。DOM に触れない。
import type { LearnContext, Lesson, LessonProgress, LessonState, LessonStep } from './types';

// ---------- 本文（**太字** と「- 」の箇条書き） ----------

export interface Inline {
  text: string;
  bold: boolean;
  /** `コード` で囲まれた部分（Excel の式など） */
  code?: boolean;
}
export type Block = { type: 'p'; inlines: Inline[] } | { type: 'ul'; items: Inline[][] };

/** 1 行の中の **太字** と `コード` を分ける。閉じていない記号は普通の文字として残す */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), bold: false });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true });
    else out.push({ text: m[2], bold: false, code: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), bold: false });
  return out;
}

/** 空行で段落を分け、「- 」で始まる行を箇条書きにする */
export function parseBody(body: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of body.trim().split(/\n\s*\n/)) {
    const lines = chunk.split('\n').map((l) => l.trimEnd());
    let list: Inline[][] | null = null;
    let para: string[] = [];
    const flushPara = () => {
      if (para.length > 0) blocks.push({ type: 'p', inlines: parseInline(para.join(' ')) });
      para = [];
    };
    for (const line of lines) {
      const m = /^\s*[-・]\s+(.*)$/.exec(line);
      if (m) {
        flushPara();
        if (!list) {
          list = [];
          blocks.push({ type: 'ul', items: list });
        }
        list.push(parseInline(m[1]));
      } else if (line.trim() !== '') {
        list = null;
        para.push(line.trim());
      }
    }
    flushPara();
  }
  return blocks;
}

// ---------- ステップの状態 ----------

/** アプリの状態で達成を確かめられるステップか */
export function hasCheck(step: LessonStep): boolean {
  return (step.kind === 'try' || step.kind === 'practice') && typeof step.check === 'function';
}

/** check を安全に呼ぶ（例外は「まだ」として扱う） */
export function runCheck(step: LessonStep, ctx: LearnContext): boolean {
  if (step.kind !== 'try' && step.kind !== 'practice') return false;
  if (!step.check) return false;
  try {
    return step.check(ctx) === true;
  } catch {
    return false;
  }
}

export function stepTitle(step: LessonStep, index: number): string {
  if (step.kind === 'quiz') return step.title ?? `確認問題 ${index + 1}`;
  return step.title;
}

export const STEP_KIND_LABEL: Record<LessonStep['kind'], string> = {
  theory: '理論',
  try: 'やってみる',
  quiz: '確認問題',
  practice: '実践',
};

export function newLessonState(lesson: Lesson): LessonState {
  return { lessonId: lesson.id, stepIndex: 0, completed: {}, quizChoice: {}, done: false };
}

/** 保存された状態を、いまのレッスンに合う形に直す（ステップ数が変わっていても壊れない） */
export function restoreLessonState(lesson: Lesson, saved?: Partial<LessonState> | null): LessonState {
  const base = newLessonState(lesson);
  if (!saved) return base;
  const n = lesson.steps.length;
  const idx = typeof saved.stepIndex === 'number' ? Math.floor(saved.stepIndex) : 0;
  base.stepIndex = Math.min(Math.max(idx, 0), Math.max(n - 1, 0));
  for (const [k, v] of Object.entries(saved.completed ?? {})) {
    const i = Number(k);
    if (v === true && Number.isInteger(i) && i >= 0 && i < n) base.completed[i] = true;
  }
  for (const [k, v] of Object.entries(saved.quizChoice ?? {})) {
    const i = Number(k);
    const step = lesson.steps[i];
    if (step?.kind === 'quiz' && Number.isInteger(v) && v >= 0 && v < step.choices.length) base.quizChoice[i] = v;
  }
  base.done = saved.done === true;
  return base;
}

/** クイズの判定。まだ選んでいなければ null */
export function quizVerdict(step: LessonStep, choice: number | undefined): 'correct' | 'wrong' | null {
  if (step.kind !== 'quiz' || choice === undefined) return null;
  return choice === step.answer ? 'correct' : 'wrong';
}

/** 完了したステップの数 */
export function completedCount(state: LessonState): number {
  return Object.values(state.completed).filter(Boolean).length;
}

/**
 * ステップの完了を更新した新しい状態を返す（元は変えない）。
 * theory は見たら完了、quiz は正解で完了、try / practice は check の達成（check がなければ手動で押したとき）。
 * 一度完了したものは戻さない（設定を戻しても「できた」は残す）。
 */
export function markStepComplete(state: LessonState, index: number): LessonState {
  if (state.completed[index]) return state;
  return { ...state, completed: { ...state.completed, [index]: true } };
}

/** いまのアプリの状態を見て、達成した try / practice を完了にする。変化がなければ同じ state を返す */
export function applyChecks(lesson: Lesson, state: LessonState, ctx: LearnContext): LessonState {
  let next = state;
  lesson.steps.forEach((step, i) => {
    if (!next.completed[i] && hasCheck(step) && runCheck(step, ctx)) next = markStepComplete(next, i);
  });
  return next;
}

/** 最後のステップを終えられる状態か（理論と確認問題は済んでいる。try / practice は押せなくても進められる） */
export function canFinish(lesson: Lesson, state: LessonState): boolean {
  return lesson.steps.every((step, i) => step.kind === 'try' || step.kind === 'practice' || state.completed[i] === true);
}

export function stepIndexClamp(lesson: Lesson, i: number): number {
  return Math.min(Math.max(Math.floor(i), 0), lesson.steps.length - 1);
}

/** パネルの状態 → 保存用の進み具合（progress.ts の updateLessonProgress に渡す） */
export function progressFromState(state: LessonState): LessonProgress {
  return { done: state.done, step: state.stepIndex, completedSteps: completedCount(state) };
}
