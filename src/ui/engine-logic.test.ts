import { describe, expect, it } from 'vitest';
import type { EngineStatus } from '../core/engine-protocol';
import type { ResultSet } from '../core/types';
import { capabilitiesFor, compareScalars, engineName, estimateEngineSeconds, formatBytes, formatDiffPct, formatDuration, formatElapsed, isCurrentRun, isEngineRunRecord, recordEngineRun, type EngineRunRecord } from './engine-logic';

function rs(scalars: [string, number][]): ResultSet {
  return { analysis: 'stress', nx: 1, ny: 1, h: 1, fields: [], scalars: scalars.map(([key, value]) => ({ key, label: key.toUpperCase(), unit: 'Pa', value })), history: [], warnings: [] };
}

describe('compareScalars', () => {
  it('共通の key だけを Lite の並び順で比べ、差を % で出す', () => {
    const rows = compareScalars(rs([['a', 100], ['b', 5], ['only-lite', 1]]), rs([['b', 5.5], ['a', 110], ['only-remote', 2]]));
    expect(rows.map((r) => r.key)).toEqual(['a', 'b']);
    expect(rows[0]).toMatchObject({ lite: 100, remote: 110 });
    expect(rows[0].diffPct).toBeCloseTo(10);
    expect(rows[1].diffPct).toBeCloseTo(10);
  });
  it('Lite が 0 や数でないときは差を出さない（null）。負の値は絶対値で割る', () => {
    const rows = compareScalars(rs([['z', 0], ['n', NaN], ['neg', -10]]), rs([['z', 3], ['n', 1], ['neg', -9]]));
    expect(rows.find((r) => r.key === 'z')?.diffPct).toBeNull();
    expect(rows.find((r) => r.key === 'n')?.diffPct).toBeNull();
    expect(rows.find((r) => r.key === 'neg')?.diffPct).toBeCloseTo(10);
  });
  it('どちらかがなければ空', () => {
    expect(compareScalars(null, rs([['a', 1]]))).toEqual([]);
    expect(compareScalars(rs([['a', 1]]), null)).toEqual([]);
  });
});

