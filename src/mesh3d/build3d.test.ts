import { describe, expect, it } from 'vitest';
import { GRID3D_DEFAULT_MAX_CELLS, mesh3DBounds, studyGrid } from '../core/grid3d';
import { buildStudy3D, STUDY3D_DEFAULT_AMBIENT_C, STUDY3D_DEFAULT_SURFACE_H } from './build3d';
import { analyzeMesh } from './mesh';
import { boxMesh, sampleMesh } from './primitives';

describe('3D モデルから Study3D を作る', () => {
  const plate = analyzeMesh(sampleMesh()).mesh;

  it('mm を m に直す（既定 mm）。m・inch も選べ、元のメッシュは変えない', () => {
    const before = plate.positions[3];
    const mm = buildStudy3D({ mesh: plate, fileName: 'plate.stl' });
    const b = mesh3DBounds(mm.mesh)!;
    expect(b.max[0] - b.min[0]).toBeCloseTo(0.08, 6);
    expect(b.max[1] - b.min[1]).toBeCloseTo(0.05, 6);
    expect(b.max[2] - b.min[2]).toBeCloseTo(0.008, 6);
    const m = mesh3DBounds(buildStudy3D({ mesh: plate, fileName: 'a.stl', unit: 'm' }).mesh)!;
    expect(m.max[0] - m.min[0]).toBeCloseTo(80, 4);
    const inch = mesh3DBounds(buildStudy3D({ mesh: boxMesh(10, 20, 30), fileName: 'a.stl', unit: 'inch' }).mesh)!;
    expect(inch.max[2] - inch.min[2]).toBeCloseTo(30 * 0.0254, 6);
    expect(plate.positions[3]).toBe(before);
  });

  it('既定値: 熱・条件なし・周囲 25°C・自然放置・標準の細かさ。名前と取り込み元はファイル名から', () => {
    const s = buildStudy3D({ mesh: plate, fileName: 'C:\\models\\bracket.STL' });
    expect(s.version).toBe(1);
    expect(s.analysis).toBe('heat');
    expect(s.name).toBe('bracket');
    expect(s.source).toBe('C:\\models\\bracket.STL');
    expect(s.materialId).toBe('al6061');
    expect(s.regions).toEqual([]);
    expect(s.heat).toEqual({ ambientC: STUDY3D_DEFAULT_AMBIENT_C, surfaceH: STUDY3D_DEFAULT_SURFACE_H });
    expect(s.grid?.maxCells).toBe(GRID3D_DEFAULT_MAX_CELLS);
    expect(s.mesh.indices.length).toBe(plate.indices.length);
  });

  it('未知の材料は Error。作った形から格子が決められる', () => {
    expect(() => buildStudy3D({ mesh: plate, fileName: 'a.stl', materialId: 'nothing' })).toThrow();
    const g = studyGrid(buildStudy3D({ mesh: plate, fileName: 'a.stl' }));
    expect(g.nx * g.ny * g.nz).toBeLessThanOrEqual(GRID3D_DEFAULT_MAX_CELLS);
  });
});
