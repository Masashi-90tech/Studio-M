import { describe, expect, it } from 'vitest';
import { defaultProject } from '../core/project';
import { gridSize } from '../core/raster';
import type { Shape } from '../core/types';
import { characteristicLength, ensureRoleDefaults, formulaGridNx, nextShapeName, projectForFormula, safeFileName, sanitizeProject } from './project-utils';

describe('formulaGridNx / projectForFormula', () => {
  it('2m × 1m の nx=200 は 120 × 60 に収まる', () => {
    expect(formulaGridNx(2, 1, 200)).toBe(120);
  });
  it('縦長の領域は高さ 80 に収まるよう nx を減らす', () => {
    const nx = formulaGridNx(1, 2, 200);
    expect(nx).toBeLessThanOrEqual(40);
    const p = defaultProject();
    p.domain = { width: 1, height: 2, nx: 200 };
    const g = gridSize(projectForFormula(p));
    expect(g.ny).toBeLessThanOrEqual(80);
    expect(g.nx).toBeLessThanOrEqual(120);
  });
  it('もともと小さければそのまま、元のプロジェクトは変えない', () => {
    const p = defaultProject();
    p.domain.nx = 60;
    expect(projectForFormula(p).domain.nx).toBe(60);
    p.domain.nx = 400;
    projectForFormula(p);
    expect(p.domain.nx).toBe(400);
  });
  it('100 × 70 mm の基板でも 80 行以内', () => {
    const p = defaultProject();
    p.domain = { width: 0.1, height: 0.07, nx: 200 };
    expect(gridSize(projectForFormula(p)).ny).toBeLessThanOrEqual(80);
  });
});

