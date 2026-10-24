// キャンバスの上に重ねて描くもの: 図形の輪郭・ハンドル・作図中の線・凡例・スケールバー・変形輪郭。
import type { Field, Material, Shape, ShapeGeom } from '../core/types';
import { buildLUT, type ColormapName, type Range } from './colormap';
import { formatNumber, formatQuantity, formatRange } from './format';
import { geomBBox, geomHandles, geomToPolygon, type Pt } from './geometry';

/** 描画先とワールド→ピクセル変換（y は上向きなので反転する） */
export interface Paint {
  ctx: CanvasRenderingContext2D;
  /** 1 m あたりのデバイスピクセル数 */
  sc: number;
  /** キャンバスの高さ（デバイスピクセル） */
  H: number;
  dpr: number;
}

export interface Draft {
  kind: 'rect' | 'circle' | 'polygon' | 'freehand';
  points: Pt[];
  /** 多角形のゴム紐線の先 */
  hover?: Pt;
}

export const ACCENT = '#2563eb';
const FONT = '"Hiragino Sans","Noto Sans JP","Yu Gothic UI",system-ui,sans-serif';

const X = (p: Paint, x: number): number => x * p.sc;
const Y = (p: Paint, y: number): number => p.H - y * p.sc;

export function setFont(p: Paint, cssPx: number, bold = false): void {
  p.ctx.font = `${bold ? '600 ' : ''}${cssPx * p.dpr}px ${FONT}`;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

export function tracePath(p: Paint, g: ShapeGeom): void {
  const c = p.ctx;
  c.beginPath();
  switch (g.kind) {
    case 'rect':
      c.rect(X(p, g.x), Y(p, g.y + g.h), g.w * p.sc, g.h * p.sc);
      break;
    case 'circle':
      c.arc(X(p, g.cx), Y(p, g.cy), g.r * p.sc, 0, Math.PI * 2);
      break;
    case 'polygon':
      g.points.forEach(([x, y], i) => (i === 0 ? c.moveTo(X(p, x), Y(p, y)) : c.lineTo(X(p, x), Y(p, y))));
      c.closePath();
      break;
  }
}

/** 文字を白い縁取り付きで描く（背景の色に関わらず読めるように） */
function haloText(p: Paint, text: string, x: number, y: number, color = '#1f2937'): void {
  const c = p.ctx;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  c.lineWidth = 3 * p.dpr;
  c.strokeStyle = 'rgba(255,255,255,0.92)';
  c.strokeText(text, x, y);
  c.fillStyle = color;
  c.fillText(text, x, y);
}

export interface ShapeDrawOpts {
  /** 場が描かれていないとき、物体を材料色で塗る */
  fillBody: boolean;
  material?: Material;
  selected: boolean;
  hover: boolean;
}

function roleLabel(s: Shape): string | null {
  switch (s.role) {
    case 'heatSource':
      return `${formatNumber(s.heatW ?? 0)} W`;
    case 'fixedTemp':
      return `${formatNumber(s.tempC ?? 0)} °C`;
    case 'support':
      return '支持';
    case 'load':
      return null; // 矢印の脇に別途描く
    default:
      return null;
  }
}

export function drawShape(p: Paint, s: Shape, o: ShapeDrawOpts): void {
  const c = p.ctx;
  const d = p.dpr;
  c.save();
  tracePath(p, s.geom);
  c.lineJoin = 'round';
  switch (s.role) {
    case 'solid':
    case 'heatSource': {
      if (o.fillBody) {
        c.globalAlpha = 0.9;
        c.fillStyle = o.material?.color ?? '#b8c2cc';
        c.fill();
        c.globalAlpha = 1;
      }
      c.lineWidth = (s.role === 'heatSource' ? 2.2 : 1.5) * d;
      c.strokeStyle = s.role === 'heatSource' ? '#d9381e' : 'rgba(31,41,55,0.85)';
      c.stroke();
      break;
    }
    case 'hole':
      if (o.fillBody) {
        c.fillStyle = '#f3f1ec';
        c.fill();
      }
      c.setLineDash([5 * d, 4 * d]);
      c.lineWidth = 1.6 * d;
      c.strokeStyle = 'rgba(31,41,55,0.75)';
      c.stroke();
      break;
    case 'fixedTemp':
      c.fillStyle = 'rgba(37,99,235,0.16)';
      c.fill();
      c.setLineDash([6 * d, 3 * d]);
      c.lineWidth = 2 * d;
      c.strokeStyle = '#1d4ed8';
      c.stroke();
      break;
    case 'support': {
      c.fillStyle = 'rgba(22,163,74,0.14)';
      c.fill();
      c.save();
      c.clip();
      const b = geomBBox(s.geom);
      c.strokeStyle = 'rgba(22,128,60,0.8)';
      c.lineWidth = 1.2 * d;
      const x0 = X(p, b.x0);
      const x1 = X(p, b.x1);
      const yTop = Y(p, b.y1);
      const yBot = Y(p, b.y0);
      const gap = 7 * d;
      c.beginPath();
      for (let k = x0 - (yBot - yTop); k < x1 + gap; k += gap) {
        c.moveTo(k, yBot);
        c.lineTo(k + (yBot - yTop), yTop);
      }
      c.stroke();
      c.restore();
      tracePath(p, s.geom);
      c.lineWidth = 2 * d;
      c.strokeStyle = '#15803d';
      c.stroke();
      break;
    }
    case 'load':
      c.fillStyle = 'rgba(234,88,12,0.14)';
      c.fill();
      c.setLineDash([6 * d, 3 * d]);
      c.lineWidth = 2 * d;
      c.strokeStyle = '#ea580c';
      c.stroke();
      break;
  }
  c.restore();

  if (s.role === 'load') drawForceArrow(p, s);
  const text = roleLabel(s);
  if (text) {
    const b = geomBBox(s.geom);
    setFont(p, 11, true);
    haloText(p, text, X(p, (b.x0 + b.x1) / 2), Y(p, (b.y0 + b.y1) / 2));
  }

  if (o.hover && !o.selected) {
    tracePath(p, s.geom);
    c.lineWidth = 2.5 * d;
    c.strokeStyle = 'rgba(37,99,235,0.45)';
    c.stroke();
  }
  if (o.selected) {
    tracePath(p, s.geom);
    c.lineWidth = 2.5 * d;
    c.strokeStyle = ACCENT;
    c.stroke();
  }
}

function drawForceArrow(p: Paint, s: Shape): void {
  const f = s.force;
  if (!f) return;
  const mag = Math.hypot(f.fx, f.fy);
  if (mag === 0) return;
  const c = p.ctx;
  const d = p.dpr;
  const b = geomBBox(s.geom);
  const cx = X(p, (b.x0 + b.x1) / 2);
  const cy = Y(p, (b.y0 + b.y1) / 2);
  const len = 52 * d;
  const ux = f.fx / mag;
  const uy = -f.fy / mag; // 画面は y が下向き
  // 矢印の先端が図形の中心に来るように、手前から描く
  const x0 = cx - ux * len;
  const y0 = cy - uy * len;
  c.save();
  c.strokeStyle = '#ea580c';
  c.fillStyle = '#ea580c';
  c.lineWidth = 3 * d;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(cx, cy);
  c.stroke();
  const head = 10 * d;
  const ang = Math.atan2(uy, ux);
  c.beginPath();
  c.moveTo(cx, cy);
  c.lineTo(cx - head * Math.cos(ang - 0.45), cy - head * Math.sin(ang - 0.45));
  c.lineTo(cx - head * Math.cos(ang + 0.45), cy - head * Math.sin(ang + 0.45));
  c.closePath();
  c.fill();
  c.restore();
  setFont(p, 11, true);
  haloText(p, formatQuantity(mag, 'N'), x0 - ux * 14 * d, y0 - uy * 14 * d, '#9a3412');
}

export function drawHandles(p: Paint, g: ShapeGeom, touch = false): void {
  const c = p.ctx;
  const size = (touch ? 12 : 8) * p.dpr;
  for (const h of geomHandles(g)) {
    const x = X(p, h.x);
    const y = Y(p, h.y);
    c.fillStyle = '#fff';
    c.strokeStyle = ACCENT;
    c.lineWidth = 2 * p.dpr;
    c.beginPath();
    if (h.id === 'r') c.arc(x, y, size / 2 + p.dpr, 0, Math.PI * 2);
    else c.rect(x - size / 2, y - size / 2, size, size);
    c.fill();
    c.stroke();
  }
}

export function drawDraft(p: Paint, d: Draft, closeNear: boolean): void {
  const c = p.ctx;
  const dpr = p.dpr;
  const pts = d.points;
  if (pts.length === 0) return;
  c.save();
  c.strokeStyle = ACCENT;
  c.fillStyle = 'rgba(37,99,235,0.12)';
  c.lineWidth = 2 * dpr;
  c.setLineDash([6 * dpr, 4 * dpr]);
  c.lineJoin = 'round';
  if (d.kind === 'rect' && pts.length >= 2) {
    const x = Math.min(pts[0][0], pts[1][0]);
    const y = Math.min(pts[0][1], pts[1][1]);
    const w = Math.abs(pts[0][0] - pts[1][0]);
    const h = Math.abs(pts[0][1] - pts[1][1]);
    tracePath(p, { kind: 'rect', x, y, w, h });
    c.fill();
    c.stroke();
    setFont(p, 11, true);
    haloText(p, `${formatQuantity(w, 'm')} × ${formatQuantity(h, 'm')}`, X(p, x + w / 2), Y(p, y + h / 2));
  } else if (d.kind === 'circle' && pts.length >= 2) {
    const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    tracePath(p, { kind: 'circle', cx: pts[0][0], cy: pts[0][1], r });
    c.fill();
    c.stroke();
    setFont(p, 11, true);
    haloText(p, `半径 ${formatQuantity(r, 'm')}`, X(p, pts[0][0]), Y(p, pts[0][1]));
  } else {
    c.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? c.moveTo(X(p, x), Y(p, y)) : c.lineTo(X(p, x), Y(p, y))));
    if (d.kind === 'polygon' && d.hover) c.lineTo(X(p, d.hover[0]), Y(p, d.hover[1]));
    if (d.kind === 'freehand') c.closePath();
    c.stroke();
    if (d.kind === 'polygon') {
      c.setLineDash([]);
      pts.forEach(([x, y], i) => {
        c.beginPath();
        c.arc(X(p, x), Y(p, y), (i === 0 && closeNear ? 7 : 4) * dpr, 0, Math.PI * 2);
        c.fillStyle = i === 0 ? '#fff' : ACCENT;
        c.fill();
        c.stroke();
      });
    }
  }
  c.restore();
}

