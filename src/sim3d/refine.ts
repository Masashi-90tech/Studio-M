// 結果の色を滑らかに見せるための表示用メッシュ（DOM に依存しない）。
//
// 頂点ごとに色をつけるので、少ない三角形の平らな面（板の上面は 2 枚、など）は、4 つの角の色だけを混ぜた
// ぼんやりした色になってしまう。そこで、辺が長い三角形を最も長い辺で 2 つに割り、辺が maxEdge 以下になるまで繰り返す。
// 形は変わらない（割った点は元の辺の上にある）。解析に使う形（Study3D.mesh）は元のままで、これは表示だけに使う。
import type { Mesh3D } from '../core/types';

export interface RefinedMesh {
  mesh: Mesh3D;
  /** 表示用の三角形 → 元の三角形の番号 */
  origin: Uint32Array;
  /** 割ったか（false なら mesh は元のメッシュそのもので、origin は 0, 1, 2, … ） */
  refined: boolean;
}

/** 表示用の三角形の数の上限（これを超えないように辺の長さを大きくする） */
export const REFINE_MAX_TRIANGLES = 600_000;

function attempt(mesh: Mesh3D, maxEdge: number, cap: number): RefinedMesh | null {
  const { positions: p, indices: idx } = mesh;
  const nTri = Math.floor(idx.length / 3);
  const verts: number[] = Array.from(p.subarray(0, p.length));
  const mid = new Map<number, number>();
  const midpoint = (a: number, b: number): number => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * 2097152 + hi;
    const hit = mid.get(key);
    if (hit !== undefined) return hit;
    const id = verts.length / 3;
    verts.push((verts[a * 3] + verts[b * 3]) / 2, (verts[a * 3 + 1] + verts[b * 3 + 1]) / 2, (verts[a * 3 + 2] + verts[b * 3 + 2]) / 2);
    mid.set(key, id);
    return id;
  };
  const len2 = (a: number, b: number): number => (verts[a * 3] - verts[b * 3]) ** 2 + (verts[a * 3 + 1] - verts[b * 3 + 1]) ** 2 + (verts[a * 3 + 2] - verts[b * 3 + 2]) ** 2;
  const lim2 = maxEdge * maxEdge;
  const outIdx: number[] = [];
  const outOrigin: number[] = [];
  const stack: number[] = [];
  for (let t = 0; t < nTri; t++) {
    stack.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
    while (stack.length > 0) {
      const c = stack.pop()!;
      const b = stack.pop()!;
      const a = stack.pop()!;
      const ab = len2(a, b);
      const bc = len2(b, c);
      const ca = len2(c, a);
      const longest = Math.max(ab, bc, ca);
      if (longest <= lim2) {
        outIdx.push(a, b, c);
        outOrigin.push(t);
        if (outOrigin.length > cap) return null;
        continue;
      }
      // 最も長い辺を割る（向きは保つ）。後ろに積んだ方から先に処理されるので、順序は問わない
      if (ab >= bc && ab >= ca) {
        const m = midpoint(a, b);
        stack.push(a, m, c, m, b, c);
      } else if (bc >= ca) {
        const m = midpoint(b, c);
        stack.push(a, b, m, a, m, c);
      } else {
        const m = midpoint(c, a);
        stack.push(a, b, m, b, c, m);
      }
      if (outOrigin.length + stack.length / 3 > cap) return null;
    }
  }
  return {
    mesh: { positions: Float32Array.from(verts), indices: Uint32Array.from(outIdx) },
    origin: Uint32Array.from(outOrigin),
    refined: true,
  };
}

/**
 * 辺が maxEdge 以下になるように三角形を割る。三角形が cap を超えるときは maxEdge を少しずつ大きくして作り直す。
 * 割る必要がなければ（すべての辺が短い・三角形がすでに多い）元のメッシュをそのまま返す
 */
export function refineForDisplay(mesh: Mesh3D, opts: { maxEdge: number; maxTriangles?: number }): RefinedMesh {
  const nTri = Math.floor(mesh.indices.length / 3);
  const cap = opts.maxTriangles ?? REFINE_MAX_TRIANGLES;
  const identity: RefinedMesh = { mesh, origin: Uint32Array.from({ length: nTri }, (_, i) => i), refined: false };
  // 頂点番号を 2^21 未満に保つ（辺の鍵を数値 1 つにするため）
  if (!(opts.maxEdge > 0) || nTri === 0 || nTri * 2 > cap || mesh.positions.length / 3 + cap > 2097152) return identity;
  let edge = opts.maxEdge;
  for (let tries = 0; tries < 12; tries++) {
    const r = attempt(mesh, edge, cap);
    if (r) return r.mesh.indices.length === mesh.indices.length ? identity : r;
    edge *= 1.4;
  }
  return identity;
}
