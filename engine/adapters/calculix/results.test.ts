import { readFileSync } from 'node:fs';
import path from 'node:path';
import { rasterize } from '../../../src/core/raster';
import { parseDat } from './dat';
import { buildMesh } from './mesh';
import { mapResults, toResultSet } from './results';
import { makeProject, rect, shape } from './test-projects';

// fixtures/plastic-4x2.dat を出した計算と同じ条件（4 × 2 セル、左半分を固定、右 1 列に 200 kN 下向き、SS400）
const project = makeProject({
  width: 0.4,
  height: 0.2,
  nx: 4,
  thickness: 0.01,
  shapes: [
    shape('solid', rect(0, 0, 0.4, 0.2)),
    shape('support', rect(0, 0, 0.1, 0.2)),
    shape('load', rect(0.3, 0, 0.1, 0.2), { force: { fx: 0, fy: -200000 } }),
  ],
});
const mesh = buildMesh({ project, raster: rasterize(project), elementType: 'CPS4' });
const blocks = parseDat(readFileSync(path.join(__dirname, 'fixtures/plastic-4x2.dat'), 'utf8'));

describe('mapResults', () => {
  it('Lite と同じキー・単位の場と、物体セルだけの mask を返す', () => {
    const m = mapResults(mesh, blocks, { plasticity: true });
    const keys = m.fields.map((f) => f.key);
    expect(keys).toEqual(['vonMises', 'displacement', 'sxx', 'syy', 'sxy', 'safety', 'ux', 'uy', 'plasticStrain']);
    expect(m.fields.find((f) => f.key === 'sxx')!.diverging).toBe(true);
    for (const f of m.fields) {
      expect(f.data.length).toBe(4 * 2);
      expect(f.mask).toBe(mesh.included);
    }
    expect(m.fields.find((f) => f.key === 'vonMises')!.unit).toBe('Pa');
    expect(m.fields.find((f) => f.key === 'displacement')!.unit).toBe('m');
  });

  it('スカラー: 反力は荷重と一致、最大変位は先端、降伏した面積は 6/8', () => {
    const m = mapResults(mesh, blocks, { plasticity: true });
    const v = (k: string) => m.scalars.find((s) => s.key === k)!.value;
    expect(v('reaction')).toBeCloseTo(2e5, -1);
    expect(v('maxDisplacement')).toBeCloseTo(Math.hypot(1.233431e-3, 3.517261e-3), 6);
    expect(v('mass')).toBeCloseTo(7850 * 0.4 * 0.2 * 0.01, 9);
    expect(v('yieldedArea')).toBeCloseTo(0.75, 9);
    expect(v('maxPlasticStrain')).toBeGreaterThan(1e-3);
    expect(v('minSafety')).toBeLessThan(1.05);
    expect(v('maxVonMises')).toBeGreaterThan(2.4e8);
  });

  it('塑性なしなら塑性の場と降伏の値は出さない', () => {
    const m = mapResults(mesh, blocks, { plasticity: false });
    expect(m.fields.some((f) => f.key === 'plasticStrain')).toBe(false);
    expect(m.scalars.some((s) => s.key === 'yieldedArea')).toBe(false);
  });

  it('セルの変位は 4 つの角の節点の平均（Lite と同じ）', () => {
    const m = mapResults(mesh, blocks, { plasticity: false });
    // セル (3, 0)（右下）の角は節点 4, 5, 10, 9。uy = (-2.266657 - 3.517261 - 3.522277 - 2.228706) e-3 / 4
    const uy = m.fields.find((f) => f.key === 'uy')!.data[3];
    expect(uy).toBeCloseTo((-2.266657e-3 - 3.517261e-3 - 3.522277e-3 - 2.228706e-3) / 4, 8);
  });

  it('応力か変位が読めないときは日本語のエラー', () => {
    expect(() => mapResults(mesh, [], { plasticity: false })).toThrow('読み取れませんでした');
  });

  it('ResultSet にまとめる', () => {
    const rs = toResultSet(mesh, mapResults(mesh, blocks, { plasticity: true }), ['x']);
    expect(rs).toMatchObject({ analysis: 'stress', nx: 4, ny: 2, h: 0.1, warnings: ['x'] });
    expect(rs.history).toEqual([]);
  });
});
