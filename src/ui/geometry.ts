// 図形編集用の幾何ヘルパー（当たり判定・ハンドル・フリーハンド簡略化）。座標はメートル。
import { containsPoint } from '../core/raster';
import type { Shape, ShapeGeom } from '../core/types';

export type Pt = [number, number];

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Handle {
  id: string;
  x: number;
  y: number;
}

/** これより小さい図形は作らない [m] */
export const MIN_SIZE = 1e-4;

export function geomBBox(g: ShapeGeom): BBox {
  switch (g.kind) {
    case 'rect':
      return { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h };
    case 'circle':
      return { x0: g.cx - g.r, y0: g.cy - g.r, x1: g.cx + g.r, y1: g.cy + g.r };
    case 'polygon': {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [x, y] of g.points) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      return { x0, y0, x1, y1 };
    }
  }
}

export function geomCenter(g: ShapeGeom): Pt {
  const b = geomBBox(g);
  return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
}

export function translateGeom(g: ShapeGeom, dx: number, dy: number): ShapeGeom {
  switch (g.kind) {
    case 'rect':
      return { ...g, x: g.x + dx, y: g.y + dy };
    case 'circle':
      return { ...g, cx: g.cx + dx, cy: g.cy + dy };
    case 'polygon':
      return { kind: 'polygon', points: g.points.map(([x, y]): Pt => [x + dx, y + dy]) };
  }
}

export function cloneGeom(g: ShapeGeom): ShapeGeom {
  return g.kind === 'polygon' ? { kind: 'polygon', points: g.points.map(([x, y]): Pt => [x, y]) } : { ...g };
}

/** 2点から長方形（向きに関係なく正規化する） */
export function rectFromPoints(a: Pt, b: Pt): ShapeGeom {
  return { kind: 'rect', x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

export function polygonArea(points: Pt[]): number {
  let s = 0;
  for (let a = 0, b = points.length - 1; a < points.length; b = a++) {
    s += points[b][0] * points[a][1] - points[a][0] * points[b][1];
  }
  return Math.abs(s) / 2;
}

/** 円・長方形を多角形に直す（変形後の輪郭を描くときなどに使う） */
export function geomToPolygon(g: ShapeGeom, circleN = 48, edgeN = 16): Pt[] {
  switch (g.kind) {
    case 'polygon':
      return g.points.map(([x, y]): Pt => [x, y]);
    case 'circle': {
      const pts: Pt[] = [];
      for (let i = 0; i < circleN; i++) {
        const a = (2 * Math.PI * i) / circleN;
        pts.push([g.cx + g.r * Math.cos(a), g.cy + g.r * Math.sin(a)]);
      }
      return pts;
    }
    case 'rect': {
      // 辺の途中でも変形を拾えるよう各辺を分割する
      const pts: Pt[] = [];
      const corners: Pt[] = [
        [g.x, g.y],
        [g.x + g.w, g.y],
        [g.x + g.w, g.y + g.h],
        [g.x, g.y + g.h],
      ];
      for (let c = 0; c < 4; c++) {
        const [ax, ay] = corners[c];
        const [bx, by] = corners[(c + 1) % 4];
        for (let k = 0; k < edgeN; k++) pts.push([ax + ((bx - ax) * k) / edgeN, ay + ((by - ay) * k) / edgeN]);
      }
      return pts;
    }
  }
}

// ---------- 当たり判定 ----------

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 輪郭までの距離 [m]（内側でも外側でも正） */
export function distToOutline(g: ShapeGeom, x: number, y: number): number {
  if (g.kind === 'circle') return Math.abs(Math.hypot(x - g.cx, y - g.cy) - g.r);
  const p = g.kind === 'rect' ? geomToPolygon(g, 0, 1) : g.points;
  let best = Infinity;
  for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
    best = Math.min(best, distToSegment(x, y, p[b][0], p[b][1], p[a][0], p[a][1]));
  }
  return best;
}

/** 点 (x, y) にある一番手前（配列の後ろ）の図形。tol [m] 以内なら輪郭の外側でも拾う */
export function hitShape(shapes: Shape[], x: number, y: number, tol = 0): Shape | undefined {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const g = shapes[i].geom;
    if (containsPoint(g, x, y)) return shapes[i];
  }
  if (tol > 0) {
    let best: Shape | undefined;
    let bestD = tol;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const d = distToOutline(shapes[i].geom, x, y);
      if (d <= bestD) {
        bestD = d;
        best = shapes[i];
      }
    }
    return best;
  }
  return undefined;
}

