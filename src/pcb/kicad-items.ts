// KiCad の個々の要素（図形・パッド・配線）を多角形にする関数。kicad.ts から使う。
// ここでの座標は KiCad の座標のまま（mm、y 下向き）。Studio M の座標への変換は kicad.ts が最後にまとめて行う。
import {
  arcFromThreePoints,
  arcStripPolygon,
  circlePolygon,
  rectPolygon,
  rotatePt,
  stadiumPolygon,
  tessellateArc,
  tessellateBezier,
  type Pt,
} from './geom';
import { child, childNum, childXY, numAt, pointsOf, strAt, type SList } from './sexpr';

/** 図形 1 つ分の折れ線 */
export interface Prim {
  pts: Pt[];
  /** 閉じた図形（円・四角・多角形）か、開いた線か */
  closed: boolean;
  /** 線の太さ [mm]。無ければ 0 */
  width: number;
}

/** 線の太さ。KiCad 7 以降は (stroke (width w))、それ以前は (width w) */
export function widthOf(node: SList): number {
  const stroke = child(node, 'stroke');
  const w = stroke ? childNum(stroke, 'width', NaN) : childNum(node, 'width', NaN);
  return Number.isFinite(w) ? w : 0;
}

/** 要素が載っている層の名前（(layer "X") または (layers "A" "B")） */
export function layersOf(node: SList): string[] {
  const one = child(node, 'layer');
  if (one) return [strAt(one, 1)];
  const many = child(node, 'layers');
  if (many) return many.slice(1).map((v) => String(v));
  return [];
}

/**
 * gr_* / fp_* の図形（line / arc / circle / rect / poly / curve）を折れ線にする。
 * tf は図形の座標を基板の座標へ直す関数（基板直下の図形なら恒等）
 */
export function graphicPrim(node: SList, tf: (p: Pt) => Pt): Prim | null {
  const head = String(node[0]);
  const kind = head.slice(3); // gr_ / fp_ を取る
  const width = widthOf(node);
  const T = (p: Pt | undefined): Pt | undefined => (p ? tf(p) : undefined);
  switch (kind) {
    case 'line': {
      const a = T(childXY(node, 'start'));
      const b = T(childXY(node, 'end'));
      return a && b ? { pts: [a, b], closed: false, width } : null;
    }
    case 'arc': {
      const s = T(childXY(node, 'start'));
      const e = T(childXY(node, 'end'));
      const m = T(childXY(node, 'mid'));
      if (s && e && m) {
        const arc = arcFromThreePoints(s, m, e);
        return { pts: arc ? tessellateArc(arc) : [s, e], closed: false, width };
      }
      // KiCad 5 以前: (start 中心) (end 弧の始点) (angle 角度)。正の角度は画面上で時計回り
      const ang = childNum(node, 'angle', NaN);
      if (s && e && Number.isFinite(ang)) {
        const r = Math.hypot(e[0] - s[0], e[1] - s[1]);
        const a0 = Math.atan2(e[1] - s[1], e[0] - s[0]);
        return { pts: tessellateArc({ cx: s[0], cy: s[1], r, a0, sweep: (ang * Math.PI) / 180 }), closed: false, width };
      }
      return null;
    }
    case 'circle': {
      const c = childXY(node, 'center') ?? childXY(node, 'start');
      const e = childXY(node, 'end');
      if (!c || !e) return null;
      const r = Math.hypot(e[0] - c[0], e[1] - c[1]);
      const cc = tf(c);
      return r > 0 ? { pts: circlePolygon(cc[0], cc[1], r, 64), closed: true, width } : null;
    }
    case 'rect': {
      const a = childXY(node, 'start');
      const b = childXY(node, 'end');
      if (!a || !b) return null;
      const pts = ([[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]] as Pt[]).map(tf);
      return { pts, closed: true, width };
    }
    case 'poly': {
      const pts = pointsOf(node).map(tf);
      return pts.length >= 2 ? { pts, closed: true, width } : null;
    }
    case 'curve': {
      const p = pointsOf(node).map(tf);
      return p.length === 4 ? { pts: tessellateBezier(p[0], p[1], p[2], p[3]), closed: false, width } : null;
    }
    default:
      return null;
  }
}

