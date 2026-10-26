// 断面の 2D プレビューを canvas に描く。外形と穴を色分けし、軸の名前と大きさの目安を添える。
// 取り込みダイアログ（import-dialog.ts）から使う画面側のファイル。
import type { SliceResult } from './slice';
import { AXIS_NAMES } from './types';

export interface SectionPreviewColors {
  accent: string;
  blue: string;
  ink: string;
  muted: string;
}

const PAD = 14;

interface Fit {
  scale: number;
  ox: number;
  oy: number;
}

/** 断面の外接箱 [u0, v0, u1, v1] が canvas にちょうど収まる倍率と原点（y は上向き） */
function fit(b: [number, number, number, number], cssW: number, cssH: number): Fit {
  const w = Math.max(b[2] - b[0], 1e-12);
  const h = Math.max(b[3] - b[1], 1e-12);
  const scale = Math.max(1e-9, Math.min((cssW - 2 * PAD) / w, (cssH - 2 * PAD) / h));
  return { scale, ox: (cssW - w * scale) / 2 - b[0] * scale, oy: (cssH + h * scale) / 2 + b[1] * scale };
}

/** 断面の縦横比から、プレビューの高さを決める */
export function sectionPreviewHeight(slice: SliceResult | null, cssW: number, maxH: number): number {
  if (!slice?.bounds2d) return Math.min(maxH, Math.max(160, Math.round(cssW * 0.6)));
  const [u0, v0, u1, v1] = slice.bounds2d;
  const ratio = (v1 - v0) / Math.max(u1 - u0, 1e-12);
  return Math.round(Math.min(maxH, Math.max(150, (cssW - 2 * PAD) * ratio + 2 * PAD)));
}

export function drawSection(canvas: HTMLCanvasElement, slice: SliceResult | null, colors: SectionPreviewColors, unit: string, cssW: number, cssH: number): void {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.font = '12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  if (!slice) return;
  if (!slice.bounds2d || slice.loops.length === 0) {
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'center';
    ctx.fillText('この位置では断面が空です', cssW / 2, cssH / 2);
    return;
  }
  const f = fit(slice.bounds2d, cssW, cssH);
  const X = (x: number): number => f.ox + x * f.scale;
  const Y = (y: number): number => f.oy - y * f.scale;
  const trace = (pts: [number, number][]): void => {
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(X(x), Y(y)) : ctx.lineTo(X(x), Y(y))));
    ctx.closePath();
  };

  // 偶奇規則で塗る（穴は抜け、穴の中の島は塗られる）
  ctx.beginPath();
  for (const l of slice.loops) trace(l.points);
  ctx.fillStyle = 'rgba(232, 89, 12, 0.22)';
  ctx.fill('evenodd');
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  for (const l of slice.loops) {
    ctx.beginPath();
    trace(l.points);
    ctx.strokeStyle = l.hole ? colors.blue : colors.accent;
    ctx.setLineDash(l.hole ? [5, 3] : []);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 軸の名前と、外形の大きさ
  const [u0, v0, u1, v1] = slice.bounds2d;
  const round = (v: number): string => String(Math.round(v * 100) / 100);
  ctx.fillStyle = colors.muted;
  ctx.textAlign = 'left';
  ctx.fillText(`横 ${AXIS_NAMES[slice.uAxis]}　縦 ${AXIS_NAMES[slice.vAxis]}`, 8, cssH - 10);
  ctx.textAlign = 'right';
  ctx.fillText(`${round(u1 - u0)} × ${round(v1 - v0)} ${unit}`, cssW - 8, cssH - 10);
}
