// 学びモードの画面側の純粋なロジック（DOM に触れない）: 更新の間引き、数学の窓の開閉の保存、学ぶドロワーの状態。
// 学びモード本体（src/learn）は使うときに遅延 import されるので、ここには型以外の import を置かない。
import type { ResultSet, SolverStatus } from '../core/types';
import type { UiMode } from './modes';

// ---------- 更新の間引き ----------

/** 一定時間ごとにだけ true を返す門。force を渡すと間隔に関係なく通す */
export interface Gate {
  pass(now: number, force?: boolean): boolean;
  reset(): void;
}

export function createGate(intervalMs: number): Gate {
  let last = Number.NEGATIVE_INFINITY;
  return {
    pass(now, force = false) {
      if (!force && now - last < intervalMs) return false;
      last = now;
      return true;
    },
    reset() {
      last = Number.NEGATIVE_INFINITY;
    },
  };
}

/** 数学の窓・レッスンの確認の更新間隔 [ms]（約 4 Hz） */
export const LEARN_UPDATE_MS = 250;

// ---------- 学びモードに渡す結果 ----------

/**
 * 学びモードに渡す結果。ソルバーを作った直後の「まだ 1 度も進めていない」結果は、
 * 古い結果や空の結果と見分けがつかないので null にする（レッスンの確認が空振りしないように）
 */
export function resultForLearning(opts: { result: ResultSet | null; status: SolverStatus | null }): ResultSet | null {
  return opts.status ? opts.result : null;
}

// ---------- 数学の窓の開閉（閲覧者ごとに記憶） ----------

export const MATH_OPEN_KEY = 'studio-m-lite:math-window-open:v1';

/** localStorage と同じ形の最小限の入れ物（テストで差し替える） */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 保存された文字列 → 開いていたか。保存がない・壊れているときは undefined（まだ選んでいない） */
export function parseMathOpen(text: string | null): boolean | undefined {
  return text === '1' ? true : text === '0' ? false : undefined;
}

export function loadMathOpen(storage: StorageLike | null = defaultStorage()): boolean | undefined {
  if (!storage) return undefined;
  try {
    return parseMathOpen(storage.getItem(MATH_OPEN_KEY));
  } catch {
    return undefined;
  }
}

/** 保存できたら true。保存できない環境（プライベートウィンドウなど）では false で、画面はそのまま動く */
export function saveMathOpen(open: boolean, storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(MATH_OPEN_KEY, open ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/** 開いて始めるか。自分で開閉したことがあればそれを優先し、なければモード次第（かんたんは開く、ほかは閉じる） */
export function resolveMathOpen(opts: { saved: boolean | undefined; mode: UiMode }): boolean {
  return opts.saved ?? opts.mode === 'easy';
}

// ---------- 学ぶドロワー ----------

export interface DrawerState {
  open: boolean;
  /** 開いているレッスン（null なら一覧）。閉じても残して、開き直したら続きから見られるようにする */
  lessonId: string | null;
}

export const INITIAL_DRAWER: DrawerState = { open: false, lessonId: null };

/** 開く。lessonId を渡すとそのレッスンを開く（省略時は前回の続き） */
export function openDrawer(s: DrawerState, lessonId?: string): DrawerState {
  return { open: true, lessonId: lessonId ?? s.lessonId };
}
export function closeDrawer(s: DrawerState): DrawerState {
  return s.open ? { ...s, open: false } : s;
}
export function toggleDrawer(s: DrawerState): DrawerState {
  return s.open ? closeDrawer(s) : openDrawer(s);
}
/** レッスンの一覧へ戻る */
export function backToList(s: DrawerState): DrawerState {
  return s.lessonId === null ? s : { ...s, lessonId: null };
}
export function drawerView(s: DrawerState): 'list' | 'lesson' {
  return s.lessonId === null ? 'list' : 'lesson';
}

/**
 * ドロワーの置き方。
 *  - push: 広い画面。右に 420px の列を足して、キャンバスも側のパネルも隠さない
 *  - overlay: 中くらいの画面。右に重ねる（側のパネルを隠す）
 *  - sheet: スマホ。画面いっぱいのシート（閉じるとキャンバスに戻る）
 */
export type DrawerLayout = 'push' | 'overlay' | 'sheet';
export const SHEET_MAX_WIDTH = 860;
export const PUSH_MIN_WIDTH = 1180;
export function drawerLayout(width: number): DrawerLayout {
  return width <= SHEET_MAX_WIDTH ? 'sheet' : width >= PUSH_MIN_WIDTH ? 'push' : 'overlay';
}
/** 数学の窓を見に行くとき、ドロワーが邪魔になるか（push 以外は側のパネルや画面を覆う） */
export const drawerCoversMath = (layout: DrawerLayout): boolean => layout !== 'push';

// ---------- 「この例で学ぶ」の案内 ----------

export const chipText = (minutes: number): string => `この例で学ぶ（約${minutes}分）`;

/** 案内を出すか: そのレッスンがあり、プリセットを開いたまま（編集していない）で、まだ案内を使っていないとき */
export function chipVisible(opts: { hasLesson: boolean; edited: boolean; dismissed: boolean }): boolean {
  return opts.hasLesson && !opts.edited && !opts.dismissed;
}
