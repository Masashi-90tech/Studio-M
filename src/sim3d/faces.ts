// 面の選択に使う純粋な計算（DOM に依存しない）。
//
// - 光線と三角形の交差（クリックした位置の三角形を求める）
// - 三角形のつながり（辺を共有する隣の三角形）と、ほぼ同じ向きの三角形をまとめて選ぶ
//   平らな面は 1 枚の面として、なめらかな曲面（円柱の側面など）も 1 つのまとまりとして選べる
// 三角形の番号は Mesh3D.indices を 3 で割った番号（Region3D.faces と同じ）。
import type { Mesh3D } from '../core/types';

export type Vec3 = [number, number, number];

export interface Ray {
  origin: Vec3;
  /** 向き（長さは何でもよい） */
  dir: Vec3;
}

export interface RayHit {
  /** 三角形の番号 */
  tri: number;
  /** 光線の origin からの距離（dir を単位ベクトルにしたとき） */
  t: number;
  point: Vec3;
}

/** 辺を共有する三角形どうしの法線の角度が、これ以下ならひとつながりの面とみなす [度] */
export const SMOOTH_ANGLE_DEG = 25;

/** 三角形の数 */
export function triangleCount(mesh: Mesh3D): number {
  return Math.floor(mesh.indices.length / 3);
}

/**
 * 光線に最初に当たる三角形（表でも裏でも）。accept があれば、それが true の当たりだけを数える
 * （断面で隠した側の面を選ばないため）。当たらなければ null
 */
export function raycastMesh(mesh: Mesh3D, ray: Ray, accept?: (hit: RayHit) => boolean): RayHit | null {
  const { positions: p, indices: idx } = mesh;
  const dl = Math.hypot(ray.dir[0], ray.dir[1], ray.dir[2]);
  if (!(dl > 0)) return null;
  const dx = ray.dir[0] / dl;
  const dy = ray.dir[1] / dl;
  const dz = ray.dir[2] / dl;
  const [ox, oy, oz] = ray.origin;
  let best: RayHit | null = null;
  const EPS = 1e-12;
  const n = triangleCount(mesh);
  for (let t = 0; t < n; t++) {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const e1x = p[b] - p[a];
    const e1y = p[b + 1] - p[a + 1];
    const e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a];
    const e2y = p[c + 1] - p[a + 1];
    const e2z = p[c + 2] - p[a + 2];
    // Möller–Trumbore
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < EPS * (Math.abs(e1x) + Math.abs(e1y) + Math.abs(e1z) + 1e-30)) continue;
    const inv = 1 / det;
    const sx = ox - p[a];
    const sy = oy - p[a + 1];
    const sz = oz - p[a + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (tt <= 0) continue;
    if (best && tt >= best.t) continue;
    const hit: RayHit = { tri: t, t: tt, point: [ox + dx * tt, oy + dy * tt, oz + dz * tt] };
    if (accept && !accept(hit)) continue;
    best = hit;
  }
  return best;
}

/** 三角形ごとの単位法線（3 つずつ並べる）。面積のない三角形は 0 */
export function triangleNormals(mesh: Mesh3D): Float64Array {
  const { positions: p, indices: idx } = mesh;
  const n = triangleCount(mesh);
  const out = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const e1x = p[b] - p[a];
    const e1y = p[b + 1] - p[a + 1];
    const e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a];
    const e2y = p[c + 1] - p[a + 1];
    const e2z = p[c + 2] - p[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) {
      out[t * 3] = nx / l;
      out[t * 3 + 1] = ny / l;
      out[t * 3 + 2] = nz / l;
    }
  }
  return out;
}

/** 三角形の面積 [m²] */
export function triangleArea(mesh: Mesh3D, t: number): number {
  const { positions: p, indices: idx } = mesh;
  const a = idx[t * 3] * 3;
  const b = idx[t * 3 + 1] * 3;
  const c = idx[t * 3 + 2] * 3;
  const e1x = p[b] - p[a];
  const e1y = p[b + 1] - p[a + 1];
  const e1z = p[b + 2] - p[a + 2];
  const e2x = p[c] - p[a];
  const e2y = p[c + 1] - p[a + 1];
  const e2z = p[c + 2] - p[a + 2];
  return 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
}

/** 三角形の集まりの面積の合計 [m²] */
export function facesArea(mesh: Mesh3D, faces: ArrayLike<number>): number {
  const n = triangleCount(mesh);
  let s = 0;
  for (let i = 0; i < faces.length; i++) if (faces[i] >= 0 && faces[i] < n) s += triangleArea(mesh, faces[i]);
  return s;
}

