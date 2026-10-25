// 基板の形を作る小さな幾何の道具。座標の単位は呼び出し側が決める（kicad.ts では mm、y 下向き）。
// 回転は KiCad と同じく「画面上で反時計回りが正」（y が下向きの座標で使う）。

export type Pt = [number, number];

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 中身が空の外接矩形（点を足すと広がる） */
export function emptyBBox(): BBox {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}

export function isEmptyBBox(b: BBox): boolean {
  return !(b.x1 >= b.x0 && b.y1 >= b.y0);
}

export function growBBox(b: BBox, x: number, y: number): void {
  if (x < b.x0) b.x0 = x;
  if (x > b.x1) b.x1 = x;
  if (y < b.y0) b.y0 = y;
  if (y > b.y1) b.y1 = y;
}

export function bboxOf(points: Pt[], into: BBox = emptyBBox()): BBox {
  for (const [x, y] of points) growBBox(into, x, y);
  return into;
}

/** 点 p を原点まわりに deg 度回す（画面上で反時計回りが正、y 下向き） */
export function rotatePt([x, y]: Pt, deg: number): Pt {
  if (!deg) return [x, y];
  // 90° の倍数は誤差なしで回す（部品の範囲がきれいな値になるように）
  const q = (((deg % 360) + 360) % 360) / 90;
  if (Number.isInteger(q)) {
    if (q === 0) return [x, y];
    if (q === 1) return [y, -x];
    if (q === 2) return [-x, -y];
    return [-y, x];
  }
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [x * c + y * s, y * c - x * s];
}

/** フットプリントの座標を基板の座標へ直す関数を作る（回して、平行移動する） */
export function makeTransform(x: number, y: number, rotDeg: number): (p: Pt) => Pt {
  return (p) => {
    const q = rotatePt(p, rotDeg);
    return [q[0] + x, q[1] + y];
  };
}

/** 符号つき面積（座標が y 下向きなら時計回りが正）。絶対値が面積 */
export function signedArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  return a / 2;
}

export function polygonArea(p: Pt[]): number {
  return Math.abs(signedArea(p));
}

export function pointInPolygon([x, y]: Pt, p: Pt[]): boolean {
  let inside = false;
  for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
    const [xa, ya] = p[a];
    const [xb, yb] = p[b];
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

// ---------- 基本図形 ----------

export function rectPolygon(cx: number, cy: number, w: number, h: number, rotDeg = 0): Pt[] {
  const hw = w / 2;
  const hh = h / 2;
  const corners: Pt[] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  return corners.map((c) => {
    const q = rotatePt(c, rotDeg);
    return [q[0] + cx, q[1] + cy] as Pt;
  });
}

export function circlePolygon(cx: number, cy: number, r: number, segments = 16): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/**
 * 長円（スタジアム）: 中心線 a→b に幅 width を持たせた形。両端は半円。
 * 配線（トラック）と長円のパッドに使う。長さ 0 なら円になる
 */
export function stadiumPolygon(a: Pt, b: Pt, width: number, capSegments = 8): Pt[] {
  const r = width / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return circlePolygon(a[0], a[1], r, capSegments * 2);
  const base = Math.atan2(dy, dx);
  const out: Pt[] = [];
  // b 側の半円（-90° から +90°）→ a 側の半円（+90° から +270°）
  for (let i = 0; i <= capSegments; i++) {
    const t = base - Math.PI / 2 + (Math.PI * i) / capSegments;
    out.push([b[0] + r * Math.cos(t), b[1] + r * Math.sin(t)]);
  }
  for (let i = 0; i <= capSegments; i++) {
    const t = base + Math.PI / 2 + (Math.PI * i) / capSegments;
    out.push([a[0] + r * Math.cos(t), a[1] + r * Math.sin(t)]);
  }
  return out;
}

// ---------- 弧 ----------

/** 弧を折れ線にするときの許容誤差（弦と弧のずれ）。単位は座標と同じ */
export const ARC_TOLERANCE = 0.01;

/** 半径 r・掃引角 sweep [rad] の弧を何分割するか */
export function arcSegments(r: number, sweep: number, tol = ARC_TOLERANCE): number {
  const step = r > tol ? 2 * Math.acos(1 - tol / r) : Math.PI / 2;
  return Math.min(256, Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-3))));
}

export interface ArcDef {
  cx: number;
  cy: number;
  r: number;
  /** 開始角 [rad]（atan2(dy, dx)。y 下向きの座標での値） */
  a0: number;
  /** 掃引角 [rad]。正で a0 から増える向き */
  sweep: number;
}

