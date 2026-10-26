// 三角形メッシュを、軸に垂直な平面で切って 2D の輪（外形と穴）にする。DOM に依存しない。
//
// 手順:
//  1. 平面を ε（外接箱の対角線の 1e-7 倍）だけずらし、頂点を「平面の上 / 下」に分ける。どの頂点も平面の上にはぴったり乗らないので、
//     頂点や辺が平面上にあっても、交点が重なったり線分が抜けたりしない
//  2. 上下にまたがる三角形ごとに、交線の線分を 1 本作る。交点は「メッシュの辺」で見分ける（隣の三角形と同じ辺なら同じ点）。
//     そのため、頂点が統合された（mesh.ts の cleanMesh のあとの）メッシュなら、許容差なしで線分がつながる
//  3. 線分をつないで輪にする。つながらなかった鎖は、端点が許容差以内なら結び、小さな隙間は直線で閉じる。それでも閉じないものは捨てて数える
//  4. 輪の入れ子を偶奇で決める（外形 = 偶数の深さ、穴 = 奇数の深さ）。細かすぎる点は Douglas–Peucker で間引く
//
// 断面の 2D 座標: Z で切るなら (x, y)、X で切るなら (y, z)、Y で切るなら (x, z)。
// Z が上のモデルなら、どの軸で切っても画面の上が Z になる。
import { boxDiagonal, meshBounds } from './mesh';
import type { Axis, TriMesh } from './types';

export interface SliceOptions {
  axis: Axis;
  /** 切る位置（モデルの単位） */
  position: number;
  /** 端点が一致するとみなす距離。省略時は外接箱の対角線の 1e-6 倍 */
  tol?: number;
  /** Douglas–Peucker の許容差（モデルの単位）。省略時は断面の外接箱の対角線の 2e-4 倍。0 なら一直線上の点だけを減らす */
  simplify?: number;
  /** 1 つの輪の頂点数の上限。超えるときは許容差を広げて減らす。省略時 1000 */
  maxVertices?: number;
  /** 閉じていない鎖の両端がこの距離（断面の外接箱の対角線に対する割合）以内なら、直線で閉じる。省略時 0.02、0 なら閉じない */
  closeGap?: number;
}

export interface SliceLoop {
  /** 頂点（モデルの単位、断面の座標）。外形は反時計回り、穴は時計回り。先頭を末尾に繰り返さない */
  points: [number, number][];
  /** 面積の絶対値 */
  area: number;
  /** 入れ子の深さ（0 = 一番外の外形、1 = その穴、2 = 穴の中の島…） */
  depth: number;
  /** 穴か（深さが奇数） */
  hole: boolean;
}

export interface SliceResult {
  axis: Axis;
  position: number;
  /** 断面の x に使った 3D の軸 */
  uAxis: Axis;
  /** 断面の y に使った 3D の軸 */
  vAxis: Axis;
  /** 浅い順、同じ深さでは面積の大きい順 */
  loops: SliceLoop[];
  /** 閉じられなかった線分の数 */
  openSegments: number;
  /** 小さな隙間を直線で閉じた数 */
  closedGaps: number;
  /** 細かすぎて捨てた輪の数 */
  droppedTiny: number;
  /** 断面の外接箱 [u0, v0, u1, v1]（輪がなければ null） */
  bounds2d: [number, number, number, number] | null;
  /** 切った軸方向のモデルの範囲 [最小, 最大] */
  axisRange: [number, number];
  /** 利用者に知らせる注意（何が起きていて、どうすれば直るか） */
  warnings: string[];
}

/** 切る軸 → 断面の (x, y) に使う 3D の軸 */
export function sliceAxes(axis: Axis): { uAxis: Axis; vAxis: Axis } {
  if (axis === 2) return { uAxis: 0, vAxis: 1 };
  if (axis === 0) return { uAxis: 1, vAxis: 2 };
  return { uAxis: 0, vAxis: 2 };
}

type Pt = [number, number];

function signedArea(pts: Pt[]): number {
  if (pts.length < 3) return 0;
  const [ox, oy] = pts[0];
  let a = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    a += (pts[i][0] - ox) * (pts[i + 1][1] - oy) - (pts[i + 1][0] - ox) * (pts[i][1] - oy);
  }
  return a / 2;
}

