// 画像 → 多角形の変換（純粋なアルゴリズム）。DOM・canvas には依存しない。
//
// 流れ: RGBA → グレー → 二値化（大津法）→ ノイズ除去 → 輪郭追跡 → 間引き（RDP）→ Shape
// 画像座標は y が下向き（ピクセルの角が整数座標）。Studio M の座標は y が上向きのメートル。
import type { Shape, ShapeRole } from '../core/types';
import { newShapeId } from '../core/project';
import { rdpSimplify } from './geometry';

export type Pt = [number, number];

/** RGBA の画像データ（ImageData と同じ形。Node でもテストできるよう自前で定義する） */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

// ---------- グレー化・二値化 ----------

/** 輝度（Rec.601）に変換する。透明な部分は白い紙の上にあるものとして合成する */
export function toGray(img: RgbaImage): Uint8Array {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255;
    const y = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    out[i] = Math.round(y * a + 255 * (1 - a));
  }
  return out;
}

/**
 * 大津の方法でしきい値を求める。戻り値 t に対し「gray <= t」が暗い側。
 * 2 つの山がはっきり離れていて評価値が平らになるときは、その中央を返す。
 */
export function otsuThreshold(gray: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  if (total === 0) return 128;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let first = 0;
  let last = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best + 1e-9) {
      best = v;
      first = t;
      last = t;
    } else if (Math.abs(v - best) <= 1e-9) {
      last = t;
    }
  }
  return Math.round((first + last) / 2);
}

/** 画像の外周の半分以上が「物体側（暗い側）」なら true（背景が暗い画像を自動で反転するため） */
export function borderIsMostlyObject(gray: Uint8Array, w: number, h: number, threshold: number): boolean {
  let dark = 0;
  let count = 0;
  const test = (x: number, y: number) => {
    count++;
    if (gray[y * w + x] <= threshold) dark++;
  };
  for (let x = 0; x < w; x++) {
    test(x, 0);
    if (h > 1) test(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    test(0, y);
    if (w > 1) test(w - 1, y);
  }
  return count > 0 && dark / count > 0.5;
}

/** 二値化。既定は暗い画素が物体（1）。invert で明るい画素が物体になる */
export function binarize(gray: Uint8Array, threshold: number, invert = false): Uint8Array {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const dark = gray[i] <= threshold;
    out[i] = dark !== invert ? 1 : 0;
  }
  return out;
}

// ---------- ノイズ除去 ----------

/** 面積（画素数）が minArea 未満の物体の塊（8 近傍で連結）を消す */
export function removeSmallSpecks(mask: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
  const out = mask.slice();
  if (minArea <= 1) return out;
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    comp.length = 0;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
          const q = yy * w + xx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    if (comp.length < minArea) for (const p of comp) out[p] = 0;
  }
  return out;
}

/** 四角い窓の最小値(erode=true)/最大値(false)フィルタ。範囲外は端の値として扱う（端で縮まない） */
function rankFilter(mask: Uint8Array, w: number, h: number, r: number, erode: boolean): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        const m = mask[y * w + xx];
        if (erode ? !m : m) {
          v = erode ? 0 : 1;
          break;
        }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        const m = tmp[yy * w + x];
        if (erode ? !m : m) {
          v = erode ? 0 : 1;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** 収縮（物体を r 画素細くする） */
export function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return rankFilter(mask, w, h, r, true);
}
/** 膨張（物体を r 画素太くする） */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return rankFilter(mask, w, h, r, false);
}
/** オープニング: 細いはみ出し・小さな点を消す */
export function morphOpen(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return dilate(erode(mask, w, h, r), w, h, r);
}
/** クロージング: 小さな隙間・すき間を埋める */
export function morphClose(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return erode(dilate(mask, w, h, r), w, h, r);
}

// ---------- 輪郭追跡 ----------

export interface Contour {
  /** 画像座標（y 下向き）の頂点。ピクセルの角を通る閉じた折れ線（最後の点は始点と重複しない） */
  points: Pt[];
  /** 符号つき面積 [画素²]。外周は正、穴は負 */
  signedArea: number;
  /** 穴（物体の中の空洞）なら true */
  isHole: boolean;
  /** 入れ子の深さ。0 = 最も外側の外周、1 = その穴、2 = 穴の中の島 … */
  depth: number;
  /** この輪郭の辺の上の点（他の輪郭の辺には乗らない）。内外判定の代表点 */
  probe: Pt;
}

