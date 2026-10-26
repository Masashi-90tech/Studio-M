import { boxMesh, cylinderMesh } from '../mesh3d/primitives';
import { studyGrid, voxelGrid } from './grid3d';
import type { Grid3D, Mesh3D, Study3D } from './types';
import { uvSphere } from './test-meshes';
import { meshMetrics, surfaceFaces, voxelizeMesh } from './voxelize';

function gridFor(mesh: Mesh3D, cell: number): Grid3D {
  return studyGrid({ mesh, grid: { cell, maxCells: 2_000_000 } } as unknown as Study3D);
}

describe('ボクセル化', () => {
  it('直方体: セルの数と体積が合い、面積は補正前後とも本当の面積と一致する', () => {
    const mesh = boxMesh(0.04, 0.02, 0.01);
    const grid = gridFor(mesh, 0.001);
    const vox = voxelizeMesh(mesh, grid);
    expect(vox.count).toBe(40 * 20 * 10);
    expect(vox.openRays).toBe(0);
    expect(vox.thinRays).toBe(0);
    expect(vox.flipped).toBe(false);
    const faces = surfaceFaces({ mesh, grid, inside: vox.inside });
    const trueArea = 2 * (0.04 * 0.02 + 0.04 * 0.01 + 0.02 * 0.01);
    expect(faces.count).toBe(2 * (40 * 20 + 40 * 10 + 20 * 10));
    expect(faces.trueArea).toBeCloseTo(trueArea, 9);
    expect(faces.correctedArea / trueArea).toBeCloseTo(1, 3);
    expect(faces.lostTriangles).toBe(0);
    // すべての面にいちばん近い三角形が割り当てられている
    expect(Array.from(faces.tri).every((t) => t >= 0)).toBe(true);
  });

  it('面は向きが合う三角形に割り当てられる（辺の近くでも側面と端面を取り違えない）', () => {
    const mesh = boxMesh(0.1, 0.01, 0.01);
    const grid = gridFor(mesh, 0.002);
    const vox = voxelizeMesh(mesh, grid);
    const faces = surfaceFaces({ mesh, grid, inside: vox.inside });
    const p = mesh.positions;
    const idx = mesh.indices;
    const triIsEnd0 = (t: number): boolean => [0, 1, 2].every((v) => Math.abs(p[idx[3 * t + v] * 3]) < 1e-9);
    let end0 = 0;
    for (let f = 0; f < faces.count; f++) {
      const isMinusX = faces.dir[f] === 0;
      const toEnd = triIsEnd0(faces.tri[f]);
      expect(toEnd).toBe(isMinusX);
      if (toEnd) end0++;
    }
    expect(end0).toBe(25);
  });

  it('球: 階段状の面積は本当の面積より大きく、補正すると数 % 以内で一致する', () => {
    const r = 0.02;
    const mesh = uvSphere(r, 48, 96);
    const grid = gridFor(mesh, r / 10);
    const vox = voxelizeMesh(mesh, grid);
    const faces = surfaceFaces({ mesh, grid, inside: vox.inside });
    const m = meshMetrics(mesh);
    expect(faces.rawArea / m.area).toBeGreaterThan(1.3);
    expect(faces.rawArea / m.area).toBeLessThan(1.7);
    // 微調整の倍率が 1 に近い = 三角形の向きから決めた補正そのものが正確（微調整が誤差を隠していない）
    expect(faces.groupScale[0]).toBeGreaterThan(0.94);
    expect(faces.groupScale[0]).toBeLessThan(1.06);
    expect(faces.correctedArea / m.area).toBeGreaterThan(0.97);
    expect(faces.correctedArea / m.area).toBeLessThan(1.03);
    // 体積
    const v = vox.count * grid.h ** 3;
    expect(Math.abs(v / m.signedVolume - 1)).toBeLessThan(0.03);
  });

  it('向きが内向きのメッシュも扱える', () => {
    const mesh = boxMesh(0.02, 0.02, 0.02);
    const flippedIdx = Uint32Array.from(mesh.indices);
    for (let t = 0; t < flippedIdx.length; t += 3) [flippedIdx[t + 1], flippedIdx[t + 2]] = [flippedIdx[t + 2], flippedIdx[t + 1]];
    const flipped: Mesh3D = { positions: mesh.positions, indices: flippedIdx };
    const grid = gridFor(flipped, 0.002);
    const vox = voxelizeMesh(flipped, grid);
    expect(vox.flipped).toBe(true);
    expect(vox.count).toBe(1000);
  });

  it('円柱: 辺や頂点にちょうど当たる光線でも数が狂わない', () => {
    // 格子の中心の行がちょうど頂点を通るように、セルを辺の長さにそろえる
    const mesh = cylinderMesh(0.01, 0.02, 8);
    const grid = gridFor(mesh, 0.0025);
    const vox = voxelizeMesh(mesh, grid);
    expect(vox.openRays).toBe(0);
    expect(vox.count).toBeGreaterThan(300);
  });

  it('厚さがセル 1 つ未満の板は、消えたことを数える（x 方向・z 方向どちらの薄さでも）', () => {
    // 1 mm のセルの中心は 0.5, 1.5, ... mm。板（0.6〜0.9 mm）はどの中心も通らない
    const join = (a: Mesh3D, b: Mesh3D): Mesh3D => ({
      positions: Float32Array.from([...a.positions, ...b.positions]),
      indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, (v) => v + a.positions.length / 3)]),
    });
    const grid = voxelGrid({ bounds: { min: [0, 0, 0], max: [0.04, 0.02, 0.04] }, cell: 0.001 });
    const block = boxMesh(0.02, 0.02, 0.02, [0.02, 0, 0.02]);
    // x が薄い板: 光線が部品の中を通るのにセルの中心に入らない
    const thinX = join(boxMesh(0.0003, 0.02, 0.02, [0.0006, 0, 0]), block);
    const voxX = voxelizeMesh(thinX, grid);
    expect(voxX.count).toBe(20 * 20 * 20);
    expect(voxX.thinRays).toBe(400);
    expect(surfaceFaces({ mesh: thinX, grid, inside: voxX.inside }).lostTriangles).toBeGreaterThan(0);
    // z が薄い板: 光線が当たらない。大きな三角形にまわりに格子の面がないことで分かる
    const thinZ = join(boxMesh(0.02, 0.02, 0.0003, [0, 0, 0.0006]), block);
    const voxZ = voxelizeMesh(thinZ, grid);
    expect(voxZ.count).toBe(20 * 20 * 20);
    expect(surfaceFaces({ mesh: thinZ, grid, inside: voxZ.inside }).lostTriangles).toBeGreaterThan(0);
    // 厚いものは数えない
    const ok = surfaceFaces({ mesh: block, grid, inside: voxelizeMesh(block, grid).inside });
    expect(ok.lostTriangles).toBe(0);
  });
});