/** 偶奇規則（レイキャスト）で、点が多角形の内側か */
export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  const [x, y] = p;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a];
    const [xb, yb] = poly[b];
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** 開いた折れ線 pts[lo..hi] の Douglas–Peucker。残す点の印を keep に付ける（両端は残す） */
function douglasPeucker(pts: Pt[], lo: number, hi: number, tol: number, keep: Uint8Array): void {
  keep[lo] = 1;
  keep[hi] = 1;
  const stack: [number, number][] = [[lo, hi]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let dmax = tol;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i], pts[a], pts[b]);
      if (d > dmax) {
        dmax = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
}

/** 閉じた輪の間引き。最初の点と、そこから一番遠い点で 2 つに分けて、それぞれ Douglas–Peucker をかける */
export function simplifyLoop(pts: Pt[], tol: number, maxVertices: number): Pt[] {
  if (pts.length <= 3) return pts;
  const run = (src: Pt[], t: number): Pt[] => {
    let far = 0;
    let best = -1;
    for (let i = 1; i < src.length; i++) {
      const d = Math.hypot(src[i][0] - src[0][0], src[i][1] - src[0][1]);
      if (d > best) {
        best = d;
        far = i;
      }
    }
    const keep = new Uint8Array(src.length);
    const first = src.slice(0, far + 1);
    const second = [...src.slice(far), src[0]];
    const k1 = new Uint8Array(first.length);
    const k2 = new Uint8Array(second.length);
    douglasPeucker(first, 0, first.length - 1, t, k1);
    douglasPeucker(second, 0, second.length - 1, t, k2);
    for (let i = 0; i < first.length; i++) if (k1[i]) keep[i] = 1;
    for (let i = 0; i < second.length - 1; i++) if (k2[i]) keep[far + i] = 1;
    return dropCollinear(
      src.filter((_, i) => keep[i]),
      t,
    );
  };
  let t = tol;
  let out = run(pts, t);
  // 上限を超えるときは、許容差を広げながら、直前の結果をさらに間引く（元の点列から何度もやり直さない）
  for (let guard = 0; out.length > maxVertices && guard < 60; guard++) {
    t = Math.max(t * 1.5, 1e-12);
    out = run(out, t);
  }
  return out;
}