/** 外周とその穴のまとまり */
export interface ContourGroup {
  outer: Contour;
  holes: Contour[];
}

/** 符号つき面積。画面上で時計回りが正（y 下向き座標） */
export function signedArea(points: Pt[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function pointInPolygon(px: number, py: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 向き: 0 = +x（右）, 1 = +y（下）, 2 = -x, 3 = -y。進行方向の右手側に物体がある。
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * 二値画像の境界を画素の辺に沿って追跡し、すべての閉じた輪郭を返す（厳密・欠けなし）。
 * 物体は 8 近傍で連結とみなす（斜めに接する細い線を途切れさせないため）。
 * 外周は画面上で時計回り（面積が正）、穴は反時計回り（面積が負）になる。
 */
export function traceContours(mask: Uint8Array, w: number, h: number): Contour[] {
  const vw = w + 1;
  // 頂点ごとに「まだ使っていない出る辺」を 4 ビットで持つ
  const out = new Uint8Array(vw * (h + 1));
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!at(x, y - 1)) out[y * vw + x] |= 1 << 0; // 上辺: (x,y) → (x+1,y)
      if (!at(x + 1, y)) out[y * vw + x + 1] |= 1 << 1; // 右辺: (x+1,y) → (x+1,y+1)
      if (!at(x, y + 1)) out[(y + 1) * vw + x + 1] |= 1 << 2; // 下辺: (x+1,y+1) → (x,y+1)
      if (!at(x - 1, y)) out[(y + 1) * vw + x] |= 1 << 3; // 左辺: (x,y+1) → (x,y)
    }
  }

  const raw: Pt[][] = [];
  for (let sv = 0; sv < out.length; sv++) {
    while (out[sv]) {
      let sd = 0;
      while (!(out[sv] & (1 << sd))) sd++;
      // 始点の辺は、一周したことを判定するため追跡中は消さずに残す
      const pts: Pt[] = [];
      let v = sv;
      let d = sd;
      for (;;) {
        if (!(v === sv && d === sd)) out[v] &= ~(1 << d);
        const x = v % vw;
        const y = (v - x) / vw;
        const nv = (y + DY[d]) * vw + (x + DX[d]);
        // 次の向き: 左折（8 近傍で連結）→ 直進 → 右折の順に選ぶ
        let nd = -1;
        for (const cand of [(d + 3) & 3, d, (d + 1) & 3]) {
          if (out[nv] & (1 << cand)) {
            nd = cand;
            break;
          }
        }
        if (nd < 0) break; // 辺の数は釣り合っているので通常は起きない
        // 向きが変わる頂点（角）だけを記録する
        if (nd !== d) pts.push([nv % vw, Math.floor(nv / vw)]);
        // 始点に戻って始点の辺をもう一度たどる → 一周した
        if (nv === sv && nd === sd) break;
        v = nv;
        d = nd;
      }
      out[sv] &= ~(1 << sd);
      if (pts.length >= 3) raw.push(pts);
    }
  }
  return classify(raw);
}

/** 輪郭の入れ子関係（外周/穴・深さ）を調べる */
function classify(raws: Pt[][]): Contour[] {
  const contours: Contour[] = raws.map((points) => {
    const a = signedArea(points);
    // 最初の 1 画素分の辺の中点（半整数座標なので他の輪郭の辺と重ならない）
    const dx = Math.sign(points[1][0] - points[0][0]);
    const dy = Math.sign(points[1][1] - points[0][1]);
    const probe: Pt = [points[0][0] + dx * 0.5, points[0][1] + dy * 0.5];
    return { points, signedArea: a, isHole: a < 0, depth: 0, probe };
  });
  const bbox = contours.map((c) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of c.points) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  });
  // 代表点がいくつの輪郭の内側にあるかが深さ
  for (let i = 0; i < contours.length; i++) {
    const [mx, my] = contours[i].probe;
    let depth = 0;
    for (let j = 0; j < contours.length; j++) {
      if (i === j) continue;
      const b = bbox[j];
      if (mx < b[0] || mx > b[2] || my < b[1] || my > b[3]) continue;
      if (pointInPolygon(mx, my, contours[j].points)) depth++;
    }
    contours[i].depth = depth;
  }
  return contours;
}

