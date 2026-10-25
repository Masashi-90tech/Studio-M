// 取り込む基板のプレビューを canvas に描く。外形・銅箔（層ごと）・部品の枠と名前・発熱する部品の強調。
// 取り込みダイアログ（import-dialog.ts）から使う画面側のファイル。
import type { PartAssignment } from './build';
import type { KicadBoard } from './kicad';

export interface PreviewState {
  board: KicadBoard;
  parts: PartAssignment[];
  /** 表示する銅箔の層 */
  visibleLayers: ReadonlySet<string>;
  /** 選ばれている部品（PartAssignment.key） */
  selectedKey: string | null;
  /** 描画に使う色（style.css の変数から取る） */
  colors: { accent: string; blue: string; ink: string; muted: string };
}

/** 画面の座標と基板の座標を行き来するための情報 */
export interface PreviewView {
  /** 基板 1 m あたりの CSS ピクセル数 */
  scale: number;
  /** 基板の x = 0 の CSS ピクセル位置 */
  ox: number;
  /** 基板の y = 0 の CSS ピクセル位置（y は上向きなので、画面では下端側） */
  oy: number;
}

/** 銅箔の層の色。表は赤、裏は青、内層は緑系 */
export function layerColor(name: string): string {
  if (name === 'F.Cu') return '#d9482b';
  if (name === 'B.Cu') return '#2f6fd6';
  const n = Number(/^In(\d+)\.Cu$/.exec(name)?.[1] ?? 1);
  return n % 2 ? '#2a9d6f' : '#9b59b6';
}

