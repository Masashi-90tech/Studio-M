import { describe, expect, it, vi } from 'vitest';
import { PROGRESS_KEY } from '../learn/progress';
import {
  LEARN_ENABLED_KEY,
  LEARN_HINT_KEY,
  LEARN_PROGRESS_KEY,
  createLearnSwitch,
  hasLearnProgress,
  loadLearnEnabled,
  loadWhenEnabled,
  parseLearnEnabled,
  saveLearnEnabled,
  shouldHintLearn,
  takeLearnHint,
  type StorageLike,
} from './learn-pref';

function memory(init: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}
const broken: StorageLike = {
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('blocked');
  },
};

describe('学習機能の表示設定の保存', () => {
  it('保存がないときや壊れているときは OFF（既定）', () => {
    expect(parseLearnEnabled(null)).toBe(false);
    expect(parseLearnEnabled('')).toBe(false);
    expect(parseLearnEnabled('yes')).toBe(false);
    expect(loadLearnEnabled(memory())).toBe(false);
    expect(loadLearnEnabled(null)).toBe(false);
  });

  it('保存した値を読み戻せる', () => {
    const st = memory();
    expect(saveLearnEnabled(true, st)).toBe(true);
    expect(st.data[LEARN_ENABLED_KEY]).toBe('1');
    expect(loadLearnEnabled(st)).toBe(true);
    saveLearnEnabled(false, st);
    expect(loadLearnEnabled(st)).toBe(false);
  });

  it('localStorage が使えない環境でも例外を出さない', () => {
    expect(loadLearnEnabled(broken)).toBe(false);
    expect(saveLearnEnabled(true, broken)).toBe(false);
    expect(saveLearnEnabled(true, null)).toBe(false);
    expect(hasLearnProgress(broken)).toBe(false);
    expect(takeLearnHint({ enabled: false, storage: broken })).toBe(false);
  });
});

describe('以前の学習記録がある人への案内', () => {
  it('進み具合の保存先は src/learn/progress.ts と同じ', () => {
    expect(LEARN_PROGRESS_KEY).toBe(PROGRESS_KEY);
  });

  it('記録の有無: 空・壊れたデータは「ない」', () => {
    expect(hasLearnProgress(memory())).toBe(false);
    expect(hasLearnProgress(memory({ [LEARN_PROGRESS_KEY]: '{}' }))).toBe(false);
    expect(hasLearnProgress(memory({ [LEARN_PROGRESS_KEY]: 'not json' }))).toBe(false);
    expect(hasLearnProgress(memory({ [LEARN_PROGRESS_KEY]: '{"cantilever":{"done":true}}' }))).toBe(true);
  });

  it('OFF・記録あり・まだ案内していないときだけ案内する', () => {
    expect(shouldHintLearn({ enabled: false, hasProgress: true, hinted: false })).toBe(true);
    expect(shouldHintLearn({ enabled: true, hasProgress: true, hinted: false })).toBe(false);
    expect(shouldHintLearn({ enabled: false, hasProgress: false, hinted: false })).toBe(false);
    expect(shouldHintLearn({ enabled: false, hasProgress: true, hinted: true })).toBe(false);
  });

  it('案内は 1 回だけ（出したら記録する）', () => {
    const st = memory({ [LEARN_PROGRESS_KEY]: '{"a":{"done":false,"step":1}}' });
    expect(takeLearnHint({ enabled: false, storage: st })).toBe(true);
    expect(st.data[LEARN_HINT_KEY]).toBe('1');
    expect(takeLearnHint({ enabled: false, storage: st })).toBe(false);
  });

  it('記録がない人・すでに ON の人には出さない（既定は OFF のまま）', () => {
    expect(takeLearnHint({ enabled: false, storage: memory() })).toBe(false);
    expect(takeLearnHint({ enabled: true, storage: memory({ [LEARN_PROGRESS_KEY]: '{"a":{"done":true}}' }) })).toBe(false);
  });
});

describe('切り替えの状態（OFF のあいだは何も読み込まない）', () => {
  it('変わったときだけ知らせる。同じ値は何もしない', () => {
    const sw = createLearnSwitch({ initial: false });
    const seen: boolean[] = [];
    const off = sw.subscribe((v) => seen.push(v));
    expect(sw.get()).toBe(false);
    expect(sw.set(false)).toBe(false);
    expect(sw.set(true)).toBe(true);
    expect(sw.set(true)).toBe(false);
    expect(sw.set(false)).toBe(true);
    expect(seen).toEqual([true, false]);
    off();
    sw.set(true);
    expect(seen).toEqual([true, false]);
  });

  it('OFF のあいだは読み込み関数を呼ばない。ON にすると呼ぶ', async () => {
    const sw = createLearnSwitch({ initial: false });
    const load = vi.fn(async () => 'learn-chunk');
    expect(await loadWhenEnabled(sw, load)).toBeNull();
    expect(await loadWhenEnabled(sw, load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
    sw.set(true);
    expect(await loadWhenEnabled(sw, load)).toBe('learn-chunk');
    expect(load).toHaveBeenCalledTimes(1);
    sw.set(false);
    expect(await loadWhenEnabled(sw, load)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