/** 位置がまったく同じ頂点を 1 つにまとめた番号（頂点を共有しない STL のままのメッシュでも、つながりを辿れるように） */
export function canonicalVertices(mesh: Mesh3D): Int32Array {
  const p = mesh.positions;
  const nv = Math.floor(p.length / 3);
  const bits = new Int32Array(p.buffer, p.byteOffset, p.length);
  const out = new Int32Array(nv);
  const buckets = new Map<number, number[]>();
  for (let v = 0; v < nv; v++) {
    // -0 と 0 を同じに扱う
    const x = bits[v * 3] === -2147483648 ? 0 : bits[v * 3];
    const y = bits[v * 3 + 1] === -2147483648 ? 0 : bits[v * 3 + 1];
    const z = bits[v * 3 + 2] === -2147483648 ? 0 : bits[v * 3 + 2];
    const key = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
    const list = buckets.get(key);
    let found = -1;
    if (list) {
      for (const w of list) {
        if (p[w * 3] === p[v * 3] && p[w * 3 + 1] === p[v * 3 + 1] && p[w * 3 + 2] === p[v * 3 + 2]) {
          found = w;
          break;
        }
      }
      if (found < 0) list.push(v);
    } else {
      buckets.set(key, [v]);
    }
    out[v] = found < 0 ? v : found;
  }
  return out;
}

export interface FaceGraph {
  triangles: number;
  /** 三角形 t の辺 k（頂点 k と k+1 の間）の向こう側の三角形。なければ -1 */
  neighbors: Int32Array;
  normals: Float64Array;
}

/** 辺を共有する三角形のつながりを作る。3 枚以上が 1 つの辺を共有するところ（非多様体）は、最初の 2 枚だけをつなぐ */
export function buildFaceGraph(mesh: Mesh3D): FaceGraph {
  const n = triangleCount(mesh);
  const canon = canonicalVertices(mesh);
  const neighbors = new Int32Array(n * 3).fill(-1);
  const open = new Map<number, number>(); // 辺 → (三角形 × 3 + 辺の番号)
  const nv = Math.max(1, canon.length);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const a = canon[mesh.indices[t * 3 + k]];
      const b = canon[mesh.indices[t * 3 + ((k + 1) % 3)]];
      if (a === b) continue;
      const key = Math.min(a, b) * nv + Math.max(a, b);
      const other = open.get(key);
      if (other === undefined) {
        open.set(key, t * 3 + k);
      } else if (neighbors[other] < 0) {
        const ot = Math.floor(other / 3);
        neighbors[other] = t;
        neighbors[t * 3 + k] = ot;
      }
    }
  }
  return { triangles: n, neighbors, normals: triangleNormals(mesh) };
}

/**
 * seed の三角形から、辺でつながっていて、となりどうしの法線の角度が maxAngleDeg 以下の三角形をまとめて選ぶ。
 * 平らな面はそのまま 1 枚、なめらかな曲面はひとまとまりになり、角（折れ目）で止まる。番号の小さい順で返す
 */
export function selectConnectedFaces(graph: FaceGraph, seed: number, maxAngleDeg = SMOOTH_ANGLE_DEG): number[] {
  if (seed < 0 || seed >= graph.triangles) return [];
  const cosLimit = Math.cos((maxAngleDeg * Math.PI) / 180);
  const N = graph.normals;
  const seen = new Uint8Array(graph.triangles);
  const stack = [seed];
  seen[seed] = 1;
  const out: number[] = [];
  while (stack.length > 0) {
    const t = stack.pop()!;
    out.push(t);
    for (let k = 0; k < 3; k++) {
      const u = graph.neighbors[t * 3 + k];
      if (u < 0 || seen[u]) continue;
      const cos = N[t * 3] * N[u * 3] + N[t * 3 + 1] * N[u * 3 + 1] + N[t * 3 + 2] * N[u * 3 + 2];
      if (cos < cosLimit) continue;
      seen[u] = 1;
      stack.push(u);
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * 選択の更新。additive でないときは置き換え。additive のときは、すでに選んでいる面をもう一度クリックしたら外し、
 * そうでなければ足す。picked は今回クリックしてまとまった面
 */
export function updateSelection(current: ReadonlySet<number>, picked: readonly number[], additive: boolean): Set<number> {
  if (!additive) return new Set(picked);
  const next = new Set(current);
  const allIn = picked.length > 0 && picked.every((t) => current.has(t));
  for (const t of picked) {
    if (allIn) next.delete(t);
    else next.add(t);
  }
  return next;
}
