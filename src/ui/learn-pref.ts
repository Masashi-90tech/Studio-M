// 学習機能（数学の窓・学ぶ）の表示切り替え。既定は OFF。閲覧者ごとにブラウザへ保存する。
// 学びモード本体（src/learn）は ON のときだけ読み込む。ここには DOM も src/learn の import も置かない。

/** localStorage と同じ形の最小限の入れ物（テストで差し替える） */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LEARN_ENABLED_KEY = 'studio-m-lite:learn-enabled:v1';
/** 「設定から表示できます」の案内を出し済みか */
export const LEARN_HINT_KEY = 'studio-m-lite:learn-hint:v1';
/** 学びの進み具合の保存先（src/learn/progress.ts の PROGRESS_KEY と同じ値。learn-pref.test.ts が一致を確かめる） */
export const LEARN_PROGRESS_KEY = 'studio-m-learn-progress-v1';

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 保存された文字列 → 表示するか。保存がない・壊れているときは false（既定は OFF） */
export function parseLearnEnabled(text: string | null): boolean {
  return text === '1';
}

export function loadLearnEnabled(storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    return parseLearnEnabled(storage.getItem(LEARN_ENABLED_KEY));
  } catch {
    return false;
  }
}

/** 保存できたら true。保存できない環境でも画面はそのまま動く */
export function saveLearnEnabled(enabled: boolean, storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LEARN_ENABLED_KEY, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/** すでに学びの進み具合が保存されているか（中身が空の {} は「ない」とみなす） */
export function hasLearnProgress(storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    const text = storage.getItem(LEARN_PROGRESS_KEY);
    if (!text) return false;
    const raw: unknown = JSON.parse(text);
    return typeof raw === 'object' && raw !== null && Object.keys(raw).length > 0;
  } catch {
    return false;
  }
}

/** 「学習機能は設定から表示できます」の案内を出すか。OFF のまま・進み具合がある・まだ案内していないとき */
export function shouldHintLearn(opts: { enabled: boolean; hasProgress: boolean; hinted: boolean }): boolean {
  return !opts.enabled && opts.hasProgress && !opts.hinted;
}

/** 案内を出す必要があるか調べ、出すなら「出した」と記録して true を返す（1 回だけ） */
export function takeLearnHint(opts: { enabled: boolean; storage?: StorageLike | null }): boolean {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  if (!storage) return false;
  let hinted = false;
  try {
    hinted = storage.getItem(LEARN_HINT_KEY) === '1';
  } catch {
    return false;
  }
  if (!shouldHintLearn({ enabled: opts.enabled, hasProgress: hasLearnProgress(storage), hinted })) return false;
  try {
    storage.setItem(LEARN_HINT_KEY, '1');
  } catch {
    return false; // 記録できないと毎回出てしまうので、出さない
  }
  return true;
}

// ---------- 切り替えの状態 ----------

/** 学習機能の ON / OFF。数学の窓・学ぶドロワー・設定が同じものを見る */
export interface LearnSwitch {
  get(): boolean;
  /** 変えたら true。同じ値のときは何もしない */
  set(enabled: boolean): boolean;
  /** 変わったときに呼ばれる。戻り値で解除 */
  subscribe(fn: (enabled: boolean) => void): () => void;
}

export function createLearnSwitch(opts: { initial: boolean }): LearnSwitch {
  let on = opts.initial;
  const subs = new Set<(enabled: boolean) => void>();
  return {
    get: () => on,
    set(enabled) {
      if (enabled === on) return false;
      on = enabled;
      for (const fn of [...subs]) fn(on);
      return true;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/**
 * ON のときだけ load を呼んで結果を返す。OFF のときは load を呼ばず null
 * （学びモードの部品を読み込む import() は必ずここを通す。OFF のうちは何も読み込まない）
 */
export function loadWhenEnabled<T>(sw: Pick<LearnSwitch, 'get'>, load: () => Promise<T>): Promise<T | null> {
  return sw.get() ? load() : Promise.resolve(null);
}
