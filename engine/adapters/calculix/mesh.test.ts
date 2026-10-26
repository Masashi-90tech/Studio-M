import { rasterize } from '../../../src/core/raster';
import { getMaterial } from '../../../src/core/materials';
import { buildMesh, GRAVITY, MeshError } from './mesh';
import { makeProject, rect, shape } from './test-projects';

// 4 × 2 セルの板（セル幅 0.1 m）。左の 1 列を固定、右の 1 列に合計 -1000 N
const plate = (extra: ReturnType<typeof shape>[] = [], selfWeight = false) =>
  makeProject({
    width: 0.4,
    height: 0.4,
    nx: 4,
    thickness: 0.01,
    selfWeight,
    shapes: [
      shape('solid', rect(0, 0, 0.4, 0.2)),
      shape('support', rect(0, 0, 0.1, 0.2)),
      shape('load', rect(0.3, 0, 0.1, 0.2), { force: { fx: 0, fy: -1000 } }),
      ...extra,
    ],
  });

describe('buildMesh', () => {
  it('CPS4: 物体セル 1 つ = 要素 1 つ。節点は物体に接するものだけ', () => {
    const p = plate();
    const mesh = buildMesh({ project: p, raster: rasterize(p), elementType: 'CPS4' });
    expect(mesh.elementCell.length).toBe(8);
    expect(mesh.nodeCount).toBe(15); // 5 × 3
    expect(mesh.nodesPerElement).toBe(4);
    expect(mesh.connectivity.length).toBe(32);
    // 要素 1（左下のセル）の節点は 左下→右下→右上→左上 の順で、座標が正しい
    const n = [...mesh.connectivity.slice(0, 4)];
    const xy = n.map((id) => [mesh.coords[2 * (id - 1)], mesh.coords[2 * (id - 1) + 1]]);
    expect(xy).toEqual([[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]]);
    expect(mesh.mass).toBeCloseTo(7850 * 0.4 * 0.2 * 0.01, 9);
  });

  it('支持セルの要素の節点が全部固定される', () => {
    const p = plate();
    const mesh = buildMesh({ project: p, raster: rasterize(p), elementType: 'CPS4' });
    // 左 1 列 × 高さ 2 セル → 節点は x = 0, 0.1 の 2 列 × 3 行 = 6 個
    expect(mesh.supportNodes.length).toBe(6);
    for (const id of mesh.supportNodes) expect(mesh.coords[2 * (id - 1)]).toBeLessThanOrEqual(0.1 + 1e-12);
  });

  it('荷重の合計が加えた力と一致し、角の節点には 1/4 ずつ配られる', () => {
    const p = plate();
    const mesh = buildMesh({ project: p, raster: rasterize(p), elementType: 'CPS4' });
    let fy = 0;
    let fx = 0;
    for (const f of mesh.nodalLoads.values()) {
      fx += f.fx;
      fy += f.fy;
    }
    expect(fx).toBeCloseTo(0, 9);
    expect(fy).toBeCloseTo(-1000, 9);
    // 荷重セルは右端の 2 セル。1 セル -500 N → 各角 -125 N。中央の節点は 2 セルぶんで -250 N
    const values = [...mesh.nodalLoads.values()].map((f) => f.fy).sort((a, b) => a - b);
    expect(values).toEqual([-250, -250, -125, -125, -125, -125]);
  });

  it('材料ごとに要素集合ができる', () => {
    const p = plate([shape('solid', rect(0.2, 0, 0.2, 0.2), { materialId: 'al6061' })]);
    const mesh = buildMesh({ project: p, raster: rasterize(p), elementType: 'CPS4' });
    expect(mesh.materials.length).toBe(2);
    const byId = new Map(mesh.materials.map((m) => [m.material.id, m.elements.length]));
    expect(byId.get('ss400')).toBe(4);
    expect(byId.get('al6061')).toBe(4);
    expect(mesh.materials.map((m) => m.name)).toEqual(['MAT1', 'MAT2']);
    const total = mesh.materials.flatMap((m) => m.elements).sort((a, b) => a - b);
    expect(total).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('支持のない部品は除外し、警告を出す（質量は Lite と同じく全体）', () => {
    const p = plate([shape('solid', rect(0.1, 0.35, 0.1, 0.05))]);
    // 離れた小さな部品が 1 つ（1 行あけた上の行 j = 3）
    const raster = rasterize(p);
    const mesh = buildMesh({ project: p, raster, elementType: 'CPS4' });
    expect(mesh.excludedParts).toBe(1);
    expect(mesh.excludedCells).toBe(1);
    expect(mesh.elementCell.length).toBe(8);
    expect(mesh.warnings.join('')).toContain('支持されていない部品');
    expect(mesh.mass).toBeCloseTo(7850 * 0.1 * 0.1 * 0.01 * 9, 9);
    expect([...mesh.included].reduce((a, b) => a + b, 0)).toBe(8);
  });

  it('CPS8R: 辺の中点にも節点ができる（共有する辺では 1 つ）', () => {
    const p = plate();
    const mesh = buildMesh({ project: p, raster: rasterize(p), elementType: 'CPS8R' });
    // 角 15 + 水平辺 4 × 3 = 12 + 垂直辺 5 × 2 = 10
    expect(mesh.nodeCount).toBe(37);
    expect(mesh.nodesPerElement).toBe(8);
    // 支持の 2 セル: 角 6 + 水平辺の中点 3 + 垂直辺の中点 4
    expect(mesh.supportNodes.length).toBe(13);
  });

  it('自重は節点荷重になり、合計が重さ（質量 × g）と一致する（CPS4 / CPS8R とも）', () => {
    for (const elementType of ['CPS4', 'CPS8R'] as const) {
      const p = plate([], true);
      const mesh = buildMesh({ project: p, raster: rasterize(p), elementType, selfWeight: true });
      let fy = 0;
      for (const f of mesh.nodalLoads.values()) fy += f.fy;
      const weight = 7850 * 0.4 * 0.2 * 0.01 * GRAVITY;
      expect(fy).toBeCloseTo(-1000 - weight, 6);
      // 自重を入れても「荷重の大きさ」（appliedLoad）はユーザーの荷重だけ
      expect(mesh.appliedLoad).toBeCloseTo(1000, 9);
    }
  });

  it('物体がない・支持がないときは日本語のエラー', () => {
    const none = makeProject({ width: 0.4, height: 0.2, nx: 4, thickness: 0.01, shapes: [] });
    expect(() => buildMesh({ project: none, raster: rasterize(none), elementType: 'CPS4' })).toThrow(MeshError);
    expect(() => buildMesh({ project: none, raster: rasterize(none), elementType: 'CPS4' })).toThrow('物体がありません');
    const free = makeProject({ width: 0.4, height: 0.2, nx: 4, thickness: 0.01, shapes: [shape('solid', rect(0, 0, 0.4, 0.2))] });
    expect(() => buildMesh({ project: free, raster: rasterize(free), elementType: 'CPS4' })).toThrow('支持');
  });

  it('材料の定数は materials.ts から来る', () => {
    const p = plate();
    const mesh = buildMesh({ project: p, raster: rasterize(p), elementType: 'CPS4' });
    expect(mesh.materials[0].material).toBe(getMaterial('ss400'));
  });
});
