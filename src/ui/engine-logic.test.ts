import { describe, expect, it } from 'vitest';
import type { EngineStatus } from '../core/engine-protocol';
import type { ResultSet } from '../core/types';
import { capabilitiesFor, compareScalars, engineName, formatBytes, formatDiffPct, isCurrentRun } from './engine-logic';

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