describe('sanitizeProject', () => {
  it('既定プロジェクトはそのまま通る', () => {
    const p = defaultProject();
    expect(sanitizeProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
  it('壊れた入力は null', () => {
    expect(sanitizeProject(null)).toBeNull();
    expect(sanitizeProject({})).toBeNull();
    expect(sanitizeProject({ domain: { width: -1, height: 1 }, shapes: [] })).toBeNull();
    expect(sanitizeProject({ domain: { width: 1, height: 1 }, shapes: 'x' })).toBeNull();
  });
  it('不正な図形・役割・材料・数値は取り除くか既定値にする', () => {
    const p = sanitizeProject({
      domain: { width: 1, height: 0.5, nx: 99999 },
      shapes: [
        { geom: { kind: 'rect', x: 0, y: 0, w: -1, h: 1 }, role: 'solid' },
        { geom: { kind: 'circle', cx: 0.5, cy: 0.2, r: 0.1 }, role: 'weird', materialId: 'unobtainium' },
        { geom: { kind: 'polygon', points: [[0, 0], [1, 0]] }, role: 'solid' },
        { geom: { kind: 'rect', x: 0, y: 0, w: 1, h: 1 }, role: 'heatSource', materialId: 'pla' },
      ],
      flow: { inletVelocity: 'fast', fluidId: 'lava', walls: 'noslip' },
    })!;
    expect(p.domain.nx).toBe(800);
    expect(p.shapes).toHaveLength(2);
    expect(p.shapes[0].role).toBe('solid');
    expect(p.shapes[0].materialId).toBe('al6061');
    expect(p.shapes[1].heatW).toBe(5);
    expect(p.flow.fluidId).toBe('air');
    expect(p.flow.walls).toBe('noslip');
    expect(p.flow.inletVelocity).toBe(defaultProject().flow.inletVelocity);
  });
});

describe('sanitizeProject: 流れの温度（thermal）', () => {
  const base = { domain: { width: 1, height: 0.5, nx: 100 }, shapes: [] };
  it('省略したら省略のまま（今までのプロジェクトと同じ）', () => {
    expect(sanitizeProject({ ...base, flow: { inletVelocity: 1 } })!.flow.thermal).toBeUndefined();
    expect(sanitizeProject({ ...base, flow: { inletVelocity: 1, thermal: 'x' } })!.flow.thermal).toBeUndefined();
  });
  it('有効・無効と流入温度を読み込み、範囲外や不正な値は整える', () => {
    expect(sanitizeProject({ ...base, flow: { thermal: { enabled: true, inletTempC: 30 } } })!.flow.thermal).toEqual({ enabled: true, inletTempC: 30 });
    expect(sanitizeProject({ ...base, flow: { thermal: { enabled: true } } })!.flow.thermal).toEqual({ enabled: true });
    expect(sanitizeProject({ ...base, flow: { thermal: { enabled: 'yes', inletTempC: 'hot' } } })!.flow.thermal).toEqual({ enabled: false });
    expect(sanitizeProject({ ...base, flow: { thermal: { enabled: true, inletTempC: -9999 } } })!.flow.thermal).toEqual({ enabled: true, inletTempC: -273 });
    expect(sanitizeProject({ ...base, flow: { thermal: { enabled: true, inletTempC: 1e9 } } })!.flow.thermal).toEqual({ enabled: true, inletTempC: 2000 });
  });
  it('保存して読み込んでも同じ', () => {
    const p = defaultProject();
    p.flow.thermal = { enabled: true, inletTempC: 18.5 };
    expect(sanitizeProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
});

describe('その他', () => {
  it('ensureRoleDefaults は役割に必要な値を補う', () => {
    const s: Shape = { id: 'a', name: 'a', geom: { kind: 'rect', x: 0, y: 0, w: 1, h: 1 }, role: 'load', materialId: 'x' };
    ensureRoleDefaults(s);
    expect(s.force).toEqual({ fx: 0, fy: -10 });
  });
  it('nextShapeName は重ならない名前を返す', () => {
    const p = defaultProject();
    p.shapes = [{ id: '1', name: '物体 2', geom: { kind: 'rect', x: 0, y: 0, w: 1, h: 1 }, role: 'solid', materialId: 'pla' }];
    expect(nextShapeName(p, 'solid')).toBe('物体 3');
    expect(nextShapeName(p, 'hole')).toBe('穴 1');
  });
  it('safeFileName', () => {
    expect(safeFileName('a/b c:d')).toBe('a_b_c_d');
    expect(safeFileName('   ')).toBe('studio-m');
    expect(safeFileName('四角柱 まわり')).toBe('四角柱_まわり');
  });
  it('characteristicLength は物体の上下幅', () => {
    const p = defaultProject();
    expect(characteristicLength(p)).toBeCloseTo(0.2);
    p.shapes = [];
    expect(characteristicLength(p)).toBeCloseTo(0.2);
  });
});

describe('sanitizeProject: 電磁波・自動格子・詳細設定', () => {
  it('電磁波の設定と advanced が往復できる', () => {
    const p = defaultProject();
    p.em = { frequencyGHz: 5, source: 'point', angleDeg: 10, pointX: 0.1, pointY: 0.3, polarization: 'TE', mediumId: 'water', advanced: { pmlCells: 20, waveform: 'pulse' } };
    p.flow.advanced = { smagorinskyCs: 0.12, latticeU: 0.05 };
    p.scalar.advanced = { scheme: 'central', relaxation: 1.4, tolerance: 1e-8 };
    p.heat.advanced = { maxIterations: 5000 };
    p.domain.autoGrid = false;
    expect(sanitizeProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
  it('古い保存データ（em も autoGrid もない）は、既定の電磁波設定と自動格子で読める', () => {
    const old = JSON.parse(JSON.stringify(defaultProject()));
    delete old.em;
    delete old.domain.autoGrid;
    const p = sanitizeProject(old)!;
    expect(p.domain.autoGrid).toBe(true);
    expect(p.em.source).toBe('plane');
    expect(p.em.frequencyGHz).toBe(24);
  });
  it('範囲外の advanced は範囲内に丸め、不正な値は捨てる', () => {
    const raw = JSON.parse(JSON.stringify(defaultProject()));
    raw.em.advanced = { courant: 5, pmlCells: 'x', waveform: 'square', cellsPerWavelength: 1000 };
    raw.heat.advanced = { tolerance: 'tiny' };
    const p = sanitizeProject(raw)!;
    expect(p.em.advanced).toEqual({ courant: 0.7071, cellsPerWavelength: 200 });
    expect(p.heat.advanced).toBeUndefined();
  });
  it('数式ブック用の複製は格子を手動（粗くした nx）にする', () => {
    const p = defaultProject();
    p.domain.nx = 400;
    const c = projectForFormula(p);
    expect(c.domain.autoGrid).toBe(false);
    expect(p.domain.autoGrid).toBe(true);
  });
});