/** 配線（segment）→ 長円の多角形 */
export function segmentPolygon(node: SList): Pt[] | null {
  const a = childXY(node, 'start');
  const b = childXY(node, 'end');
  const w = childNum(node, 'width', NaN);
  if (!a || !b || !(w > 0)) return null;
  return stadiumPolygon(a, b, w);
}

/** 弧の配線（arc: start / mid / end） */
export function arcTrackPolygon(node: SList): Pt[] | null {
  const s = childXY(node, 'start');
  const m = childXY(node, 'mid');
  const e = childXY(node, 'end');
  const w = childNum(node, 'width', NaN);
  if (!s || !m || !e || !(w > 0)) return null;
  const arc = arcFromThreePoints(s, m, e);
  if (!arc) return stadiumPolygon(s, e, w);
  return arcStripPolygon(arc, w);
}

/** 銅箔の層にある gr_* / fp_* 図形（アンテナや、銅で描いたロゴ）。線は太さをつけ、多角形はそのまま */
export function copperGraphicPolygon(node: SList, tf: (p: Pt) => Pt): Pt[] | null {
  const prim = graphicPrim(node, tf);
  if (!prim) return null;
  const kind = String(node[0]).slice(3);
  if (kind === 'line' && prim.width > 0) return stadiumPolygon(prim.pts[0], prim.pts[1], prim.width);
  if ((kind === 'poly' || kind === 'rect') && prim.pts.length >= 3) return prim.pts;
  return null;
}

// ---------- パッド ----------

export interface PadInfo {
  polygon: Pt[];
  /** パッドが載っている層（「*.Cu」などを展開する前の名前） */
  layers: string[];
  /** パッドの種類: smd / thru_hole / np_thru_hole / connect */
  type: string;
}

/**
 * パッド → 多角形。fpAt はフットプリントの位置と角度。
 * パッドの (at x y 角度) の角度は、フットプリントの角度を含んだ値（KiCad の仕様）なので、そのまま形の回転に使う
 */
export function padInfo(pad: SList, fpAt: { x: number; y: number; rot: number }): PadInfo | null {
  const at = child(pad, 'at');
  const size = child(pad, 'size');
  if (!at || !size) return null;
  const lx = numAt(at, 1, 0);
  const ly = numAt(at, 2, 0);
  const padRot = numAt(at, 3, 0);
  const w = numAt(size, 1, NaN);
  const hgt = numAt(size, 2, w);
  if (!(w > 0) || !(hgt > 0)) return null;
  const [dx, dy] = rotatePt([lx, ly], fpAt.rot);
  const cx = fpAt.x + dx;
  const cy = fpAt.y + dy;
  const shape = strAt(pad, 3);
  let polygon: Pt[];
  if (shape === 'circle' || (shape === 'oval' && Math.abs(w - hgt) < 1e-9)) {
    polygon = circlePolygon(cx, cy, w / 2, 16);
  } else if (shape === 'oval') {
    const half = Math.abs(w - hgt) / 2;
    const axis: Pt = w > hgt ? [half, 0] : [0, half];
    const a = rotatePt([-axis[0], -axis[1]], padRot);
    const b = rotatePt(axis, padRot);
    polygon = stadiumPolygon([cx + a[0], cy + a[1]], [cx + b[0], cy + b[1]], Math.min(w, hgt), 6);
  } else {
    // rect / roundrect / trapezoid / custom は外接する四角で近似する
    polygon = rectPolygon(cx, cy, w, hgt, padRot);
  }
  return { polygon, layers: layersOf(pad), type: strAt(pad, 2) };
}