/** 両隣の点を結ぶ線分から tol 以内にある点を取り除く（最初の点・一番遠い点が辺の途中にあると、DP では残るため） */
function dropCollinear(pts: Pt[], tol: number): Pt[] {
  let cur = pts;
  for (let pass = 0; pass < 8 && cur.length > 3; pass++) {
    const next: Pt[] = [];
    for (let i = 0; i < cur.length; i++) {
      const prev = next.length > 0 ? next[next.length - 1] : cur[cur.length - 1];
      if (cur.length - (i - next.length) > 3 && distToSegment(cur[i], prev, cur[(i + 1) % cur.length]) <= tol) continue;
      next.push(cur[i]);
    }
    if (next.length === cur.length) break;
    cur = next;
  }
  return cur;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 閉じていない鎖のうち、端点が tol 以内のもの同士を結ぶ。鎖が多すぎるときは何もしない */
function joinChains(chains: Pt[][], tol: number): Pt[][] {
  if (chains.length > 300) return chains;
  const list = chains.map((c) => c.slice());
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let merged: Pt[] | null = null;
        if (dist(a[a.length - 1], b[0]) <= tol) merged = [...a, ...b.slice(1)];
        else if (dist(a[a.length - 1], b[b.length - 1]) <= tol) merged = [...a, ...b.slice(0, -1).reverse()];
        else if (dist(a[0], b[b.length - 1]) <= tol) merged = [...b, ...a.slice(1)];
        else if (dist(a[0], b[0]) <= tol) merged = [...a.slice().reverse(), ...b.slice(1)];
        if (merged) {
          list[i] = merged;
          list.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return list;
}

/** 平面でメッシュを切る。頂点が統合されたメッシュ（cleanMesh のあと）を渡すこと */
export function sliceMesh(mesh: TriMesh, opts: SliceOptions): SliceResult {
  const { axis, position } = opts;
  const { uAxis, vAxis } = sliceAxes(axis);
  const bounds = meshBounds(mesh);
  const diag = boxDiagonal(bounds);
  const tol = opts.tol ?? Math.max(diag * 1e-6, 1e-12);
  const eps = Math.max(diag * 1e-7, 1e-12);
  const plane = position + eps;
  const { positions, indices } = mesh;
  const vertexCount = positions.length / 3;

  // 1. 頂点を平面の上 / 下に分ける
  const above = new Uint8Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) above[v] = positions[v * 3 + axis] >= plane ? 1 : 0;

  // 2. 交線の線分
  const pu: number[] = [];
  const pv: number[] = [];
  const pointOfEdge = new Map<number, number>();
  const crossing = (a: number, b: number): number => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = lo * vertexCount + hi;
    let id = pointOfEdge.get(key);
    if (id === undefined) {
      const clo = positions[lo * 3 + axis];
      const chi = positions[hi * 3 + axis];
      const t = (plane - clo) / (chi - clo);
      id = pu.length;
      pu.push(positions[lo * 3 + uAxis] + t * (positions[hi * 3 + uAxis] - positions[lo * 3 + uAxis]));
      pv.push(positions[lo * 3 + vAxis] + t * (positions[hi * 3 + vAxis] - positions[lo * 3 + vAxis]));
      pointOfEdge.set(key, id);
    }
    return id;
  };
  const sa: number[] = [];
  const sb: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    const ua = above[a];
    const ub = above[b];
    const uc = above[c];
    const n = ua + ub + uc;
    if (n === 0 || n === 3) continue;
    // 1 つだけ反対側にある頂点
    const lone = n === 1 ? (ua ? a : ub ? b : c) : !ua ? a : !ub ? b : c;
    const m1 = lone === a ? b : a;
    const m2 = lone === c ? b : c;
    sa.push(crossing(lone, m1));
    sb.push(crossing(lone, m2));
  }

  // 3. 線分をつないで輪にする
  const adj: number[][] = Array.from({ length: pu.length }, () => []);
  for (let s = 0; s < sa.length; s++) {
    adj[sa[s]].push(s);
    adj[sb[s]].push(s);
  }
  const used = new Uint8Array(sa.length);
  const closed: Pt[][] = [];
  let chains: Pt[][] = [];
  const pt = (id: number): Pt => [pu[id], pv[id]];
  const takeNext = (node: number): number => {
    for (const s of adj[node]) {
      if (!used[s]) {
        used[s] = 1;
        return sa[s] === node ? sb[s] : sa[s];
      }
    }
    return -1;
  };
  for (let s = 0; s < sa.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    let ids = [sa[s], sb[s]];
    let isClosed = false;
    for (;;) {
      const nxt = takeNext(ids[ids.length - 1]);
      if (nxt < 0) break;
      if (nxt === ids[0]) {
        isClosed = true;
        break;
      }
      ids.push(nxt);
    }
    if (!isClosed) {
      const back: number[] = [];
      for (;;) {
        const nxt = takeNext(back.length > 0 ? back[back.length - 1] : ids[0]);
        if (nxt < 0) break;
        back.push(nxt);
      }
      ids = [...back.reverse(), ...ids];
    }
    const pts = ids.map(pt);
    if (isClosed) closed.push(pts);
    else chains.push(pts);
  }

  const segmentCount = sa.length;
  const u0 = bounds.min[uAxis];
  const u1 = bounds.max[uAxis];
  const v0 = bounds.min[vAxis];
  const v1 = bounds.max[vAxis];
  const diag2 = Math.max(Math.hypot(u1 - u0, v1 - v0), 1e-12);

  // 端点が許容差以内の鎖を結び、閉じたものは輪にする
  let openSegments = 0;
  let closedGaps = 0;
  chains = joinChains(chains, tol);
  const closeRatio = opts.closeGap ?? 0.02;
  for (const c of chains) {
    if (c.length >= 4 && dist(c[0], c[c.length - 1]) <= tol) {
      closed.push(c.slice(0, -1));
    } else if (c.length >= 3 && closeRatio > 0 && dist(c[0], c[c.length - 1]) <= closeRatio * diag2) {
      closed.push(c);
      closedGaps++;
    } else {
      openSegments += c.length - 1;
    }
  }

  // 4. 輪の整理（重複点の削除・間引き・小さすぎる輪の削除）
  const simplifyTol = Math.max(opts.simplify ?? diag2 * 2e-4, diag2 * 1e-9);
  const maxVertices = Math.max(8, Math.floor(opts.maxVertices ?? 1000));
  const minArea = diag2 * diag2 * 1e-9;
  let droppedTiny = 0;
  const prepared: { points: Pt[]; area: number }[] = [];
  for (const raw of closed) {
    const dedup: Pt[] = [];
    for (const p of raw) if (dedup.length === 0 || dist(p, dedup[dedup.length - 1]) > tol) dedup.push(p);
    while (dedup.length > 1 && dist(dedup[0], dedup[dedup.length - 1]) <= tol) dedup.pop();
    if (dedup.length < 3 || Math.abs(signedArea(dedup)) < minArea) {
      droppedTiny++;
      continue;
    }
    const pts = simplifyLoop(dedup, simplifyTol, maxVertices);
    const area = Math.abs(signedArea(pts));
    if (pts.length < 3 || area < minArea) {
      droppedTiny++;
      continue;
    }
    prepared.push({ points: pts, area });
  }

  // 入れ子（偶奇）。面積が大きく、中に代表点（最初の辺の中点）を含む輪の数が深さ
  const loops: SliceLoop[] = prepared.map((l, i) => {
    const probe: Pt = [(l.points[0][0] + l.points[1][0]) / 2, (l.points[0][1] + l.points[1][1]) / 2];
    let depth = 0;
    for (let j = 0; j < prepared.length; j++) {
      if (j !== i && prepared[j].area > l.area && pointInPolygon(probe, prepared[j].points)) depth++;
    }
    const hole = depth % 2 === 1;
    // 外形は反時計回り、穴は時計回りにそろえる
    const ccw = signedArea(l.points) > 0;
    const points = ccw === !hole ? l.points : l.points.slice().reverse();
    return { points, area: l.area, depth, hole };
  });
  loops.sort((a, b) => a.depth - b.depth || b.area - a.area);

  let bounds2d: [number, number, number, number] | null = null;
  for (const l of loops) {
    for (const [x, y] of l.points) {
      if (!bounds2d) bounds2d = [x, y, x, y];
      else {
        if (x < bounds2d[0]) bounds2d[0] = x;
        if (y < bounds2d[1]) bounds2d[1] = y;
        if (x > bounds2d[2]) bounds2d[2] = x;
        if (y > bounds2d[3]) bounds2d[3] = y;
      }
    }
  }

  const warnings: string[] = [];
  if (segmentCount === 0) {
    warnings.push('この位置にはモデルがなく、断面が空です。スライダーでモデルの内側の位置を選んでください。');
  }
  if (openSegments > 0) {
    warnings.push(
      `断面の輪が閉じていない所があります（線分 ${openSegments} 本を使えませんでした）。モデルに穴があいているか、別々の部品が重なっている可能性があります。` +
        '別の位置で切るか、Blender の 3D プリントツールボックスなどで穴を埋めてから書き出し直してください。',
    );
  }
  if (closedGaps > 0) warnings.push(`断面の小さな隙間を ${closedGaps} か所、直線でつないで閉じました。モデルの穴の影響で、形が少しずれているかもしれません。`);
  if (droppedTiny > 0) warnings.push(`細かすぎる輪を ${droppedTiny} 個、無視しました。`);

  return {
    axis,
    position,
    uAxis,
    vAxis,
    loops,
    openSegments,
    closedGaps,
    droppedTiny,
    bounds2d,
    axisRange: [bounds.min[axis], bounds.max[axis]],
    warnings,
  };
}

/** 断面の輪を 3D の線分（x1 y1 z1 x2 y2 z2 の並び）にする。ビューアで切り口を重ねて見せるのに使う */
export function sectionSegments3D(slice: SliceResult): Float32Array {
  let n = 0;
  for (const l of slice.loops) n += l.points.length;
  const out = new Float32Array(n * 6);
  let o = 0;
  const put = (p: Pt): void => {
    const c: [number, number, number] = [0, 0, 0];
    c[slice.uAxis] = p[0];
    c[slice.vAxis] = p[1];
    c[slice.axis] = slice.position;
    out[o++] = c[0];
    out[o++] = c[1];
    out[o++] = c[2];
  };
  for (const l of slice.loops) {
    for (let i = 0; i < l.points.length; i++) {
      put(l.points[i]);
      put(l.points[(i + 1) % l.points.length]);
    }
  }
  return out;
}