// ---------- 凡例・スケールバー ----------

/** 1, 2, 5 × 10^k のうち v 以下で最大のもの */
export function niceFloor(v: number): number {
  if (!(v > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / e;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * e;
}

/** 1, 2, 5 × 10^k のうち v 以上で最小のもの（グリッド間隔用） */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / e;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e;
}

const lutCache = new Map<ColormapName, Uint8ClampedArray>();

export function getLUT(name: ColormapName): Uint8ClampedArray {
  let l = lutCache.get(name);
  if (!l) lutCache.set(name, (l = buildLUT(name)));
  return l;
}

export function drawLegend(p: Paint, field: Field, range: Range, cmap: ColormapName): void {
  const c = p.ctx;
  const d = p.dpr;
  const r = formatRange(range.min, range.max, field.unit);
  const title = r.unit ? `${field.label} [${r.unit}]` : field.label;
  const w = 180 * d;
  const h = 50 * d;
  const x = p.ctx.canvas.width - w - 10 * d;
  const y = p.H - h - 10 * d;
  c.save();
  c.fillStyle = 'rgba(255,255,255,0.86)';
  roundRectPath(c, x, y, w, h, 8 * d);
  c.fill();
  setFont(p, 11, true);
  c.fillStyle = '#1f2937';
  c.textAlign = 'left';
  c.textBaseline = 'top';
  c.fillText(title, x + 9 * d, y + 7 * d, w - 18 * d);
  // グラデーションバー
  const bx = x + 9 * d;
  const bw = w - 18 * d;
  const by = y + 24 * d;
  const bh = 9 * d;
  const lut = getLUT(cmap);
  for (let i = 0; i < bw; i++) {
    const k = Math.round((i / (bw - 1)) * 255) * 4;
    c.fillStyle = `rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]})`;
    c.fillRect(bx + i, by, 1.5, bh);
  }
  c.strokeStyle = 'rgba(0,0,0,0.25)';
  c.lineWidth = d;
  c.strokeRect(bx, by, bw, bh);
  setFont(p, 10.5);
  c.fillStyle = '#374151';
  c.textBaseline = 'top';
  c.textAlign = 'left';
  c.fillText(r.min, bx, by + bh + 3 * d);
  c.textAlign = 'right';
  c.fillText(r.max, bx + bw, by + bh + 3 * d);
  if (cmap === 'diverging') {
    c.textAlign = 'center';
    c.fillText('0', bx + bw / 2, by + bh + 3 * d);
  }
  c.restore();
}

export function drawScaleBar(p: Paint): void {
  const c = p.ctx;
  const d = p.dpr;
  const cssPerM = p.sc / d;
  const L = niceFloor(130 / cssPerM);
  const len = L * p.sc;
  const label = formatQuantity(L, 'm');
  const x = 10 * d;
  const y = p.H - 10 * d;
  setFont(p, 11, true);
  const tw = c.measureText(label).width;
  c.save();
  c.fillStyle = 'rgba(255,255,255,0.86)';
  roundRectPath(c, x, y - 34 * d, Math.max(len, tw) + 18 * d, 34 * d, 8 * d);
  c.fill();
  c.strokeStyle = '#1f2937';
  c.lineWidth = 2 * d;
  c.beginPath();
  const bx = x + 9 * d;
  const by = y - 9 * d;
  c.moveTo(bx, by - 5 * d);
  c.lineTo(bx, by);
  c.lineTo(bx + len, by);
  c.lineTo(bx + len, by - 5 * d);
  c.stroke();
  c.fillStyle = '#1f2937';
  c.textAlign = 'left';
  c.textBaseline = 'top';
  c.fillText(label, bx, y - 29 * d);
  c.restore();
}

// ---------- 変形輪郭（強度） ----------

export interface DispField {
  ux: Float32Array;
  uy: Float32Array;
  mask?: Uint8Array;
  nx: number;
  ny: number;
  h: number;
}

/** セル (i, j) が使えなければ周囲 8 セルから有効なものを探す */
function sampleCell(f: DispField, x: number, y: number): number {
  const i0 = Math.min(f.nx - 1, Math.max(0, Math.floor(x / f.h)));
  const j0 = Math.min(f.ny - 1, Math.max(0, Math.floor(y / f.h)));
  for (let r = 0; r <= 2; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const i = i0 + di;
        const j = j0 + dj;
        if (i < 0 || j < 0 || i >= f.nx || j >= f.ny) continue;
        const c = j * f.nx + i;
        if (!f.mask || f.mask[c] !== 0) return c;
      }
    }
  }
  return j0 * f.nx + i0;
}