/** 外周ごとに、その直下の穴をまとめる（外周は面積が大きい順） */
export function groupContours(contours: Contour[]): ContourGroup[] {
  const outers = contours.filter((c) => !c.isHole);
  const groups: ContourGroup[] = outers.map((outer) => ({ outer, holes: [] }));
  // 穴は、それを含む外周のうち最も小さいものに属する
  const order = groups.map((_, i) => i).sort((a, b) => groups[a].outer.signedArea - groups[b].outer.signedArea);
  for (const hole of contours.filter((c) => c.isHole)) {
    const [mx, my] = hole.probe;
    for (const gi of order) {
      const o = groups[gi].outer;
      if (o.depth >= hole.depth) continue;
      if (pointInPolygon(mx, my, o.points)) {
        groups[gi].holes.push(hole);
        break;
      }
    }
  }
  return groups.sort((a, b) => a.outer.depth - b.outer.depth || b.outer.signedArea - a.outer.signedArea);
}

// ---------- 間引き ----------

/** 閉じた輪郭を RDP で間引く（始点から最も遠い点で 2 つの折れ線に分けて処理する） */
export function simplifyClosed(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 3 || tolerance <= 0) return points.map(([x, y]): Pt => [x, y]);
  let far = 0;
  let farD = -1;
  for (let i = 1; i < points.length; i++) {
    const d = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = rdpSimplify(points.slice(0, far + 1), tolerance);
  const b = rdpSimplify([...points.slice(far), points[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

export interface TraceOptions {
  /** 間引きの許容誤差 [画素]。0 で間引かない */
  tolerance: number;
  /** これより小さい輪郭（外周・穴とも）は捨てる [画素²] */
  minArea: number;
  /** 穴を返すか */
  includeHoles: boolean;
}

/** 二値画像から、間引き済みの外周＋穴のまとまりを作る */
export function traceMask(mask: Uint8Array, w: number, h: number, opt: TraceOptions): ContourGroup[] {
  const all = traceContours(mask, w, h);
  const keep = (c: Contour): Contour | null => {
    if (Math.abs(c.signedArea) < opt.minArea) return null;
    const pts = simplifyClosed(c.points, opt.tolerance);
    if (pts.length < 3) return null;
    const a = signedArea(pts);
    // 間引きで面積がほぼ 0 になった（つぶれた）輪郭は捨てる
    if (Math.abs(a) < Math.max(1, opt.minArea * 0.25)) return null;
    return { ...c, points: pts, signedArea: a };
  };
  const groups: ContourGroup[] = [];
  for (const g of groupContours(all)) {
    const outer = keep(g.outer);
    if (!outer) continue;
    const holes = opt.includeHoles ? g.holes.map(keep).filter((c): c is Contour => c !== null) : [];
    groups.push({ outer, holes });
  }
  return groups;
}

/** 頂点数の合計と穴の数 */
export function countGroups(groups: ContourGroup[]): { outers: number; holes: number; vertices: number } {
  let holes = 0;
  let vertices = 0;
  for (const g of groups) {
    vertices += g.outer.points.length;
    holes += g.holes.length;
    for (const hl of g.holes) vertices += hl.points.length;
  }
  return { outers: groups.length, holes, vertices };
}

// ---------- 寸法 ----------

export interface PxBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 全外周の外接矩形（画素）。輪郭がなければ null */
export function groupsBBox(groups: ContourGroup[]): PxBBox | null {
  if (groups.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const g of groups) {
    for (const [x, y] of g.outer.points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** 実寸の幅 [mm] と、それに対応する画素幅から 1 画素あたりのメートルを求める */
export function scaleFromWidth(widthMm: number, widthPx: number): number {
  if (!(widthMm > 0) || !(widthPx > 0)) return 0;
  return widthMm / 1000 / widthPx;
}

/**
 * 物体（または画像全体）が解析領域の fraction の大きさに収まる幅 [mm] の目安。
 * 幅・高さのどちらもはみ出さないようにする。
 */
export function defaultWidthMm(domain: { width: number; height: number }, aspectWH: number, fraction = 0.6): number {
  const wByW = domain.width * fraction;
  const wByH = domain.height * fraction * (aspectWH > 0 ? aspectWH : 1);
  const w = Math.min(wByW, wByH) * 1000;
  // 見やすい値に丸める（3 桁）
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(w, 1e-9))) - 2);
  return Math.max(mag, Math.round(w / mag) * mag);
}

// ---------- Shape への変換 ----------

export interface ToShapesOptions {
  /** 1 画素あたりのメートル */
  scaleMPerPx: number;
  /** 画像の左下（flipY が false なら左上）の Studio M 座標 [m] */
  originX: number;
  originY: number;
  /** y 軸を反転する（画像は y 下向き、Studio M は y 上向き）。既定 true */
  flipY?: boolean;
  /** 画像の高さ [画素]（flipY に必要） */
  imageHeight: number;
  role?: ShapeRole;
  materialId: string;
  namePrefix?: string;
  /** 穴を 'hole' の Shape として外周の直後に並べるか（role が solid / heatSource のときだけ有効）。既定 true */
  includeHoles?: boolean;
}

/** 物体の外接矩形の中心を解析領域の中央に置く原点を返す */
export function centeredOrigin(
  bbox: PxBBox,
  imageHeight: number,
  scaleMPerPx: number,
  domain: { width: number; height: number },
): { originX: number; originY: number } {
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  return {
    originX: domain.width / 2 - cx * scaleMPerPx,
    originY: domain.height / 2 - (imageHeight - cy) * scaleMPerPx,
  };
}

const round9 = (v: number) => Math.round(v * 1e9) / 1e9;

function toPolygonPoints(c: Contour, o: ToShapesOptions): Pt[] {
  const s = o.scaleMPerPx;
  const flip = o.flipY ?? true;
  const pts = c.points.map(([px, py]): Pt => [
    round9(o.originX + px * s),
    round9(o.originY + (flip ? o.imageHeight - py : py) * s),
  ]);
  // 反転すると向きが変わるので、常に反時計回り（数学的に正）にそろえる
  if (signedArea(pts) < 0) pts.reverse();
  return pts;
}

/**
 * 輪郭のまとまりを Shape の並びにする。
 * 各外周 → 直後にその穴、の順（shapes は順に適用され後のものが上書きするため）。
 * 穴の中の島は深さ順で後ろに来るので、穴を埋め直せる。
 */
export function toShapes(groups: ContourGroup[], opt: ToShapesOptions): Shape[] {
  const role: ShapeRole = opt.role ?? 'solid';
  const prefix = opt.namePrefix ?? '取り込み';
  const withHoles = (opt.includeHoles ?? true) && (role === 'solid' || role === 'heatSource');
  const shapes: Shape[] = [];
  groups.forEach((g, i) => {
    const base = groups.length > 1 ? `${prefix} ${i + 1}` : prefix;
    const s: Shape = {
      id: newShapeId(),
      name: base,
      role,
      materialId: opt.materialId,
      geom: { kind: 'polygon', points: toPolygonPoints(g.outer, opt) },
    };
    if (role === 'heatSource') s.heatW = 5;
    if (role === 'fixedTemp') s.tempC = 80;
    if (role === 'load') s.force = { fx: 0, fy: -10 };
    shapes.push(s);
    if (!withHoles) return;
    g.holes.forEach((hl, k) => {
      shapes.push({
        id: newShapeId(),
        name: g.holes.length > 1 ? `${base} の穴 ${k + 1}` : `${base} の穴`,
        role: 'hole',
        materialId: opt.materialId,
        geom: { kind: 'polygon', points: toPolygonPoints(hl, opt) },
      });
    });
  });
  return shapes;
}

// ---------- 一括処理 ----------

export interface PipelineParams {
  threshold: number;
  invert: boolean;
  /** 物体の最小面積 [画素²]（ノイズ除去） */
  minArea: number;
  /** 0 = なし、1〜2 = オープニング/クロージングの半径 */
  morphRadius: number;
  tolerance: number;
  includeHoles: boolean;
}

/** グレー画像 → 二値化 → 後処理。プレビューと取り込みで同じ結果を使うための共通処理 */
export function makeMask(gray: Uint8Array, w: number, h: number, p: PipelineParams): Uint8Array {
  let mask = binarize(gray, p.threshold, p.invert);
  if (p.morphRadius > 0) {
    mask = morphOpen(mask, w, h, p.morphRadius);
    mask = morphClose(mask, w, h, p.morphRadius);
  }
  return removeSmallSpecks(mask, w, h, p.minArea);
}

export function runPipeline(gray: Uint8Array, w: number, h: number, p: PipelineParams): { mask: Uint8Array; groups: ContourGroup[] } {
  const mask = makeMask(gray, w, h, p);
  const groups = traceMask(mask, w, h, { tolerance: p.tolerance, minArea: p.minArea, includeHoles: p.includeHoles });
  return { mask, groups };
}
