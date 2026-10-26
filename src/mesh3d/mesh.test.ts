import { describe, expect, it } from 'vitest';
import { dropTriangle, unindex } from './fixtures';
import { analyzeMesh, checkWatertight, cleanMesh, meshBounds, meshVolume, signedVolume, weldVertices } from './mesh';
import { boxMesh, cylinderMesh, extrudePolygon, plateWithHole, regularPolygonArea } from './primitives';
import type { TriMesh } from './types';

describe('外接箱・体積', () => {
  it('外接箱は使われている頂点だけで決める', () => {
    const m: TriMesh = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 2, 0, 99, 99, 99]), indices: Uint32Array.from([0, 1, 2]) };
    expect(meshBounds(m)).toEqual({ min: [0, 0, 0], max: [1, 2, 0] });
  });

  it('立方体の体積、円柱（N 角形）の体積、面の向きが逆なら符号が反転する', () => {
    expect(meshVolume(boxMesh(10, 10, 10))).toBeCloseTo(1000, 6);
    expect(meshVolume(cylinderMesh(5, 20, 64))).toBeCloseTo(regularPolygonArea(5, 64) * 20, 4);
    const flipped = boxMesh(2, 3, 4);
    for (let i = 0; i < flipped.indices.length; i += 3) [flipped.indices[i + 1], flipped.indices[i + 2]] = [flipped.indices[i + 2], flipped.indices[i + 1]];
    expect(signedVolume(flipped)).toBeCloseTo(-24, 6);
    expect(meshVolume(flipped)).toBeCloseTo(24, 6);
  });

  it('穴あき板の体積 = (板の面積 - 穴の多角形の面積) × 厚さ', () => {
    const m = plateWithHole({ w: 80, d: 50, t: 8, r: 12, n: 48 });
    expect(meshVolume(m)).toBeCloseTo((80 * 50 - regularPolygonArea(12, 48)) * 8, 3);
  });
});

describe('頂点の統合と整理', () => {
  it('許容差以内の頂点を統合し、許容差より離れた頂点は統合しない', () => {
    const m: TriMesh = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1e-5, 0, 0, 1, 1, 0, 0, 1.5, 0]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
    };
    const w = weldVertices(m, 1e-4);
    expect(w.mesh.positions.length / 3).toBe(5); // 0 と 3 が 1 つに
    expect(w.merged).toBe(1);
    expect(weldVertices(m, 1e-7).mesh.positions.length / 3).toBe(6);
  });

  it('格子の境界をまたぐ近い頂点も統合する', () => {
    // 許容差 1 → 格子の 1 辺は 64。63.9 と 64.1 は別の格子にあるが、距離 0.2 で統合される
    const m: TriMesh = { positions: Float32Array.from([0, 0, 0, 63.9, 0, 0, 64.1, 0, 0, 0, 100, 0, 200, 100, 0]), indices: Uint32Array.from([0, 1, 3, 2, 3, 4]) };
    expect(weldVertices(m, 1).mesh.positions.length / 3).toBe(4);
  });

  it('つぶれた三角形と、同じ 3 頂点の重複した三角形を取り除く', () => {
    const base = boxMesh(10, 10, 10);
    const idx = Array.from(base.indices);
    idx.push(0, 0, 1); // 頂点が重複
    idx.push(base.indices[0], base.indices[1], base.indices[2]); // 同じ三角形をもう一度
    idx.push(base.indices[2], base.indices[0], base.indices[1]); // 同じ三角形を並び替えて
    const c = cleanMesh({ positions: base.positions, indices: Uint32Array.from(idx) });
    expect(c.report.removedDegenerate).toBe(1);
    expect(c.report.removedDuplicate).toBe(2);
    expect(c.mesh.indices.length / 3).toBe(12);
    expect(checkWatertight(c.mesh).watertight).toBe(true);
  });

  it('面積がほぼ 0 の三角形（3 点が一直線）も取り除く', () => {
    const m: TriMesh = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2, 0, 1, 3]) };
    const c = cleanMesh(m);
    expect(c.report.removedDegenerate).toBe(1);
    expect(c.mesh.indices.length / 3).toBe(1);
    expect(c.mesh.positions.length / 3).toBe(3); // 使われなくなった頂点は詰める
  });
});

describe('水密性の確認', () => {
  it('立方体・円柱・穴あき板・L 字は水密', () => {
    const l = extrudePolygon(
      [
        [0, 0],
        [40, 0],
        [40, 10],
        [10, 10],
        [10, 40],
        [0, 40],
      ],
      0,
      5,
    );
    for (const m of [boxMesh(1, 2, 3), cylinderMesh(5, 10, 24), plateWithHole({ w: 80, d: 50, t: 8, r: 12 }), l, boxMesh(1, 1, 1, [0, 0, 0], 4)]) {
      const r = checkWatertight(cleanMesh(unindex(m)).mesh);
      expect(r).toMatchObject({ boundaryEdges: 0, nonManifoldEdges: 0, watertight: true });
    }
  });

  it('三角形を 1 つ欠いた立方体は、穴の縁 3 本として検出する', () => {
    const r = checkWatertight(cleanMesh(unindex(dropTriangle(boxMesh(10, 10, 10), 3))).mesh);
    expect(r.boundaryEdges).toBe(3);
    expect(r.nonManifoldEdges).toBe(0);
    expect(r.watertight).toBe(false);
  });

  it('1 辺を 3 枚の面が共有していたら非多様体として検出する', () => {
    const base = boxMesh(10, 10, 10);
    const pos = Array.from(base.positions);
    pos.push(-5, -5, -5); // 頂点 8: 立方体の辺（0 と 1）にひれを付ける
    const idx = [...base.indices, base.indices[0], base.indices[1], 8];
    const r = checkWatertight({ positions: Float32Array.from(pos), indices: Uint32Array.from(idx) });
    expect(r.nonManifoldEdges).toBe(1);
    expect(r.boundaryEdges).toBe(2);
    expect(r.watertight).toBe(false);
  });

  it('analyzeMesh: 直したことは fixes、直せない穴は warnings に日本語で出る', () => {
    const ok = analyzeMesh(unindex(boxMesh(10, 10, 10)));
    expect(ok.warnings).toEqual([]);
    expect(ok.fixes.join('')).toMatch(/まとめました/);
    expect(ok.volume).toBeCloseTo(1000, 6);
    expect(ok.triangleCount).toBe(12);

    const holed = analyzeMesh(unindex(dropTriangle(boxMesh(10, 10, 10), 0)));
    expect(holed.watertight.watertight).toBe(false);
    expect(holed.warnings).toHaveLength(1);
    expect(holed.warnings[0]).toMatch(/穴があいています.*3 本.*3D プリント/);

    const empty = analyzeMesh({ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]), indices: Uint32Array.from([0, 1, 2]) });
    expect(empty.warnings[0]).toMatch(/使える三角形がありません/);
  });
});