export function maxDisplacement(f: DispField): number {
  let m = 0;
  for (let c = 0; c < f.ux.length; c++) {
    if (f.mask && f.mask[c] === 0) continue;
    const s = Math.hypot(f.ux[c], f.uy[c]);
    if (s > m) m = s;
  }
  return m;
}

/** 目に見える大きさ（領域の短辺の約 6%）まで変位を誇張する倍率。最小 1 倍 */
export function exaggerationFactor(maxDisp: number, domainMin: number): number {
  if (!(maxDisp > 0)) return 1;
  return Math.min(2000, Math.max(1, (0.06 * domainMin) / maxDisp));
}

export function drawDeformed(p: Paint, shapes: Shape[], f: DispField, factor: number): void {
  const c = p.ctx;
  c.save();
  c.setLineDash([7 * p.dpr, 4 * p.dpr]);
  c.lineWidth = 2.2 * p.dpr;
  c.strokeStyle = '#c026d3';
  c.lineJoin = 'round';
  for (const s of shapes) {
    if (s.role !== 'solid' && s.role !== 'heatSource') continue;
    const poly = geomToPolygon(s.geom, 48, 24);
    c.beginPath();
    poly.forEach(([x, y], i) => {
      const k = sampleCell(f, x, y);
      const px = X(p, x + f.ux[k] * factor);
      const py = Y(p, y + f.uy[k] * factor);
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    });
    c.closePath();
    c.stroke();
  }
  c.restore();
  setFont(p, 11, true);
  c.save();
  c.textAlign = 'left';
  c.textBaseline = 'top';
  c.fillStyle = '#a21caf';
  c.lineWidth = 3 * p.dpr;
  c.strokeStyle = 'rgba(255,255,255,0.9)';
  const t = `変形を ${formatNumber(factor, 2)} 倍に誇張（点線）`;
  c.strokeText(t, 12 * p.dpr, 12 * p.dpr);
  c.fillText(t, 12 * p.dpr, 12 * p.dpr);
  c.restore();
}

export function drawGrid(p: Paint, widthM: number, heightM: number): void {
  const c = p.ctx;
  const step = niceCeil(48 / (p.sc / p.dpr));
  c.save();
  c.strokeStyle = 'rgba(100,100,100,0.16)';
  c.lineWidth = p.dpr;
  c.beginPath();
  for (let x = step; x < widthM; x += step) {
    const px = Math.round(X(p, x)) + 0.5;
    c.moveTo(px, 0);
    c.lineTo(px, p.H);
  }
  for (let y = step; y < heightM; y += step) {
    const py = Math.round(Y(p, y)) + 0.5;
    c.moveTo(0, py);
    c.lineTo(p.ctx.canvas.width, py);
  }
  c.stroke();
  c.restore();
}