/** 描画順: 裏 → 内層 → 表（表が上に見える） */
function drawOrder(names: string[]): string[] {
  const rank = (n: string) => (n === 'B.Cu' ? 0 : n === 'F.Cu' ? 2 : 1);
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** canvas の大きさを CSS ピクセルで cssW × cssH に合わせ、基板がちょうど収まる向きと倍率を返す */
export function fitView(board: KicadBoard, cssW: number, cssH: number, pad = 12): PreviewView {
  const w = Math.max(1e-9, board.bbox.x1 - board.bbox.x0);
  const h = Math.max(1e-9, board.bbox.y1 - board.bbox.y0);
  const scale = Math.max(1, Math.min((cssW - 2 * pad) / w, (cssH - 2 * pad) / h));
  const ox = (cssW - w * scale) / 2 - board.bbox.x0 * scale;
  const oy = (cssH + h * scale) / 2 + board.bbox.y0 * scale;
  return { scale, ox, oy };
}

/** 基板の高さ ÷ 幅から、プレビューの高さを決める */
export function previewHeight(board: KicadBoard, cssW: number, maxH: number): number {
  const w = Math.max(1e-9, board.bbox.x1 - board.bbox.x0);
  const h = Math.max(1e-9, board.bbox.y1 - board.bbox.y0);
  return Math.round(Math.min(maxH, Math.max(140, ((cssW - 24) * h) / w + 24)));
}

export function drawPreview(canvas: HTMLCanvasElement, state: PreviewState, cssW: number, cssH: number): PreviewView {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);

  const { board } = state;
  const view = fitView(board, cssW, cssH);
  const X = (x: number) => view.ox + x * view.scale;
  const Y = (y: number) => view.oy - y * view.scale;
  const trace = (g: CanvasRenderingContext2D, pts: [number, number][]) => {
    pts.forEach(([x, y], i) => (i === 0 ? g.moveTo(X(x), Y(y)) : g.lineTo(X(x), Y(y))));
    g.closePath();
  };

  // 基板（FR-4）。切り抜きは偶奇規則で抜く
  ctx.beginPath();
  trace(ctx, board.outline);
  for (const hole of board.holes) trace(ctx, hole);
  ctx.fillStyle = '#dfe9d8';
  ctx.fill('evenodd');
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#5b6b53';
  ctx.stroke();

  // 銅箔: 層ごとに別のキャンバスへ不透明に描いてから、半透明で重ねる（多角形が重なっても穴があかない）
  const layerCanvas = document.createElement('canvas');
  layerCanvas.width = canvas.width;
  layerCanvas.height = canvas.height;
  const lg = layerCanvas.getContext('2d')!;
  lg.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const name of drawOrder(board.layers.map((l) => l.name))) {
    if (!state.visibleLayers.has(name)) continue;
    const layer = board.layers.find((l) => l.name === name)!;
    lg.clearRect(0, 0, cssW, cssH);
    lg.fillStyle = layerColor(name);
    for (const poly of layer.polygons) {
      lg.beginPath();
      trace(lg, poly);
      lg.fill();
    }
    ctx.save();
    // 基板の外にはみ出した銅箔は見せない
    ctx.beginPath();
    trace(ctx, board.outline);
    ctx.clip();
    ctx.globalAlpha = 0.6;
    ctx.drawImage(layerCanvas, 0, 0, cssW, cssH);
    ctx.restore();
  }

  // 部品の枠と名前
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const powered = (p: PartAssignment) => p.included && p.watts > 0;
  const watched = (p: PartAssignment) => p.included && !(p.watts > 0);
  for (const p of state.parts) {
    const x0 = X(p.bbox.x0);
    const x1 = X(p.bbox.x1);
    const y0 = Y(p.bbox.y1);
    const y1 = Y(p.bbox.y0);
    const w = x1 - x0;
    const h = y1 - y0;
    const on = powered(p);
    ctx.lineWidth = on ? 2 : 1;
    ctx.setLineDash(p.side === 'back' ? [4, 3] : []);
    if (on) {
      ctx.fillStyle = hexAlpha(state.colors.accent, 0.28);
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = state.colors.accent;
    } else if (watched(p)) {
      ctx.strokeStyle = state.colors.blue;
    } else {
      ctx.strokeStyle = 'rgba(60, 60, 60, 0.45)';
    }
    ctx.strokeRect(x0, y0, w, h);
    ctx.setLineDash([]);
    if (on || w >= 22) {
      const label = on ? `${p.ref} ${fmtW(p.watts)}` : p.ref;
      ctx.fillStyle = on ? '#7a2e00' : 'rgba(40, 40, 40, 0.85)';
      if (on) ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillText(label, (x0 + x1) / 2, (y0 + y1) / 2, Math.max(w, 28));
      if (on) ctx.font = '10px system-ui, sans-serif';
    }
  }
  const sel = state.parts.find((p) => p.key === state.selectedKey);
  if (sel) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = state.colors.blue;
    ctx.strokeRect(X(sel.bbox.x0) - 1, Y(sel.bbox.y1) - 1, (sel.bbox.x1 - sel.bbox.x0) * view.scale + 2, (sel.bbox.y1 - sel.bbox.y0) * view.scale + 2);
  }
  return view;
}

function fmtW(w: number): string {
  return `${w >= 10 ? Math.round(w) : Math.round(w * 100) / 100}W`;
}

function hexAlpha(color: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return `rgba(232, 89, 12, ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** 画面上の点 (px, py)（canvas の左上が原点）にある部品。重なっていれば小さい方を優先 */
export function hitPart(parts: PartAssignment[], view: PreviewView, px: number, py: number): PartAssignment | null {
  const x = (px - view.ox) / view.scale;
  const y = (view.oy - py) / view.scale;
  let best: PartAssignment | null = null;
  let bestArea = Infinity;
  for (const p of parts) {
    if (x < p.bbox.x0 || x > p.bbox.x1 || y < p.bbox.y0 || y > p.bbox.y1) continue;
    const area = (p.bbox.x1 - p.bbox.x0) * (p.bbox.y1 - p.bbox.y0);
    if (area < bestArea) {
      best = p;
      bestArea = area;
    }
  }
  return best;
}
