import { describe, expect, it } from 'vitest';
import type { EngineStatus, JobState } from '../../src/core/engine-protocol';
import type { ResultSet } from '../../src/core/types';
import { buildReport, buildSelftestJob, evaluateSelftest, exitCodeOf, parseSelftestArgs, SELFTEST_BEAM, theoryTipDeflection } from './selftest-logic';

const status = (available: boolean): EngineStatus => ({
  server: 'studio-m-engine',
  protocol: 1,
  version: '0.6.0',
  engines: [{ id: 'calculix', name: 'CalculiX', available, via: available ? 'native' : 'none', license: 'GPL-2.0', version: '2.23' }],
  capabilities: [],
  maxConcurrentJobs: 1,
});
const job = (tip: number, reaction: number, st: JobState['status'] = 'done'): JobState => ({
  id: 'j',
  analysis: 'stress',
  engine: 'calculix',
  status: st,
  progress: 1,
  message: '',
  log: [],
  startedAt: 0,
  result: { scalars: [{ key: 'maxDisplacement', value: tip }, { key: 'reaction', value: reaction }] } as unknown as ResultSet,
});

describe('parseSelftestArgs', () => {
  it('--selftest がなければ無効', () => expect(parseSelftestArgs(['app'])).toEqual({ enabled: false }));
  it('--out を読む', () => {
    expect(parseSelftestArgs(['app', '--selftest', '--out', 'a.json'])).toEqual({ enabled: true, out: 'a.json' });
    expect(parseSelftestArgs(['app', '--selftest'])).toEqual({ enabled: true });
  });
  it('--out の値がなければ誤り', () => {
    expect(parseSelftestArgs(['app', '--selftest', '--out']).error).toBeTruthy();
  });
});

describe('片持ち梁', () => {
  it('Project は solid・support・load を持ち、荷重は P の下向き', () => {
    const p = buildSelftestJob().project;
    expect(p.shapes.map((s) => s.role)).toEqual(['solid', 'support', 'load']);
    expect(p.shapes[2].force).toEqual({ fx: 0, fy: -SELFTEST_BEAM.P });
    expect(p.domain.autoGrid).toBe(false);
  });
  it('理論値は PL³/3EI に近い（有効長 0.985 m）', () => {
    const { L, H, T, E, P } = SELFTEST_BEAM;
    const full = (P * L ** 3) / (3 * E * ((T * H ** 3) / 12));
    expect(theoryTipDeflection() / full).toBeGreaterThan(0.94);
    expect(theoryTipDeflection() / full).toBeLessThan(1);
  });
});

describe('evaluateSelftest / buildReport', () => {
  const t = theoryTipDeflection();
  it('理論値どおりで荷重と釣り合えば全部合格', () => {
    const r = buildReport({ checks: evaluateSelftest({ status: status(true), job: job(t * 1.02, 100) }), ccxPath: '/x/ccx', status: status(true), os: 'test', appVersion: '0.6.0' });
    expect(r.ok).toBe(true);
    expect(exitCodeOf(r)).toBe(0);
  });
  it('たわみが 5% を超えてずれれば失敗', () => {
    const c = evaluateSelftest({ status: status(true), job: job(t * 1.1, 100) });
    expect(c.find((x) => x.id === 'tip-deflection')?.ok).toBe(false);
  });
  it('反力が荷重とずれれば失敗', () => {
    const c = evaluateSelftest({ status: status(true), job: job(t, 90) });
    expect(c.find((x) => x.id === 'reaction-balance')?.ok).toBe(false);
  });
  it('CalculiX が使えない・ジョブがない場合は失敗で、理由が日本語', () => {
    const c = evaluateSelftest({ status: status(false), job: null, jobError: 'CalculiX が使えないため、本計算を試しませんでした' });
    expect(c.every((x) => !x.ok)).toBe(true);
    expect(c[1].detail).toContain('CalculiX');
    expect(exitCodeOf(buildReport({ checks: c, ccxPath: null, status: status(false), os: 'test', appVersion: '0.6.0' }))).toBe(1);
  });
  it('ジョブが失敗なら、ログの末尾を含めて失敗', () => {
    const j = { ...job(0, 0, 'failed'), result: undefined, error: '入力が不正です', log: ['a', 'b'] };
    const c = evaluateSelftest({ status: status(true), job: j });
    expect(c.find((x) => x.id === 'job-done')?.detail).toContain('入力が不正です');
  });
});