/** 始点・中間点・終点を通る弧。3 点が一直線上なら null */
export function arcFromThreePoints(s: Pt, m: Pt, e: Pt): ArcDef | null {
  const ax = s[0], ay = s[1], bx = m[0], by = m[1], cx = e[0], cy = e[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const am = Math.atan2(by - uy, bx - ux);
  const a1 = Math.atan2(cy - uy, cx - ux);
  const norm = (v: number) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const toEnd = norm(a1 - a0);
  const toMid = norm(am - a0);
  // 中間点を通る向きを選ぶ
  const sweep = toMid <= toEnd ? toEnd : toEnd - 2 * Math.PI;
  return { cx: ux, cy: uy, r, a0, sweep };
}

/** 弧を折れ線の点列にする（始点と終点を含む） */
export function tessellateArc(arc: ArcDef, tol = ARC_TOLERANCE): Pt[] {
  const n = arcSegments(arc.r, arc.sweep, tol);
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = arc.a0 + (arc.sweep * i) / n;
    out.push([arc.cx + arc.r * Math.cos(t), arc.cy + arc.r * Math.sin(t)]);
  }
  return out;
}

/** 弧の形をした配線（幅 width）の多角形。両端は平ら */
export function arcStripPolygon(arc: ArcDef, width: number, tol = ARC_TOLERANCE): Pt[] {
  const n = arcSegments(arc.r + width / 2, arc.sweep, tol);
  const ro = arc.r + width / 2;
  const ri = Math.max(0, arc.r - width / 2);
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = arc.a0 + (arc.sweep * i) / n;
    out.push([arc.cx + ro * Math.cos(t), arc.cy + ro * Math.sin(t)]);
  }
  for (let i = n; i >= 0; i--) {
    const t = arc.a0 + (arc.sweep * i) / n;
    out.push([arc.cx + ri * Math.cos(t), arc.cy + ri * Math.sin(t)]);
  }
  return out;
}

/** 3 次ベジェ曲線を折れ線にする */
export function tessellateBezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, segments = 16): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

// ---------- 線のつなぎ合わせ ----------

export interface Chains {
  /** 始点と終点が合って閉じた輪郭 */
  closed: Pt[][];
  /** 閉じなかった線（隙間がある） */
  open: Pt[][];
}

/**
 * ばらばらの折れ線を端点でつなぎ、輪郭にする。
 * 端点どうしの距離が tol 以下なら同じ点とみなす（向きが逆でもよい）
 */
export function chainPolylines(lines: Pt[][], tol = 1e-3): Chains {
  const pool = lines.filter((l) => l.length >= 2).map((l) => l.slice());
  const used = new Array<boolean>(pool.length).fill(false);
  const near = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  const closed: Pt[][] = [];
  const open: Pt[][] = [];

  for (let s = 0; s < pool.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    let chain = pool[s].slice();
    for (;;) {
      if (chain.length >= 3 && near(chain[0], chain[chain.length - 1])) break;
      const tail = chain[chain.length - 1];
      let found = -1;
      let reverse = false;
      for (let k = 0; k < pool.length; k++) {
        if (used[k]) continue;
        const l = pool[k];
        if (near(l[0], tail)) {
          found = k;
          break;
        }
        if (near(l[l.length - 1], tail)) {
          found = k;
          reverse = true;
          break;
        }
      }
      if (found < 0) {
        // 先頭側にもつなげられるか調べる（最初の線が途中から始まっている場合）
        const head = chain[0];
        let hf = -1;
        let hrev = false;
        for (let k = 0; k < pool.length; k++) {
          if (used[k]) continue;
          const l = pool[k];
          if (near(l[l.length - 1], head)) {
            hf = k;
            break;
          }
          if (near(l[0], head)) {
            hf = k;
            hrev = true;
            break;
          }
        }
        if (hf < 0) break;
        used[hf] = true;
        const l = hrev ? pool[hf].slice().reverse() : pool[hf];
        chain = l.slice(0, -1).concat(chain);
        continue;
      }
      used[found] = true;
      const l = reverse ? pool[found].slice().reverse() : pool[found];
      chain = chain.concat(l.slice(1));
    }
    if (chain.length >= 3 && near(chain[0], chain[chain.length - 1])) closed.push(chain.slice(0, -1));
    else open.push(chain);
  }
  return { closed, open };
}

// ---------- 簡略化 ----------

/** Douglas-Peucker 法で、許容誤差 tol 以内になるように頂点を減らす（閉じた輪郭用） */
export function simplifyRing(points: Pt[], tol: number): Pt[] {
  if (points.length <= 8 || tol <= 0) return points;
  // 輪郭の両端（一番離れた 2 点）で二分してから、それぞれを簡略化する
  const ia = 0;
  let ib = 0;
  let best = -1;
  const a = points[0];
  for (let i = 1; i < points.length; i++) {
    const d = (points[i][0] - a[0]) ** 2 + (points[i][1] - a[1]) ** 2;
    if (d > best) {
      best = d;
      ib = i;
    }
  }
  const left = dp(points.slice(ia, ib + 1), tol);
  const right = dp(points.slice(ib).concat([points[ia]]), tol);
  const out = left.slice(0, -1).concat(right.slice(0, -1));
  return out.length >= 3 ? out : points;
}

function dp(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[j];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    let far = -1;
    let dmax = tol;
    for (let k = i + 1; k < j; k++) {
      const d = len < 1e-12 ? Math.hypot(pts[k][0] - x1, pts[k][1] - y1) : Math.abs(dy * (pts[k][0] - x1) - dx * (pts[k][1] - y1)) / len;
      if (d > dmax) {
        dmax = d;
        far = k;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}
