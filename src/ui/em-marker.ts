// 電磁波の波源をキャンバスに描き、点波源はドラッグで動かせるようにする。
import type { Pt } from './geometry';
import { ACCENT, setFont, type Paint } from './overlay';
import { clampEmPoint } from './easy-logic';
import type { CanvasView } from './render';
import type { Store } from './state';

const SRC = '#c2410c';

function arrow(p: Paint, from: Pt, to: Pt): void {
  const c = p.ctx;
  const d = p.dpr;
  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const hd = 7 * d;
  c.beginPath();
  c.moveTo(from[0], from[1]);
  c.lineTo(to[0], to[1]);
  c.moveTo(to[0], to[1]);
  c.lineTo(to[0] - hd * Math.cos(ang - 0.45), to[1] - hd * Math.sin(ang - 0.45));
  c.moveTo(to[0], to[1]);
  c.lineTo(to[0] - hd * Math.cos(ang + 0.45), to[1] - hd * Math.sin(ang + 0.45));
  c.stroke();
}

/** 波源の印: 平面波は進む向きの矢印、点波源は ● と同心円 */
export function drawEmSource(p: Paint, store: Store): void {
  if (store.analysis !== 'em') return;
  const { em, domain } = store.project;
  const c = p.ctx;
  const d = p.dpr;
  c.save();
  c.lineCap = 'round';
  if (em.source === 'plane') {
    const th = (em.angleDeg * Math.PI) / 180;
    const dx = Math.cos(th);
    const dy = Math.sin(th);
    const L = Math.min(domain.width, domain.height);
    const cx = domain.width / 2 - dx * L * 0.38;
    const cy = domain.height / 2 - dy * L * 0.38;
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.lineWidth = 4 * d;
    const lines: [Pt, Pt][] = [-1, 0, 1].map((k) => {
      const ox = cx - dy * k * L * 0.22;
      const oy = cy + dx * k * L * 0.22;
      return [
        [ox * p.sc, p.H - oy * p.sc],
        [(ox + dx * L * 0.14) * p.sc, p.H - (oy + dy * L * 0.14) * p.sc],
      ];
    });
    for (const [a, b] of lines) arrow(p, a, b);
    c.strokeStyle = ACCENT;
    c.lineWidth = 2 * d;
    for (const [a, b] of lines) arrow(p, a, b);
  } else {
    const q = clampEmPoint(store.project);
    const x = q.x * p.sc;
    const y = p.H - q.y * p.sc;
    c.lineWidth = 2 * d;
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    for (const r of [16, 10]) {
      c.beginPath();
      c.arc(x, y, r * d, 0, Math.PI * 2);
      c.stroke();
    }
    c.strokeStyle = SRC;
    c.lineWidth = 1.4 * d;
    for (const r of [16, 10]) {
      c.beginPath();
      c.arc(x, y, r * d, 0, Math.PI * 2);
      c.stroke();
    }
    c.beginPath();
    c.arc(x, y, 5.5 * d, 0, Math.PI * 2);
    c.fillStyle = SRC;
    c.fill();
    c.lineWidth = 1.6 * d;
    c.strokeStyle = '#fff';
    c.stroke();
    setFont(p, 12, true);
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.lineWidth = 3 * d;
    c.strokeStyle = 'rgba(255,255,255,0.92)';
    c.strokeText('波源', x + 20 * d, y);
    c.fillStyle = SRC;
    c.fillText('波源', x + 20 * d, y);
  }
  c.restore();
}

/** 点波源のドラッグ移動。Editor より先にイベントを受け取り、波源を掴んだときだけ横取りする */
export function attachEmMarker(store: Store, view: CanvasView): void {
  const canvas = view.canvas;
  let dragging = false;
  let moved = false;

  canvas.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (store.analysis !== 'em') return;
      if (store.tool !== 'select' || store.project.em.source !== 'point') return;
      const dom = store.project.domain;
      const w = view.toWorld(e.clientX, e.clientY, dom);
      const q = clampEmPoint(store.project);
      const tol = view.pxToWorld(e.pointerType === 'mouse' ? 14 : 22, dom);
      if (Math.hypot(w[0] - q.x, w[1] - q.y) > tol) return;
      e.stopImmediatePropagation();
      dragging = true;
      moved = false;
      canvas.setPointerCapture(e.pointerId);
    },
    true,
  );
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    e.stopImmediatePropagation();
    const dom = store.project.domain;
    const w = view.toWorld(e.clientX, e.clientY, dom);
    if (!moved) {
      store.checkpoint();
      moved = true;
    }
    store.project.em.pointX = Math.min(dom.width, Math.max(0, w[0]));
    store.project.em.pointY = Math.min(dom.height, Math.max(0, w[1]));
    store.touch('canvas');
    view.invalid = true;
  });
  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}
