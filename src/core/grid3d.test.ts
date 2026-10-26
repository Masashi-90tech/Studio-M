import { describe, expect, it } from 'vitest';
import { cellCenter3D, cellIndex3D, flowAxis, flowBounds, GRID3D_DEFAULT_LONG_CELLS, GRID3D_FLOW_DEFAULT_MAX_CELLS, mesh3DBounds, sampleField3D, studyGrid, voxelGrid } from './grid3d';

const box = (x: number, y: number, z: number) => ({ min: [0, 0, 0] as [number, number, number], max: [x, y, z] as [number, number, number] });

describe('voxelGrid', () => {
  it('自動では、いちばん長い辺を既定のセル数に分け、まわりに 1 セルの余白を足す', () => {
    const g = voxelGrid({ bounds: box(0.064, 0.032, 0.016) });
    expect(g.h).toBeCloseTo(0.001, 9);
    expect([g.nx, g.ny, g.nz]).toEqual([GRID3D_DEFAULT_LONG_CELLS + 2, 34, 18]);
    // 形が格子の真ん中に来る
    expect(g.origin[0]).toBeCloseTo(-0.001, 9);
    expect(g.origin[0] + g.nx * g.h).toBeCloseTo(0.065, 9);
  });

  it('セル数が上限を超えるときは、セルを大きくして上限に収める', () => {
    const g = voxelGrid({ bounds: box(1, 1, 1), cell: 0.001, maxCells: 50_000 });
    expect(g.nx * g.ny * g.nz).toBeLessThanOrEqual(50_000);
    expect(g.h).toBeGreaterThan(0.001);
  });

  it('薄い板でも厚さ方向に少なくとも 1 セル（+ 余白）ある', () => {
    const g = voxelGrid({ bounds: box(0.1, 0.1, 0) });
    expect(g.nz).toBe(3);
  });

  it('float32 に丸めた寸法（0.1 m → 0.10000000149 m）でも、割り切れる寸法ならセルが 1 つ増えない', () => {
    const x = Math.fround(0.1);
    const g = voxelGrid({ bounds: box(x, x, x), cell: 0.001, maxCells: 2_000_000 });
    expect([g.nx, g.ny, g.nz]).toEqual([102, 102, 102]);
  });

  it('大きさ 0 なら日本語のエラー', () => {
    expect(() => voxelGrid({ bounds: box(0, 0, 0) })).toThrow(/大きさが 0/);
  });

  it('番号と中心の座標', () => {
    const g = { nx: 4, ny: 3, nz: 2, h: 0.5, origin: [1, 2, 3] as [number, number, number] };
    expect(cellIndex3D(g, 3, 2, 1)).toBe(23);
    expect(cellCenter3D(g, 0, 0, 0)).toEqual([1.25, 2.25, 3.25]);
  });
});

describe('mesh3DBounds', () => {
  it('使われている頂点だけで外接箱を決め、三角形がなければ null', () => {
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 2, 3, 99, 99, 99]);
    expect(mesh3DBounds({ positions, indices: Uint32Array.from([0, 1, 2]) })).toEqual({ min: [0, 0, 0], max: [1, 2, 3] });
    expect(mesh3DBounds({ positions, indices: new Uint32Array(0) })).toBeNull();
  });
});

describe('sampleField3D', () => {
  const g = { nx: 4, ny: 4, nz: 4, h: 1, origin: [0, 0, 0] as [number, number, number] };
  const data = new Float32Array(64);
  const mask = new Uint8Array(64);
  for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    data[(k * 4 + j) * 4 + i] = i; // x 方向に 1 ずつ増える
    mask[(k * 4 + j) * 4 + i] = i < 3 ? 1 : 0; // x = 3 の列は部品の外
  }

  it('部品の中では線形に補間する', () => {
    expect(sampleField3D(g, data, mask, [1.0, 2, 2])).toBeCloseTo(0.5, 6);
    expect(sampleField3D(g, data, mask, [2.25, 1.5, 1.5])).toBeCloseTo(1.75, 6);
  });

  it('部品の外のセルは使わない（外の値に引っぱられない）', () => {
    expect(sampleField3D(g, data, mask, [3.0, 2, 2])).toBeCloseTo(2, 6);
  });

  it('近くに部品がなければ NaN', () => {
    const empty = new Uint8Array(64);
    expect(sampleField3D(g, data, empty, [2, 2, 2])).toBeNaN();
  });
});

describe('流れの風洞（flowBounds・studyGrid）', () => {
  const cube = { min: [0, 0, 0] as [number, number, number], max: [0.02, 0.01, 0.01] as [number, number, number] };

  it('上流・下流・側方へ D（流れに垂直な寸法の最大）の倍率だけ広げる', () => {
    const b = flowBounds(cube, { fluidId: 'air', direction: '+x', inletVelocity: 1, walls: 'slip' });
    // D = max(0.01, 0.01) = 0.01。上流 1.5D、下流 4D、側方 1.5D
    expect(b.min[0]).toBeCloseTo(-0.015, 9);
    expect(b.max[0]).toBeCloseTo(0.06, 9);
    expect(b.min[1]).toBeCloseTo(-0.015, 9);
    expect(b.max[2]).toBeCloseTo(0.025, 9);
  });

  it('逆向き（-z）の流れでは、+z 側が上流になる', () => {
    const b = flowBounds(cube, { fluidId: 'air', direction: '-z', inletVelocity: 1, walls: 'slip', domain: { upstream: 1, downstream: 2, side: 0.5 } });
    // D = max(0.02, 0.01) = 0.02
    expect(b.max[2]).toBeCloseTo(0.01 + 0.02, 9);
    expect(b.min[2]).toBeCloseTo(-0.04, 9);
    expect(b.min[0]).toBeCloseTo(-0.01, 9);
  });

  it('流れの格子は風洞全体を覆い、セル数の上限に収まる', () => {
    const study = {
      version: 1 as const,
      name: 't',
      analysis: 'flow' as const,
      mesh: { positions: Float32Array.from([0, 0, 0, 0.02, 0, 0, 0, 0.01, 0.01]), indices: Uint32Array.from([0, 1, 2]) },
      materialId: 'a6061',
      regions: [],
      heat: { ambientC: 25, surfaceH: 8 },
      stress: { selfWeight: false },
    };
    const g = studyGrid(study);
    expect(g.nx * g.ny * g.nz).toBeLessThanOrEqual(GRID3D_FLOW_DEFAULT_MAX_CELLS);
    expect(g.nx * g.ny * g.nz).toBeGreaterThan(GRID3D_FLOW_DEFAULT_MAX_CELLS * 0.8);
    expect(g.origin[0]).toBeLessThanOrEqual(-0.015 + 1e-9);
    expect(g.origin[0] + g.nx * g.h).toBeGreaterThanOrEqual(0.06 - 1e-9);
    expect(flowAxis('-y')).toEqual({ axis: 1, sign: -1 });
  });
});
