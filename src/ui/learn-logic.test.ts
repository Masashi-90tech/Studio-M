import { describe, expect, it } from 'vitest';
import type { ResultSet, SolverStatus } from '../core/types';
import {
  INITIAL_DRAWER,
  MATH_OPEN_KEY,
  backToList,
  chipText,
  chipVisible,
  closeDrawer,
  createGate,
  drawerCoversMath,
  drawerLayout,
  drawerView,
  loadMathOpen,
  openDrawer,
  parseMathOpen,
  resolveMathOpen,
  resultForLearning,
  saveMathOpen,
  toggleDrawer,
  type StorageLike,
} from './learn-logic';
import { openPreset } from './open-preset';
import { PRESETS } from './presets';
import { Store } from './state';

function memory(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}
const broken: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('createGate（更新の間引き）', () => {
  it('最初は通し、間隔内は止め、間隔が過ぎたら通す', () => {
    const g = createGate(250);
    expect(g.pass(0)).toBe(true);
    expect(g.pass(100)).toBe(false);
    expect(g.pass(249)).toBe(false);
    expect(g.pass(250)).toBe(true);
    expect(g.pass(300)).toBe(false);
  });
  it('force は間隔に関係なく通し、その時刻から数え直す', () => {
    const g = createGate(250);
    g.pass(0);
    expect(g.pass(10, true)).toBe(true);
    expect(g.pass(200)).toBe(false);
    expect(g.pass(260)).toBe(true);
  });
  it('4 Hz 相当: 1 秒間 60 フレームで呼んでも通るのは 4 回以下', () => {
    const g = createGate(250);
    let n = 0;
    for (let t = 0; t < 1000; t += 1000 / 60) if (g.pass(t)) n++;
    expect(n).toBeLessThanOrEqual(4);
    expect(n).toBeGreaterThanOrEqual(3);
  });
  it('reset すると次はすぐ通る', () => {
    const g = createGate(250);
    g.pass(0);
    g.reset();
    expect(g.pass(1)).toBe(true);
  });
});

describe('resultForLearning', () => {
  const result = { analysis: 'x' } as unknown as ResultSet;
  it('1 度も進めていない（status なし）結果は null にする', () => {
    expect(resultForLearning({ result, status: null })).toBeNull();
  });
  it('進めた後は結果をそのまま返す。結果がなければ null', () => {
    const status: SolverStatus = { done: false, progress: 0.1, iteration: 1 };
    expect(resultForLearning({ result, status })).toBe(result);
    expect(resultForLearning({ result: null, status })).toBeNull();
  });
});

describe('数学の窓の開閉の記憶', () => {
  it('保存の文字列を読む（壊れていれば未選択）', () => {
    expect(parseMathOpen('1')).toBe(true);
    expect(parseMathOpen('0')).toBe(false);
    expect(parseMathOpen(null)).toBeUndefined();
    expect(parseMathOpen('yes')).toBeUndefined();
  });
  it('保存して読み戻せる', () => {
    const s = memory();
    expect(loadMathOpen(s)).toBeUndefined();
    expect(saveMathOpen(true, s)).toBe(true);
    expect(s.data[MATH_OPEN_KEY]).toBe('1');
    expect(loadMathOpen(s)).toBe(true);
    saveMathOpen(false, s);
    expect(loadMathOpen(s)).toBe(false);
  });
  it('localStorage が使えなくても例外にならない', () => {
    expect(loadMathOpen(broken)).toBeUndefined();
    expect(saveMathOpen(true, broken)).toBe(false);
    expect(loadMathOpen(null)).toBeUndefined();
    expect(saveMathOpen(true, null)).toBe(false);
  });
  it('既定: かんたんは開く、標準・プロは閉じる。自分で選んだ値が優先', () => {
    expect(resolveMathOpen({ saved: undefined, mode: 'easy' })).toBe(true);
    expect(resolveMathOpen({ saved: undefined, mode: 'standard' })).toBe(false);
    expect(resolveMathOpen({ saved: undefined, mode: 'pro' })).toBe(false);
    expect(resolveMathOpen({ saved: false, mode: 'easy' })).toBe(false);
    expect(resolveMathOpen({ saved: true, mode: 'pro' })).toBe(true);
  });
});

