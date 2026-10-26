import { chooseGrid, MAX_CELLS, parseStressOptions, STRESS_OPTION_SPECS } from './options';
import { aluminumBeamPreset, steelBeam } from './test-projects';

describe('parseStressOptions', () => {
  it('省略時の既定値', () => {
    expect(parseStressOptions(undefined)).toEqual({
      plasticity: false,
      largeDeformation: false,
      elementType: 'auto',
      loadFactor: 1,
      hardeningPercent: 0,
    });
  });

  it('文字列で来ても読める。おかしな値は既定値に戻す', () => {
    const o = parseStressOptions({ plasticity: 'true', largeDeformation: 1, elementType: 'cps8r', loadFactor: '2.5', hardeningPercent: -3 });
    expect(o).toMatchObject({ plasticity: true, largeDeformation: true, elementType: 'CPS8R', loadFactor: 2.5, hardeningPercent: 0 });
    expect(parseStressOptions({ elementType: 'xyz', loadFactor: 'abc' })).toMatchObject({ elementType: 'auto', loadFactor: 1 });
  });

  it('画面に出す項目の既定値と、読み取りの既定値が揃っている', () => {
    const parsed = parseStressOptions(Object.fromEntries(STRESS_OPTION_SPECS.map((s) => [s.key, s.default])));
    expect(parsed).toEqual(parseStressOptions(undefined));
    expect(STRESS_OPTION_SPECS.map((s) => s.key)).toEqual(
      expect.arrayContaining(['plasticity', 'largeDeformation', 'elementType']),
    );
  });
});

describe('chooseGrid', () => {
  it('手動の格子（autoGrid = false）: draft は Lite と同じ、standard は 1.5 倍、fine は 2 倍', () => {
    const p = steelBeam({ P: 100, nx: 100 });
    expect(chooseGrid({ project: p, analysis: 'stress', quality: 'draft' }).nx).toBe(100);
    expect(chooseGrid({ project: p, analysis: 'stress', quality: 'standard' }).nx).toBe(150);
    expect(chooseGrid({ project: p, analysis: 'stress', quality: 'fine' }).nx).toBe(200);
    expect(chooseGrid({ project: p, analysis: 'stress', quality: 'fine' }).ny).toBe(20);
    expect(chooseGrid({ project: p, analysis: 'stress', quality: 'draft' }).note).toContain('Lite と同じ');
  });

  it('autoGrid が有効なら core/auto の規則で nx が決まる', () => {
    const p = steelBeam({ P: 100, nx: 100 });
    p.domain.autoGrid = true;
    const g = chooseGrid({ project: p, analysis: 'stress', quality: 'draft' });
    expect(g.baseNx).toBeGreaterThanOrEqual(120); // 強度の最小 nx
    expect(g.project.domain.nx).toBe(g.nx);
  });

  it('セル数が上限を超えないように細かさを抑える', () => {
    const p = aluminumBeamPreset();
    p.domain.nx = 400;
    p.domain.width = 0.4;
    p.domain.height = 0.4; // 400 × 400 = 16 万セル
    const g = chooseGrid({ project: p, analysis: 'stress', quality: 'fine' });
    expect(g.nx * g.ny).toBeLessThanOrEqual(MAX_CELLS);
    expect(g.nx).toBeGreaterThan(400);
    expect(g.note).toContain('上限');
  });
});
