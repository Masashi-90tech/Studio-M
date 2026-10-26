import { describe, expect, it } from 'vitest';
import { ANALYSIS_KINDS } from '../core/analyses';
import { MATERIALS } from '../core/materials';
import { gridSize, rasterize } from '../core/raster';
import { sanitizeProject } from '../ui/project-utils';
import { buildMeshProject, domainMargins } from './build';
import { cleanMesh } from './mesh';
import { plateWithHole, regularPolygonArea, boxMesh } from './primitives';
import { sliceMesh } from './slice';

const N = 48;
const plate = cleanMesh(plateWithHole({ w: 80, d: 50, t: 8, r: 12, n: N })).mesh;
const holeArea = regularPolygonArea(12, N);
const sliceZ = sliceMesh(plate, { axis: 2, position: 4 });

describe('断面から Project を作る', () => {
  it('外形は solid、穴は hole の polygon。外形が先で穴があと（後のものが前を上書きする）', () => {
    const { project } = buildMeshProject({ slice: sliceZ, fileName: 'plate.stl', analysis: 'heat' });
    expect(project.shapes.map((s) => s.role)).toEqual(['solid', 'hole']);
    expect(project.shapes.every((s) => s.geom.kind === 'polygon')).toBe(true);
    expect(project.shapes[0].materialId).toBe('al6061');
  });

  it('mm を m に直す（既定 mm）。m・inch も選べる', () => {
    const mm = buildMeshProject({ slice: sliceZ, fileName: 'plate.stl', analysis: 'heat' });
    expect(mm.sizeM.w).toBeCloseTo(0.08, 9);
    expect(mm.sizeM.h).toBeCloseTo(0.05, 9);
    const m = buildMeshProject({ slice: sliceZ, fileName: 'plate.stl', analysis: 'heat', unit: 'm' });
    expect(m.sizeM.w).toBeCloseTo(80, 9);
    const inch = buildMeshProject({ slice: sliceZ, fileName: 'plate.stl', analysis: 'heat', unit: 'inch' });
    expect(inch.sizeM.w).toBeCloseTo(80 * 0.0254, 9);
    expect(inch.project.shapes[0].meta?.unit).toBe('inch');
  });

  it('板の厚さの既定は、切った軸方向のモデルの長さ。指定もできる', () => {
    expect(buildMeshProject({ slice: sliceZ, fileName: 'a.stl', analysis: 'heat' }).project.thickness).toBeCloseTo(0.008, 9);
    expect(buildMeshProject({ slice: sliceZ, fileName: 'a.stl', analysis: 'heat', thicknessM: 0.02 }).project.thickness).toBe(0.02);
    const x = sliceMesh(plate, { axis: 0, position: 10 });
    expect(buildMeshProject({ slice: x, fileName: 'a.stl', analysis: 'heat' }).project.thickness).toBeCloseTo(0.08, 9);
  });

  it('形はすべて解析領域の内側にあり、余白は解析で変わる（流れ: 上流 1 倍・下流 3 倍）', () => {
    for (const analysis of ANALYSIS_KINDS) {
      const { project, sizeM } = buildMeshProject({ slice: sliceZ, fileName: 'a.stl', analysis });
      const pts = project.shapes.flatMap((s) => (s.geom.kind === 'polygon' ? s.geom.points : []));
      for (const [x, y] of pts) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(project.domain.width);
        expect(y).toBeLessThanOrEqual(project.domain.height);
      }
      const m = domainMargins(analysis, sizeM.w, sizeM.h);
      expect(project.domain.width).toBeCloseTo(sizeM.w + m.left + m.right, 9);
      expect(project.domain.height).toBeCloseTo(sizeM.h + m.bottom + m.top, 9);
      // 形の左端は左の余白の位置
      expect(Math.min(...pts.map((p) => p[0]))).toBeCloseTo(m.left, 9);
      expect(Math.min(...pts.map((p) => p[1]))).toBeCloseTo(m.bottom, 9);
    }
    const f = domainMargins('flow', 0.08, 0.05);
    expect(f.left).toBeCloseTo(0.08, 9);
    expect(f.right).toBeCloseTo(0.24, 9);
    expect(f.top).toBeCloseTo(0.05, 9);
    expect(domainMargins('heat', 0.08, 0.05).left).toBeLessThan(f.left);
  });

  it('平たい形の流れでも、上下の余白は幅の 1/4 を確保する', () => {
    expect(domainMargins('flow', 1, 0.01).top).toBeCloseTo(0.25, 9);
  });

  it('shape.meta に取り込み元（ファイル名・軸・位置・単位）が入る', () => {
    const { project } = buildMeshProject({ slice: sliceZ, fileName: 'plate.stl', analysis: 'heat' });
    expect(project.shapes[0].meta).toMatchObject({ source: 'plate.stl', axis: 'Z', position: '4', unit: 'mm' });
    expect(project.name).toBe('plate（Z = 4 mm の断面）');
  });

  it('格子化すると、板の面積（外形 - 穴）が理論値に近い', () => {
    const { project } = buildMeshProject({ slice: sliceZ, fileName: 'plate.stl', analysis: 'heat' });
    const r = rasterize(project);
    const area = r.solid.reduce((s, v) => s + v, 0) * r.h * r.h;
    const expected = (80 * 50 - holeArea) * 1e-6;
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.03);
    expect(gridSize(project).nx).toBe(project.domain.nx);
  });

  it('保存して開き直しても同じ形（sanitizeProject を通る）', () => {
    const { project } = buildMeshProject({ slice: sliceZ, fileName: 'plate.stl', analysis: 'stress', materialId: 'pla' });
    const back = sanitizeProject(JSON.parse(JSON.stringify(project)));
    expect(back).not.toBeNull();
    expect(back!.shapes.map((s) => s.role)).toEqual(['solid', 'hole']);
    expect(back!.shapes[0].materialId).toBe('pla');
    expect(back!.thickness).toBeCloseTo(0.008, 9);
  });

  it('材料はどの固体も選べる。未知の材料と空の断面は日本語のエラー', () => {
    for (const m of MATERIALS.filter((x) => x.kind === 'solid')) {
      expect(buildMeshProject({ slice: sliceZ, fileName: 'a.stl', analysis: 'heat', materialId: m.id }).project.shapes[0].materialId).toBe(m.id);
    }
    expect(() => buildMeshProject({ slice: sliceZ, fileName: 'a.stl', analysis: 'heat', materialId: 'unobtainium' })).toThrow();
    const empty = sliceMesh(cleanMesh(boxMesh(10, 10, 10)).mesh, { axis: 2, position: 50 });
    expect(() => buildMeshProject({ slice: empty, fileName: 'a.stl', analysis: 'heat' })).toThrow(/断面が空/);
  });

  it('強度・熱では、次にやることを注意として添える。取り込み時の注意も引き継ぐ', () => {
    expect(buildMeshProject({ slice: sliceZ, fileName: 'a.stl', analysis: 'stress' }).warnings.join('')).toMatch(/固定する場所と荷重/);
    expect(buildMeshProject({ slice: sliceZ, fileName: 'a.stl', analysis: 'heat' }).warnings.join('')).toMatch(/熱源/);
    expect(buildMeshProject({ slice: sliceZ, fileName: 'a.stl', analysis: 'flow' }).warnings).toEqual([]);
    const withWarn = { ...sliceZ, warnings: ['元の注意'] };
    expect(buildMeshProject({ slice: withWarn, fileName: 'a.stl', analysis: 'flow' }).warnings).toEqual(['元の注意']);
  });

  it('OBJ の拡張子もプロジェクト名から外す', () => {
    expect(buildMeshProject({ slice: sliceZ, fileName: 'dir/Bracket v2.OBJ', analysis: 'flow' }).project.name).toMatch(/^Bracket v2（/);
  });
});
