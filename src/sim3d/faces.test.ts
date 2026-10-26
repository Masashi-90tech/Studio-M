import { describe, expect, it } from 'vitest';
import type { Mesh3D } from '../core/types';
import { unindex } from '../mesh3d/fixtures';
import { analyzeMesh } from '../mesh3d/mesh';
import { boxMesh, cylinderMesh, plateWithHole } from '../mesh3d/primitives';
import { buildFaceGraph, facesArea, raycastMesh, selectConnectedFaces, triangleNormals, updateSelection, type Ray } from './faces';

const box = analyzeMesh(boxMesh(0.1, 0.2, 0.3)).mesh as Mesh3D;
const N = 32;
const cyl = analyzeMesh(cylinderMesh(0.05, 0.2, N)).mesh as Mesh3D;

const from = (origin: [number, number, number], target: [number, number, number]): Ray => ({ origin, dir: [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]] });

describe('光線と三角形の交差', () => {
  it('上から撃つと、いちばん手前の面（上面）に当たる。距離と当たった点が合う', () => {
    const hit = raycastMesh(box, { origin: [0.03, 0.07, 1], dir: [0, 0, -1] })!;
    expect(hit).not.toBeNull();
    expect(hit.t).toBeCloseTo(0.7, 6);
    expect(hit.point[2]).toBeCloseTo(0.3, 6);
    const nz = triangleNormals(box)[hit.tri * 3 + 2];
    expect(nz).toBeCloseTo(1, 6);
  });

  it('当たらない光線は null。後ろ向きの光線も当たらない', () => {
    expect(raycastMesh(box, { origin: [5, 5, 1], dir: [0, 0, -1] })).toBeNull();
    expect(raycastMesh(box, { origin: [0.03, 0.07, 1], dir: [0, 0, 1] })).toBeNull();
  });

  it('accept で手前の当たりを除くと、その向こう側（下面）に当たる', () => {
    const hit = raycastMesh(box, { origin: [0.03, 0.07, 1], dir: [0, 0, -1] }, (h) => h.point[2] < 0.15)!;
    expect(hit.point[2]).toBeCloseTo(0, 6);
  });

  it('向きの長さは何でもよい', () => {
    const a = raycastMesh(box, { origin: [0.03, 0.07, 1], dir: [0, 0, -100] })!;
    expect(a.t).toBeCloseTo(0.7, 6);
  });
});

describe('面の選択（辺でつながり、ほぼ同じ向きの三角形をまとめる）', () => {
  it('立方体（直方体）の上面をクリックすると、その面の 2 三角形だけが選ばれる', () => {
    const g = buildFaceGraph(box);
    const hit = raycastMesh(box, { origin: [0.03, 0.07, 1], dir: [0, 0, -1] })!;
    const sel = selectConnectedFaces(g, hit.tri);
    expect(sel).toHaveLength(2);
    const nrm = triangleNormals(box);
    for (const t of sel) expect(nrm[t * 3 + 2]).toBeCloseTo(1, 9);
    expect(facesArea(box, sel)).toBeCloseTo(0.1 * 0.2, 6);
  });

  it('側面（X の正の側）も、その面の 2 三角形だけ', () => {
    const g = buildFaceGraph(box);
    const hit = raycastMesh(box, from([1, 0.1, 0.15], [0, 0.1, 0.15]))!;
    const sel = selectConnectedFaces(g, hit.tri);
    expect(sel).toHaveLength(2);
    expect(facesArea(box, sel)).toBeCloseTo(0.2 * 0.3, 6);
  });

  it('円柱の側面をクリックすると、側面全体（2 × N 三角形）が選ばれ、上下の面は入らない', () => {
    const g = buildFaceGraph(cyl);
    const hit = raycastMesh(cyl, from([1, 0, 0.1], [0, 0, 0.1]))!;
    const sel = selectConnectedFaces(g, hit.tri);
    expect(sel).toHaveLength(2 * N);
    const nrm = triangleNormals(cyl);
    for (const t of sel) expect(Math.abs(nrm[t * 3 + 2])).toBeLessThan(1e-9);
    // 側面の面積は、N 角形の周の長さ × 高さ
    expect(facesArea(cyl, sel)).toBeCloseTo(N * 2 * 0.05 * Math.sin(Math.PI / N) * 0.2, 6);
  });

  it('円柱の上面は、側面を含まずに上面だけ（N − 2 三角形）', () => {
    const g = buildFaceGraph(cyl);
    const hit = raycastMesh(cyl, { origin: [0.01, 0.01, 1], dir: [0, 0, -1] })!;
    const sel = selectConnectedFaces(g, hit.tri);
    expect(sel).toHaveLength(N - 2);
    const nrm = triangleNormals(cyl);
    for (const t of sel) expect(nrm[t * 3 + 2]).toBeCloseTo(1, 9);
  });

  it('頂点を共有しない形（STL を読んだままの形）でも、位置が同じなら同じ面としてつながる', () => {
    const raw = unindex(boxMesh(0.1, 0.2, 0.3)) as Mesh3D;
    const g = buildFaceGraph(raw);
    const hit = raycastMesh(raw, { origin: [0.03, 0.07, 1], dir: [0, 0, -1] })!;
    expect(selectConnectedFaces(g, hit.tri)).toHaveLength(2);
  });

  it('穴あき板: 穴の壁をクリックすると、穴の壁だけ（板の上下面とは別）', () => {
    const plate = analyzeMesh(plateWithHole({ w: 0.08, d: 0.05, t: 0.008, r: 0.012, n: 48 })).mesh as Mesh3D;
    const g = buildFaceGraph(plate);
    // 真上からでは穴の壁に当たらないので、板の中から穴の壁を狙う
    const side = raycastMesh(plate, from([0.04 + 0.03, 0.025, 0.004], [0.04 + 0.012, 0.025, 0.004]));
    expect(side).not.toBeNull();
    const sel = selectConnectedFaces(g, side!.tri);
    const nrm = triangleNormals(plate);
    for (const t of sel) expect(Math.abs(nrm[t * 3 + 2])).toBeLessThan(1e-6);
    expect(sel.length).toBeGreaterThanOrEqual(48);
  });

  it('範囲外の seed は空', () => {
    const g = buildFaceGraph(box);
    expect(selectConnectedFaces(g, -1)).toEqual([]);
    expect(selectConnectedFaces(g, 9999)).toEqual([]);
  });
});

describe('選択の更新', () => {
  it('Shift なしは置き換え。Shift ありは足す。足した面をもう一度クリックすると外す', () => {
    const a = updateSelection(new Set(), [1, 2], false);
    expect([...a]).toEqual([1, 2]);
    expect([...updateSelection(a, [5, 6], false)]).toEqual([5, 6]);
    const b = updateSelection(a, [5, 6], true);
    expect([...b].sort()).toEqual([1, 2, 5, 6]);
    expect([...updateSelection(b, [5, 6], true)].sort()).toEqual([1, 2]);
  });
});
