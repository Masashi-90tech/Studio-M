import { describe, expect, it, vi } from 'vitest';
import { defaultProject } from '../core/project';
import type { ResultSet } from '../core/types';
import { RemoteResults } from './remote-results';
import { Runner } from './runner';
import { Store } from './state';

function rs(analysis: ResultSet['analysis'], value = 1): ResultSet {
  return { analysis, nx: 1, ny: 1, h: 1, fields: [], scalars: [{ key: 'a', label: 'A', unit: '', value }], history: [], warnings: [] };
}

describe('RemoteResults（古くなった結果の扱い）', () => {
  it('同じ revision の結果だけを返し、label を付ける', () => {
    const r = new RemoteResults();
    r.set({ kind: 'stress', result: rs('stress'), rev: 2, label: 'CalculiX 本計算' });
    expect(r.get('stress', 2)?.result.label).toBe('CalculiX 本計算');
    expect(r.get('stress', 3)).toBeNull();
    expect(r.isStale('stress', 3)).toBe(true);
    expect(r.isStale('stress', 2)).toBe(false);
    expect(r.isStale('heat', 2)).toBe(false);
    expect(r.valid(2)).toHaveLength(1);
    expect(r.valid(3)).toHaveLength(0);
    r.clear('stress');
    expect(r.get('stress', 2)).toBeNull();
  });
});

describe('Runner の本計算の結果', () => {
  function setup() {
    vi.useFakeTimers();
    (globalThis as unknown as { window: unknown }).window = globalThis;
    const store = new Store(defaultProject());
    store.analysis = 'stress';
    const runner = new Runner(store);
    const lite = rs('stress', 10);
    (runner as unknown as { lite: ResultSet }).lite = lite;
    return { store, runner, lite };
  }

  it('本計算を表示すると result / status が本計算になり、Lite に戻せる。Lite は止まる', () => {
    const { runner, lite } = setup();
    runner.setRemote({ kind: 'stress', result: rs('stress', 11), label: 'CalculiX 本計算', rev: runner.revision, show: true });
    expect(runner.viewingRemote).toBe(true);
    expect(runner.result?.scalars[0].value).toBe(11);
    expect(runner.result?.label).toBe('CalculiX 本計算');
    expect(runner.status).toMatchObject({ done: true, progress: 1 });
    expect(runner.liteResult).toBe(lite);
    runner.showRemote(false);
    expect(runner.result).toBe(lite);
    expect(runner.viewingRemote).toBe(false);
    runner.showRemote(true);
    expect(runner.result?.scalars[0].value).toBe(11);
    vi.useRealTimers();
  });

  it('形や条件が変わると本計算の結果は古くなり、表示は Lite に戻る', () => {
    const { runner, store, lite } = setup();
    runner.setRemote({ kind: 'stress', result: rs('stress', 11), label: 'X', rev: runner.revision, show: true });
    const v = runner.resultVersion;
    store.emit('project', 'canvas');
    expect(runner.viewingRemote).toBe(false);
    expect(runner.result).toBe(lite);
    expect(runner.currentRemote()).toBeNull();
    expect(runner.remote.isStale('stress', runner.revision)).toBe(true);
    runner.showRemote(true); // 古い結果は表示できない
    expect(runner.viewingRemote).toBe(false);
    expect(runner.resultVersion).toBeGreaterThanOrEqual(v);
    vi.useRealTimers();
  });

  it('本計算の格子が Lite と違っても、そのまま表示でき、Raster は合うときだけ渡す', () => {
    const { runner } = setup();
    (runner as unknown as { raster: unknown }).raster = { nx: 1, ny: 1 };
    expect(runner.shownRaster).not.toBeNull();
    const fine = { ...rs('stress', 11), nx: 3, ny: 2, h: 0.5 };
    runner.setRemote({ kind: 'stress', result: fine, label: 'X', rev: runner.revision, show: true });
    expect(runner.result?.nx).toBe(3);
    expect(runner.shownRaster).toBeNull();
    vi.useRealTimers();
  });

  it('名前だけの変更では古くならない。計算中に変更があった結果は最初から古い', () => {
    const { runner, store } = setup();
    const rev = runner.revision;
    runner.setRemote({ kind: 'stress', result: rs('stress'), label: 'X', rev, show: true });
    store.emit('project', 'name');
    expect(runner.viewingRemote).toBe(true);
    store.emit('project', 'canvas');
    runner.setRemote({ kind: 'stress', result: rs('stress'), label: 'Y', rev, show: true }); // 古い revision で届いた
    expect(runner.currentRemote()).toBeNull();
    expect(runner.viewingRemote).toBe(false);
    vi.useRealTimers();
  });

  it('Excel 用の collectResults は、Lite の後に label つきの本計算を続け、古いものは入れない', () => {
    const { runner, store } = setup();
    runner.setRemote({ kind: 'stress', result: rs('stress', 11), label: 'CalculiX 本計算', rev: runner.revision });
    const out = runner.collectResults();
    expect(out.map((r) => r.label)).toEqual([undefined, 'CalculiX 本計算']);
    store.emit('project', 'canvas');
    expect(runner.collectResults().map((r) => r.label)).toEqual([undefined]);
    vi.useRealTimers();
  });
});
