// プロ用ツールをキャンバスに重ねて描く: プローブの十字と番号、断面の線。
import type { Pt } from './geometry';
import { setFont, type Paint } from './overlay';
import type { ProState } from './probes';

const PROBE = '#0f766e';
const SECTION = '#7c3aed';

function halo(p: Paint, text: string, x: number, y: number, color: string): void {
  const c = p.ctx;
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  c.lineWidth = 3 * p.dpr;
  c.strokeStyle = 'rgba(255,255,255,0.92)';
  c.strokeText(text, x, y);
  c.fillStyle = color;
  c.fillText(text, x, y);
}

const px = (p: Paint, q: Pt): Pt => [q[0] * p.sc, p.H - q[1] * p.sc];

export function drawProbes(p: Paint, state: ProState): void {
  const c = p.ctx;
  const d = p.dpr;
  c.save();
  setFont(p, 12, true);
  state.probes.forEach((pr, idx) => {
    const [x, y] = px(p, [pr.x, pr.y]);
    c.lineWidth = 3 * d;
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    cross(p, x, y);
    c.lineWidth = 1.6 * d;
    c.strokeStyle = PROBE;
    cross(p, x, y);
    c.beginPath();
    c.arc(x, y, 5 * d, 0, Math.PI * 2);
    c.stroke();
    halo(p, String(idx + 1), x + 9 * d, y - 9 * d, PROBE);
  });
  c.restore();
}

function cross(p: Paint, x: number, y: number): void {
  const c = p.ctx;
  const r = 10 * p.dpr;
  c.beginPath();
  c.moveTo(x - r, y);
  c.lineTo(x + r, y);
  c.moveTo(x, y - r);
  c.lineTo(x, y + r);
  c.stroke();
}

export function drawSection(p: Paint, state: ProState): void {
  const s = state.section;
  if (!s) return;
  const c = p.ctx;
  const d = p.dpr;
  const [ax, ay] = px(p, s.a);
  const [bx, by] = px(p, s.b);
  c.save();
  c.lineCap = 'round';
  c.setLineDash([7 * d, 5 * d]);
  c.lineWidth = 3.4 * d;
  c.strokeStyle = 'rgba(255,255,255,0.9)';
  c.beginPath();
  c.moveTo(ax, ay);
  c.lineTo(bx, by);
  c.stroke();
  c.lineWidth = 1.8 * d;
  c.strokeStyle = SECTION;
  c.stroke();
  c.setLineDash([]);
  setFont(p, 12, true);
  for (const [label, x, y] of [['A', ax, ay], ['B', bx, by]] as const) {
    c.beginPath();
    c.arc(x, y, 4.5 * d, 0, Math.PI * 2);
    c.fillStyle = SECTION;
    c.fill();
    halo(p, label, x + 8 * d, y - 8 * d, SECTION);
  }
  c.restore();
}
