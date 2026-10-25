// レッスンの進み具合の保存。localStorage は使えないことがあるので、読み書きは try/catch で包む。
import type { LessonProgress } from './types';

export type ProgressMap = Record<string, LessonProgress>;

/** localStorage と同じ形の最小限の入れ物（テストで差し替える） */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PROGRESS_KEY = 'studio-m-learn-progress-v1';

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 保存された JSON を安全な形に直す（壊れた項目は捨てる） */
export function sanitizeProgress(raw: unknown): ProgressMap {
  const out: ProgressMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const entry: LessonProgress = { done: o.done === true };
    if (typeof o.step === 'number' && Number.isFinite(o.step) && o.step >= 0) entry.step = Math.floor(o.step);
    if (typeof o.completedSteps === 'number' && Number.isFinite(o.completedSteps) && o.completedSteps >= 0) entry.completedSteps = Math.floor(o.completedSteps);
    if (typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt)) entry.updatedAt = o.updatedAt;
    out[id] = entry;
  }
  return out;
}

export function loadProgress(storage: StorageLike | null = defaultStorage()): ProgressMap {
  if (!storage) return {};
  try {
    const text = storage.getItem(PROGRESS_KEY);
    return text ? sanitizeProgress(JSON.parse(text)) : {};
  } catch {
    return {};
  }
}

/** 保存できたら true。保存できない環境（プライベートウィンドウなど）では false で、画面はそのまま動く */
export function saveProgress(map: ProgressMap, storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PROGRESS_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/** 1 つのレッスンの進み具合を更新した新しい辞書を返す（元は変えない）。done は一度 true になったら戻さない */
export function updateLessonProgress(map: ProgressMap, lessonId: string, patch: Partial<LessonProgress>, now: number = Date.now()): ProgressMap {
  const prev = map[lessonId];
  const next: LessonProgress = { ...prev, ...patch, done: (prev?.done ?? false) || patch.done === true, updatedAt: now };
  return { ...map, [lessonId]: next };
}

/** 終えたレッスンの数 */
export function countDone(map: ProgressMap, lessonIds: string[]): number {
  return lessonIds.filter((id) => map[id]?.done).length;
}

/** 次に進めるレッスン（順番の中で、まだ終えていない最初のもの）。全部終えたら null */
export function nextLessonId(map: ProgressMap, orderedIds: string[]): string | null {
  return orderedIds.find((id) => !map[id]?.done) ?? null;
}