describe('表示用の整形', () => {
  it('差の表示', () => {
    expect(formatDiffPct(2.345)).toBe('+2.35 %');
    expect(formatDiffPct(-12.34)).toBe('−12.3 %');
    expect(formatDiffPct(250)).toBe('+250 %');
    expect(formatDiffPct(0.0001)).toBe('±0 %');
    expect(formatDiffPct(null)).toBe('—');
    expect(formatDiffPct(Infinity)).toBe('—');
  });
  it('バイト数', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('能力の選び方と無効化', () => {
  const status: EngineStatus = {
    server: 'studio-m-engine', protocol: 1, version: '1', maxConcurrentJobs: 1,
    engines: [{ id: 'calculix', name: 'CalculiX', available: true, via: 'native', license: 'GPL-2.0' }],
    capabilities: [{ analysis: 'stress', engine: 'calculix', label: 'a' }, { analysis: 'heat', engine: 'calculix', label: 'b' }, { analysis: 'flow', engine: 'openfoam', label: 'c' }],
  };
  it('解析ごとの capability を、サーバーの返事から選ぶ', () => {
    expect(capabilitiesFor(status, 'stress').map((c) => c.label)).toEqual(['a']);
    expect(capabilitiesFor(status, 'em')).toEqual([]);
    expect(capabilitiesFor(null, 'stress')).toEqual([]);
    expect(engineName(status, 'calculix')).toBe('CalculiX');
    expect(engineName(status, 'openfoam')).toBe('openfoam');
  });
  it('本計算の結果は、始めたときの revision と今の revision が同じときだけ有効', () => {
    expect(isCurrentRun({ runRev: 3, currentRev: 3 })).toBe(true);
    expect(isCurrentRun({ runRev: 3, currentRev: 4 })).toBe(false);
  });
});

describe('所要時間の目安', () => {
  const rec = (over: Partial<EngineRunRecord> = {}): EngineRunRecord => ({ analysis: 'stress', engine: 'calculix', cells: 10000, quality: 'draft', seconds: 10, at: 1, ...over });

  it('実績がなければ既定の目安（CalculiX は 1 万セルあたり 1 秒・最低 2 秒、OpenFOAM は 30 秒・最低 20 秒）', () => {
    expect(estimateEngineSeconds({ analysis: 'stress', engine: 'calculix', cells: 10000, quality: 'draft' })).toEqual({ seconds: 2, basis: 'default' });
    expect(estimateEngineSeconds({ analysis: 'stress', engine: 'calculix', cells: 100000, quality: 'draft' })?.seconds).toBeCloseTo(10);
    expect(estimateEngineSeconds({ analysis: 'flow', engine: 'openfoam', cells: 1000, quality: 'draft' })?.seconds).toBeCloseTo(20);
    expect(estimateEngineSeconds({ analysis: 'flow', engine: 'openfoam', cells: 100000, quality: 'draft' })?.seconds).toBeCloseTo(300);
  });
  it('細かさの倍率: standard はセル数 1.5²（約 2.25 倍）、fine は 2²（4 倍）。省略時は standard', () => {
    const base = estimateEngineSeconds({ analysis: 'stress', engine: 'calculix', cells: 100000, quality: 'draft' })?.seconds ?? NaN;
    expect(estimateEngineSeconds({ analysis: 'stress', engine: 'calculix', cells: 100000, quality: 'standard' })?.seconds).toBeCloseTo(base * 2.25);
    expect(estimateEngineSeconds({ analysis: 'stress', engine: 'calculix', cells: 100000, quality: 'fine' })?.seconds).toBeCloseTo(base * 4);
    expect(estimateEngineSeconds({ analysis: 'stress', engine: 'calculix', cells: 100000 })?.seconds).toBeCloseTo(base * 2.25);
  });
  it('目安を出せないとき（セル数が 0 や不正、既定の目安がないエンジン）は null', () => {
    expect(estimateEngineSeconds({ analysis: 'stress', engine: 'calculix', cells: 0 })).toBeNull();
    expect(estimateEngineSeconds({ analysis: 'stress', engine: 'calculix', cells: NaN })).toBeNull();
    expect(estimateEngineSeconds({ analysis: 'stress', engine: 'gmsh', cells: 1000 })).toBeNull();
  });
  it('実績があれば、いちばん近い実績から セル数^1.2 で換算する（basis: history）', () => {
    const h = [rec({ cells: 1000, seconds: 1 }), rec({ cells: 100000, seconds: 50 })];
    const e = estimateEngineSeconds({ analysis: 'stress', engine: 'calculix', cells: 90000, quality: 'draft', history: h });
    expect(e?.basis).toBe('history');
    expect(e?.seconds).toBeCloseTo(50 * Math.pow(0.9, 1.2));
    const up = estimateEngineSeconds({ analysis: 'stress', engine: 'calculix', cells: 40000, quality: 'draft', history: [rec({ seconds: 10 })] });
    expect(up?.seconds).toBeCloseTo(10 * Math.pow(4, 1.2));
  });
  it('実績は細かさをそろえて換算する（standard の 2.25 倍のセル数は、draft の同じ実効セル数と同じ）', () => {
    const h = [rec({ cells: 10000, quality: 'standard', seconds: 30 })];
    expect(estimateEngineSeconds({ analysis: 'stress', engine: 'calculix', cells: 22500, quality: 'draft', history: h })?.seconds).toBeCloseTo(30);
  });
  it('別の解析・別のエンジンの実績は使わない。壊れた実績も無視する', () => {
    const h = [rec({ analysis: 'heat' }), rec({ engine: 'openfoam' }), { ...rec(), seconds: NaN }, { bogus: true } as unknown as EngineRunRecord];
    expect(estimateEngineSeconds({ analysis: 'stress', engine: 'calculix', cells: 10000, quality: 'draft', history: h })?.basis).toBe('default');
  });
});

describe('時間の表示', () => {
  it('目安の表示は細かく丸める', () => {
    expect(formatDuration(5)).toBe('約 5 秒');
    expect(formatDuration(0.2)).toBe('約 1 秒');
    expect(formatDuration(59.6)).toBe('約 1 分');
    expect(formatDuration(120)).toBe('約 2 分');
    expect(formatDuration(4200)).toBe('約 1 時間 10 分');
    expect(formatDuration(3600)).toBe('約 1 時間');
    expect(formatDuration(NaN)).toBe('—');
  });
  it('経過時間の表示', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(42000)).toBe('0:42');
    expect(formatElapsed(725000)).toBe('12:05');
    expect(formatElapsed(3723000)).toBe('1:02:03');
    expect(formatElapsed(-5)).toBe('0:00');
  });
});

describe('実績の記録', () => {
  const rec = (i: number, engine: EngineRunRecord['engine'] = 'calculix'): EngineRunRecord => ({ analysis: 'stress', engine, cells: 1000 + i, quality: 'draft', seconds: 1 + i, at: i });

  it('新しい記録を先頭に足し、同じ解析・エンジンは 10 件までに切り詰める', () => {
    let list: EngineRunRecord[] = [rec(0, 'openfoam')];
    for (let i = 1; i <= 12; i++) list = recordEngineRun(list, rec(i));
    const calc = list.filter((r) => r.engine === 'calculix');
    expect(calc).toHaveLength(10);
    expect(calc[0].at).toBe(12);
    expect(calc[9].at).toBe(3);
    expect(list.filter((r) => r.engine === 'openfoam')).toHaveLength(1);
  });
  it('壊れた実績を見分ける', () => {
    expect(isEngineRunRecord(rec(1))).toBe(true);
    expect(isEngineRunRecord({ ...rec(1), analysis: 'nope' })).toBe(false);
    expect(isEngineRunRecord({ ...rec(1), seconds: 0 })).toBe(false);
    expect(isEngineRunRecord({ ...rec(1), quality: 'constructor' })).toBe(false);
    expect(isEngineRunRecord(null)).toBe(false);
  });
});
