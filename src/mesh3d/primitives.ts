// 簡単な立体をコードで作る（ダイアログの「サンプル」と、テストの試験体に使う）。DOM に依存しない。
// どれも閉じた立体（水密）で、面の向きは外向き。
import type { TriMesh } from './types';

type Pt = [number, number];

/** 多角形（反時計回り）を耳切り法で三角形に分ける。戻り値は多角形の頂点番号の 3 つ組 */
export function triangulate(poly: readonly Pt[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  const idx = poly.map((_, i) => i);
  const cross = (a: Pt, b: Pt, c: Pt): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  // 切り取る対角線 c→a の上にある頂点も「中」とみなす（一直線に並ぶ頂点をまたぐと、面積 0 の三角形ができて立体に穴があく）
  const inside = (p: Pt, a: Pt, b: Pt, c: Pt): boolean => cross(a, b, p) > 1e-12 && cross(b, c, p) > 1e-12 && cross(c, a, p) >= -1e-12;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = -1;
    for (let i = 0; i < idx.length && cut < 0; i++) {
      const a = idx[(i + idx.length - 1) % idx.length];
      const b = idx[i];
      const c = idx[(i + 1) % idx.length];
      if (cross(poly[a], poly[b], poly[c]) <= 1e-12) continue;
      if (idx.some((k) => k !== a && k !== b && k !== c && inside(poly[k], poly[a], poly[b], poly[c]))) continue;
      cut = i;
    }
    if (cut < 0) cut = 0; // 退化した多角形でも止まらないようにする
    const a = idx[(cut + idx.length - 1) % idx.length];
    const b = idx[cut];
    const c = idx[(cut + 1) % idx.length];
    out.push([a, b, c]);
    idx.splice(cut, 1);
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/**
 * 多角形（反時計回り、穴なし）を z0 から z1 まで押し出した立体。
 * layers を 2 以上にすると、側面を z 方向に等分する（途中の高さにも頂点ができる）。
 */
export function extrudePolygon(poly: readonly Pt[], z0: number, z1: number, layers = 1): TriMesh {
  const n = poly.length;
  const rings = layers + 1;
  const positions = new Float32Array(n * rings * 3);
  for (let r = 0; r < rings; r++) {
    const z = z0 + ((z1 - z0) * r) / layers;
    for (let i = 0; i < n; i++) positions.set([poly[i][0], poly[i][1], z], (r * n + i) * 3);
  }
  const idx: number[] = [];
  for (const [a, b, c] of triangulate(poly)) {
    idx.push(a, c, b); // 下の面（外向き = 下向き）
    const o = layers * n;
    idx.push(o + a, o + b, o + c); // 上の面
  }
  for (let r = 0; r < layers; r++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = r * n + i;
      const b = r * n + j;
      const c = (r + 1) * n + j;
      const d = (r + 1) * n + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  return { positions, indices: Uint32Array.from(idx) };
}

/** 直方体（角は origin、大きさは w × d × h） */
export function boxMesh(w: number, d: number, h: number, origin: [number, number, number] = [0, 0, 0], layers = 1): TriMesh {
  const [x, y, z] = origin;
  return extrudePolygon(
    [
      [x, y],
      [x + w, y],
      [x + w, y + d],
      [x, y + d],
    ],
    z,
    z + h,
    layers,
  );
}

/** 円柱を n 角形で近似したもの（底面の中心が (cx, cy, z0)、軸は Z） */
export function cylinderMesh(r: number, h: number, n: number, center: [number, number] = [0, 0], z0 = 0): TriMesh {
  const poly: Pt[] = [];
  for (let k = 0; k < n; k++) poly.push([center[0] + r * Math.cos((2 * Math.PI * k) / n), center[1] + r * Math.sin((2 * Math.PI * k) / n)]);
  return extrudePolygon(poly, z0, z0 + h);
}

/** 正 n 角形の面積（外接円の半径 r） */
export function regularPolygonArea(r: number, n: number): number {
  return 0.5 * n * r * r * Math.sin((2 * Math.PI) / n);
}

/**
 * 四角い板（0..w × 0..d、厚さ t）の中央に、半径 r の円（n 角形で近似）の穴をあけた形。
 * 穴は板を貫通する。穴の頂点は、板の角の方向からずらしてある。
 */
export function plateWithHole(opts: { w: number; d: number; t: number; r: number; n?: number }): TriMesh {
  const { w, d, t, r } = opts;
  const n = opts.n ?? 32;
  const c: Pt = [w / 2, d / 2];
  const TWO_PI = 2 * Math.PI;
  const angles: number[] = [];
  for (let k = 0; k < n; k++) angles.push((TWO_PI * (k + 0.5)) / n);
  const inner: Pt[] = angles.map((a) => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  // 中心から角度 a の向きに伸ばした線が、四角形の縁に当たる点
  const hit = (a: number): Pt => {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const tx = dx > 0 ? (w - c[0]) / dx : dx < 0 ? -c[0] / dx : Infinity;
    const ty = dy > 0 ? (d - c[1]) / dy : dy < 0 ? -c[1] / dy : Infinity;
    const s = Math.min(tx, ty);
    return [c[0] + dx * s, c[1] + dy * s];
  };
  const corners: { a: number; p: Pt }[] = (
    [
      [w, d],
      [0, d],
      [0, 0],
      [w, 0],
    ] as Pt[]
  ).map((p) => ({ a: (Math.atan2(p[1] - c[1], p[0] - c[0]) + TWO_PI) % TWO_PI, p }));
  const outer: Pt[] = [];
  const outerStart: number[] = [];
  for (let k = 0; k < n; k++) {
    outerStart.push(outer.length);
    outer.push(hit(angles[k]));
    const a0 = angles[k];
    const a1 = k + 1 < n ? angles[k + 1] : angles[0] + TWO_PI;
    for (const cn of corners) {
      const ca = cn.a < a0 ? cn.a + TWO_PI : cn.a;
      if (ca > a0 && ca < a1) outer.push(cn.p);
    }
  }
  const m = outer.length;
  const verts = [...outer, ...inner];
  const positions = new Float32Array(verts.length * 2 * 3);
  verts.forEach((p, i) => {
    positions.set([p[0], p[1], 0], i * 3);
    positions.set([p[0], p[1], t], (verts.length + i) * 3);
  });
  const OB = (i: number): number => i % m;
  const IB = (k: number): number => m + (k % n);
  const top = verts.length;
  const idx: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = outerStart[k];
    const e = k + 1 < n ? outerStart[k + 1] : outerStart[0] + m;
    const chain: number[] = [];
    for (let i = s; i <= e; i++) chain.push(OB(i));
    const tris: [number, number, number][] = [];
    for (let i = 0; i + 1 < chain.length; i++) tris.push([IB(k), chain[i], chain[i + 1]]);
    tris.push([IB(k), chain[chain.length - 1], IB(k + 1)]);
    for (const [a, b, cc] of tris) {
      idx.push(top + a, top + b, top + cc); // 上の面
      idx.push(a, cc, b); // 下の面
    }
  }
  for (let i = 0; i < m; i++) {
    const a = OB(i);
    const b = OB(i + 1);
    idx.push(a, b, top + b, a, top + b, top + a); // 外側の壁
  }
  for (let k = 0; k < n; k++) {
    const a = IB(k);
    const b = IB(k + 1);
    idx.push(b, a, top + a, b, top + a, top + b); // 穴の壁（穴の中心を向く）
  }
  return { positions, indices: Uint32Array.from(idx) };
}

/** ダイアログの「サンプルで試す」に使う形: 80 × 50 × 8 mm の板に、直径 24 mm の穴 */
export function sampleMesh(): TriMesh {
  return plateWithHole({ w: 80, d: 50, t: 8, r: 12, n: 48 });
}
