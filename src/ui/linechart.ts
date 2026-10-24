// 断面グラフ: 線に沿った場の値を小さな折れ線グラフにする（Canvas 2D、依存なし）。
import { formatNumber, pickUnit } from './format';
import type { ProfilePoint } from './probes';

/** min〜max を count 個前後の「きりのよい」目盛りに分ける */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max - min < 1e-30) return [min];
  const raw = (max - min) / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * pow;
  const out: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export interface ChartOpts {
  /** 縦軸のラベル（例: 温度） */
  label: string;
  /** 縦軸の単位（例: °C）。接頭辞は自動で選ぶ */
  unit: string;
}

interface Tokens {
  ink: string;
  muted: string;
  line: string;
  accent: string;
  panel: string;
}

function tokens(el: Element): Tokens {
  const cs = getComputedStyle(el);
  const get = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  return { ink: get('--ink', '#26221c'), muted: get('--muted', '#6b6459'), line: get('--line', '#e3ddd2'), accent: get('--accent', '#e8590c'), panel: get('--panel', '#fffdf9') };
}

const FONT = '"Hiragino Sans","Noto Sans JP","Yu Gothic UI",system-ui,sans-serif';

/** 値の範囲と、有効な点があるか */
export function profileRange(profile: ProfilePoint[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const p of profile) {
    if (p.v === null) continue;
    min = Math.min(min, p.v);
    max = Math.max(max, p.v);
  }
  return min <= max ? { min, max } : null;
}

/** canvas の見た目の大きさに合わせて、折れ線グラフを描く */
export function drawProfile(canvas: HTMLCanvasElement, profile: ProfilePoint[], opts: ChartOpts): void {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssW = Math.max(160, canvas.clientWidth || 300);
  const cssH = Math.max(100, canvas.clientHeight || 150);
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const t = tokens(canvas);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = t.panel;
  ctx.fillRect(0, 0, cssW, cssH);

  const range = profileRange(profile);
  const L = 46;
  const R = 10;
  const T = 20;
  const B = 34;
  const pw = cssW - L - R;
  const ph = cssH - T - B;
  ctx.font = `11px ${FONT}`;
  ctx.textBaseline = 'middle';

  if (!range || profile.length < 2) {
    ctx.fillStyle = t.muted;
    ctx.textAlign = 'center';
    ctx.fillText('この線上に値がありません', cssW / 2, cssH / 2);
    return;
  }

  const unit = pickUnit(Math.max(Math.abs(range.min), Math.abs(range.max)), opts.unit);
  let lo = range.min / unit.scale;
  let hi = range.max / unit.scale;
  if (hi - lo < 1e-12 * Math.max(1, Math.abs(hi))) {
    const pad = Math.abs(hi) * 0.05 || 1;
    lo -= pad;
    hi += pad;
  } else {
    const pad = (hi - lo) * 0.06;
    lo -= pad;
    hi += pad;
  }
  const sMax = profile[profile.length - 1].s * 1000;
  const X = (sMm: number): number => L + (sMm / sMax) * pw;
  const Y = (v: number): number => T + (1 - (v - lo) / (hi - lo)) * ph;

  // 目盛りと格子線
  ctx.lineWidth = 1;
  ctx.strokeStyle = t.line;
  ctx.fillStyle = t.muted;
  ctx.textAlign = 'right';
  for (const v of niceTicks(lo, hi, 4)) {
    const y = Y(v);
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(L + pw, y);
    ctx.stroke();
    ctx.fillText(formatNumber(v, 3), L - 5, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const s of niceTicks(0, sMax, 5)) {
    const x = X(s);
    ctx.beginPath();
    ctx.moveTo(x, T + ph);
    ctx.lineTo(x, T + ph + 3);
    ctx.stroke();
    ctx.fillText(formatNumber(s, 3), x, T + ph + 4);
  }

  // 軸
  ctx.strokeStyle = t.muted;
  ctx.beginPath();
  ctx.moveTo(L, T);
  ctx.lineTo(L, T + ph);
  ctx.lineTo(L + pw, T + ph);
  ctx.stroke();

  // 軸ラベル（単位つき）
  ctx.fillStyle = t.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(unit.unit ? `${opts.label} [${unit.unit}]` : opts.label, 4, 3);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('距離 [mm]', cssW - 4, cssH - 1);

  // 折れ線（値のない区間では途切れさせる）
  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let pen = false;
  for (const p of profile) {
    if (p.v === null) {
      pen = false;
      continue;
    }
    const x = X(p.s * 1000);
    const y = Y(p.v / unit.scale);
    if (pen) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    pen = true;
  }
  ctx.stroke();
}