// ---------- ハンドル（選択中の形を変形する点） ----------

export function geomHandles(g: ShapeGeom): Handle[] {
  switch (g.kind) {
    case 'rect':
      return [
        { id: 'sw', x: g.x, y: g.y },
        { id: 'se', x: g.x + g.w, y: g.y },
        { id: 'ne', x: g.x + g.w, y: g.y + g.h },
        { id: 'nw', x: g.x, y: g.y + g.h },
      ];
    case 'circle':
      return [{ id: 'r', x: g.cx + g.r, y: g.cy }];
    case 'polygon':
      return g.points.map(([x, y], i) => ({ id: `v${i}`, x, y }));
  }
}

export function hitHandle(g: ShapeGeom, x: number, y: number, tol: number): Handle | undefined {
  let best: Handle | undefined;
  let bestD = tol;
  for (const h of geomHandles(g)) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d <= bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

/** ドラッグ開始時の形 orig に対して、ハンドルを (x, y) へ動かした形を返す */
export function applyHandle(orig: ShapeGeom, handleId: string, x: number, y: number): ShapeGeom {
  if (orig.kind === 'rect') {
    // 反対側の角を固定する
    const fixed: Pt = [handleId.includes('w') ? orig.x + orig.w : orig.x, handleId.includes('s') ? orig.y + orig.h : orig.y];
    const g = rectFromPoints(fixed, [x, y]);
    if (g.kind === 'rect') {
      g.w = Math.max(g.w, MIN_SIZE);
      g.h = Math.max(g.h, MIN_SIZE);
    }
    return g;
  }
  if (orig.kind === 'circle') {
    return { ...orig, r: Math.max(Math.hypot(x - orig.cx, y - orig.cy), MIN_SIZE) };
  }
  const idx = Number(handleId.slice(1));
  const points = orig.points.map(([px, py], i): Pt => (i === idx ? [x, y] : [px, py]));
  return { kind: 'polygon', points };
}

// ---------- フリーハンド簡略化 ----------

/** Ramer–Douglas–Peucker 法。折れ線を許容誤差 eps 以内でまばらにする */
export function rdpSimplify(points: Pt[], eps: number): Pt[] {
  if (points.length < 3) return points.map(([x, y]): Pt => [x, y]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(points[i][0], points[i][1], points[s][0], points[s][1], points[e][0], points[e][1]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > eps) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i] === 1).map(([x, y]): Pt => [x, y]);
}

/** 近すぎる連続点を除く（閉じるときの始点と終点の重複も除く） */
export function dedupePoints(points: Pt[], tol: number): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > tol) out.push([p[0], p[1]]);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= tol) out.pop();
  return out;
}

/** フリーハンドの軌跡を閉じた多角形にする。作れなければ null */
export function simplifyFreehand(points: Pt[], eps: number): Pt[] | null {
  const dd = dedupePoints(points, eps * 0.5);
  if (dd.length < 3) return null;
  // 始点と終点をつなぐ閉曲線として扱うため、始点を末尾にも足してから間引く
  const closed = rdpSimplify([...dd, dd[0]], eps);
  closed.pop();
  if (closed.length < 3) return null;
  if (polygonArea(closed) < eps * eps * 4) return null;
  return closed;
}

// ---------- スナップ ----------

export function snapValue(v: number, step: number): number {
  return step > 0 ? Math.round(v / step) * step : v;
}

export function snapPoint(p: Pt, step: number): Pt {
  return [snapValue(p[0], step), snapValue(p[1], step)];
}
