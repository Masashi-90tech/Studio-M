import { describe, expect, it } from 'vitest';
import { defaultProject } from '../core/project';
import { DEFAULT_PREFS, hasProSettings, initialMode, parseUiState } from './modes';

describe('initialMode', () => {
  it('保存済みのモードを優先し、なければ初めての人は かんたん、保存プロジェクトがあれば 標準', () => {
    expect(initialMode('pro', false)).toBe('pro');
    expect(initialMode(undefined, false)).toBe('easy');
    expect(initialMode(undefined, true)).toBe('standard');
  });
});

describe('parseUiState', () => {
  it('壊れた・空の保存データは既定値', () => {
    expect(parseUiState(null)).toEqual({ prefs: DEFAULT_PREFS });
    expect(parseUiState('not json')).toEqual({ prefs: DEFAULT_PREFS });
    expect(parseUiState('[]')).toEqual({ prefs: DEFAULT_PREFS });
  });
  it('正しい値だけ取り込む', () => {
    const s = parseUiState(JSON.stringify({ mode: 'pro', prefs: { safetyTarget: 3, stressGoal: 'bend', emGoal: 'reflect' } }));
    expect(s).toEqual({ mode: 'pro', prefs: { safetyTarget: 3, stressGoal: 'bend', emGoal: 'reflect' } });
    const bad = parseUiState(JSON.stringify({ mode: 'expert', prefs: { safetyTarget: -1, stressGoal: 'x', emGoal: 3 } }));
    expect(bad.mode).toBeUndefined();
    expect(bad.prefs).toEqual(DEFAULT_PREFS);
  });
});

describe('hasProSettings', () => {
  it('既定のプロジェクトでは false', () => {
    expect(hasProSettings(defaultProject())).toBe(false);
  });
  it('格子を手動にすると true', () => {
    const p = defaultProject();
    p.domain.autoGrid = false;
    expect(hasProSettings(p)).toBe(true);
  });
  it('advanced の項目が 1 つでもあれば true、空や undefined だけなら false', () => {
    const p = defaultProject();
    p.flow.advanced = {};
    expect(hasProSettings(p)).toBe(false);
    p.flow.advanced = { latticeU: undefined };
    expect(hasProSettings(p)).toBe(false);
    p.flow.advanced = { smagorinskyCs: 0 };
    expect(hasProSettings(p)).toBe(true);
    const q = defaultProject();
    q.em.advanced = { pmlCells: 20 };
    expect(hasProSettings(q)).toBe(true);
    const r = defaultProject();
    r.scalar.advanced = { scheme: 'upwind' };
    expect(hasProSettings(r)).toBe(true);
  });
});