describe('学ぶドロワーの状態', () => {
  it('開く → レッスンを開く → 閉じても、開き直すと続きのレッスンのまま', () => {
    let s = openDrawer(INITIAL_DRAWER);
    expect(s).toEqual({ open: true, lessonId: null });
    expect(drawerView(s)).toBe('list');
    s = openDrawer(s, 'cantilever');
    expect(drawerView(s)).toBe('lesson');
    s = closeDrawer(s);
    expect(s).toEqual({ open: false, lessonId: 'cantilever' });
    s = openDrawer(s);
    expect(s).toEqual({ open: true, lessonId: 'cantilever' });
  });
  it('一覧へ戻ると lessonId が外れる。すでに一覧なら同じ状態を返す', () => {
    const s = { open: true, lessonId: 'karman' };
    expect(backToList(s)).toEqual({ open: true, lessonId: null });
    expect(backToList(INITIAL_DRAWER)).toBe(INITIAL_DRAWER);
  });
  it('toggle', () => {
    expect(toggleDrawer(INITIAL_DRAWER).open).toBe(true);
    expect(toggleDrawer(toggleDrawer(INITIAL_DRAWER)).open).toBe(false);
  });
  it('置き方: 幅で sheet / overlay / push が決まる', () => {
    expect(drawerLayout(390)).toBe('sheet');
    expect(drawerLayout(860)).toBe('sheet');
    expect(drawerLayout(861)).toBe('overlay');
    expect(drawerLayout(1179)).toBe('overlay');
    expect(drawerLayout(1180)).toBe('push');
    expect(drawerLayout(1400)).toBe('push');
    expect(drawerCoversMath('push')).toBe(false);
    expect(drawerCoversMath('overlay')).toBe(true);
    expect(drawerCoversMath('sheet')).toBe(true);
  });
});

describe('「この例で学ぶ」の案内', () => {
  it('文言に分数が入る', () => {
    expect(chipText(12)).toBe('この例で学ぶ（約12分）');
  });
  it('レッスンがあり、編集しておらず、まだ使っていないときだけ出す', () => {
    expect(chipVisible({ hasLesson: true, edited: false, dismissed: false })).toBe(true);
    expect(chipVisible({ hasLesson: false, edited: false, dismissed: false })).toBe(false);
    expect(chipVisible({ hasLesson: true, edited: true, dismissed: false })).toBe(false);
    expect(chipVisible({ hasLesson: true, edited: false, dismissed: true })).toBe(false);
  });
});

describe('プリセットを開く（メニューとドロワー共通の経路）', () => {
  const preset = PRESETS[1];
  it('解析タブが切り替わり、presetId が残り、元に戻せる。元に戻すと presetId は消える', () => {
    const store = new Store(PRESETS[0].build());
    const before = JSON.stringify(store.project);
    const events: string[] = [];
    store.on('load', () => events.push(`load:${store.presetId}`));
    const opened = openPreset({ store, presetId: preset.id, notify: false });
    expect(opened?.id).toBe(preset.id);
    expect(store.analysis).toBe(preset.analysis);
    expect(store.presetId).toBe(preset.id);
    expect(events).toEqual([`load:${preset.id}`]); // 'load' を受けた時点で presetId は入っている
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect(JSON.stringify(store.project)).toBe(before);
    expect(store.presetId).toBeNull();
  });
  it('知らない id は何もしない', () => {
    const store = new Store(PRESETS[0].build());
    expect(openPreset({ store, presetId: 'nothing', notify: false })).toBeNull();
    expect(store.presetId).toBeNull();
    expect(store.canUndo()).toBe(false);
  });
  it('loadProject（新規・ファイル）では presetId が外れる', () => {
    const store = new Store(PRESETS[0].build());
    openPreset({ store, presetId: preset.id, notify: false });
    store.newProject();
    expect(store.presetId).toBeNull();
  });
});
