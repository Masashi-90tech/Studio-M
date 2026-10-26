import { describe, expect, it } from 'vitest';
import type { Mesh3D } from '../core/types';
import { analyzeMesh } from '../mesh3d/mesh';
import { boxMesh, cylinderMesh } from '../mesh3d/primitives';
import { triangleArea, triangleCount, triangleNormals } from './faces';
import { refineForDisplay } from './refine';

const box = analyzeMesh(boxMesh(0.08, 0.05, 0.008)).mesh as Mesh3D;

const totalArea = (m: Mesh3D): number => {
  let s = 0;
  for (let t = 0; t < triangleCount(m); t++) s += triangleArea(m, t);
  return s;
};

describe('表示用に三角形を割る', () => {
  it('形（表面積・法線の向き）は変わらず、すべての辺が上限以下になる', () => {
    const r = refineForDisplay(box, { maxEdge: 0.004 });
    expect(r.refined).toBe(true);
    expect(triangleCount(r.mesh)).toBeGreaterThan(triangleCount(box));
    expect(totalArea(r.mesh)).toBeCloseTo(totalArea(box), 6);
    const p = r.mesh.positions;
    for (let t = 0; t < triangleCount(r.mesh); t++) {
      for (let k = 0; k < 3; k++) {
        const a = r.mesh.indices[t * 3 + k] * 3;
        const b = r.mesh.indices[t * 3 + ((k + 1) % 3)] * 3;
        expect(Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2])).toBeLessThanOrEqual(0.004 * 1.0001);
      }
    }
    // 割る前と同じ向き（外向き）のまま
    const n0 = triangleNormals(box);
    const n1 = triangleNormals(r.mesh);
    for (let t = 0; t < triangleCount(r.mesh); t++) {
      const o = r.origin[t];
      expect(n1[t * 3] * n0[o * 3] + n1[t * 3 + 1] * n0[o * 3 + 1] + n1[t * 3 + 2] * n0[o * 3 + 2]).toBeGreaterThan(0.999);
    }
  });

  it('origin は、割った三角形がどの元の三角形に属するか（元の面積の合計と一致する）', () => {
    const r = refineForDisplay(box, { maxEdge: 0.005 });
    const area = new Float64Array(triangleCount(box));
    for (let t = 0; t < triangleCount(r.mesh); t++) area[r.origin[t]] += triangleArea(r.mesh, t);
    for (let o = 0; o < triangleCount(box); o++) expect(area[o]).toBeCloseTo(triangleArea(box, o), 6);
  });

  it('割る必要がなければ元のメッシュをそのまま返す', () => {
    const r = refineForDisplay(box, { maxEdge: 1 });
    expect(r.refined).toBe(false);
    expect(r.mesh).toBe(box);
    expect(Array.from(r.origin)).toEqual(Array.from({ length: triangleCount(box) }, (_, i) => i));
  });

  it('三角形の数の上限を超えそうなときは、辺を長くして上限に収める', () => {
    const cyl = analyzeMesh(cylinderMesh(0.05, 0.2, 32)).mesh as Mesh3D;
    const r = refineForDisplay(cyl, { maxEdge: 0.0001, maxTriangles: 5000 });
    expect(triangleCount(r.mesh)).toBeLessThanOrEqual(5000);
    expect(totalArea(r.mesh)).toBeCloseTo(totalArea(cyl), 6);
  });
});
