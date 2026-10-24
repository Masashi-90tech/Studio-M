// キャンバス上の作図・選択・移動・変形（ポインターイベントでマウスとタッチの両方に対応）。
import type { ShapeGeom } from '../core/types';
import { toast } from './dom';
import {
  applyHandle,
  cloneGeom,
  dedupePoints,
  hitHandle,
  hitShape,
  MIN_SIZE,
  polygonArea,
  rectFromPoints,
  simplifyFreehand,
  snapPoint,
  snapValue,
  translateGeom,
  type Pt,
} from './geometry';
import type { Draft } from './overlay';
import type { CanvasView } from './render';
import type { Store, Tool } from './state';

type Drag =
  | { type: 'move'; id: string; start: Pt; orig: ShapeGeom; moved: boolean; startClient: Pt }
  | { type: 'handle'; id: string; handle: string; orig: ShapeGeom; moved: boolean }
  | { type: 'create'; kind: 'rect' | 'circle'; a: Pt }
  | { type: 'free' }
  | { type: 'polyclick'; startClient: Pt };

const HELP: Record<Tool, string> = {
  select: '図形をクリックで選択、ドラッグで移動。白い点をドラッグすると形を変えられます',
  rect: 'ドラッグで長方形を描きます（クリックだけでも置けます）',
  circle: '中心からドラッグして円を描きます（クリックだけでも置けます）',
  polygon: 'クリックで点を打ち、ダブルクリックか Enter で閉じます（最初の点をクリックでも閉じます）',
  freehand: '指やマウスで囲むように描くと、なめらかな多角形になります',
  delete: '消したい図形をクリックします',
};

export class Editor {
  draft: Draft | null = null;
  hoverId: string | null = null;
  closeNear = false;
  touch = false;
  /** 直近のポインター位置 [m]（座標表示用） */
  lastWorld: Pt | null = null;
  private drag: Drag | null = null;
  private canvas: HTMLCanvasElement;

  constructor(
    private store: Store,
    private view: CanvasView,
    private bar: HTMLElement,
  ) {
    this.canvas = view.canvas;
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onCancel(e));
    c.addEventListener('pointerleave', () => {
      this.lastWorld = null;
      if (this.hoverId) {
        this.hoverId = null;
        this.view.invalid = true;
      }
    });
    c.addEventListener('dblclick', () => {
      if (this.store.tool === 'polygon') this.finishPolygon();
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e));
    store.on('tool', () => this.cancelDraft());
    store.on('load', () => this.cancelDraft());
    bar.querySelector('[data-act="finish"]')?.addEventListener('click', () => this.finishPolygon());
    bar.querySelector('[data-act="cancel"]')?.addEventListener('click', () => this.cancelDraft());
    this.updateBar();
  }

  /** 操作の一行ヘルプ */
  helpText(): string {
    return HELP[this.store.tool];
  }

  private get domain() {
    return this.store.project.domain;
  }

  private cellStep(): number {
    return this.domain.width / this.domain.nx;
  }

  private world(e: PointerEvent | MouseEvent): Pt {
    const p = this.view.toWorld(e.clientX, e.clientY, this.domain);
    return this.store.view.snap ? snapPoint(p, this.cellStep()) : p;
  }

  private tolWorld(): number {
    return this.view.pxToWorld(this.touch ? 16 : 9, this.domain);
  }

  private invalidate(): void {
    this.view.invalid = true;
  }

  // ---------- ポインター ----------

  private onDown(e: PointerEvent): void {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    this.touch = e.pointerType !== 'mouse';
    const p = this.world(e);
    this.lastWorld = p;
    const tool = this.store.tool;
    const tol = this.tolWorld();
    const startClient: Pt = [e.clientX, e.clientY];

    if (tool === 'select') {
      const sel = this.store.getShape(this.store.selectedId);
      const handle = sel ? hitHandle(sel.geom, p[0], p[1], tol) : undefined;
      if (sel && handle) {
        this.drag = { type: 'handle', id: sel.id, handle: handle.id, orig: cloneGeom(sel.geom), moved: false };
      } else {
        const hit = hitShape(this.store.project.shapes, p[0], p[1], tol * 0.5);
        this.store.select(hit ? hit.id : null);
        if (hit) this.drag = { type: 'move', id: hit.id, start: p, orig: cloneGeom(hit.geom), moved: false, startClient };
      }
    } else if (tool === 'delete') {
      const hit = hitShape(this.store.project.shapes, p[0], p[1], tol * 0.5);
      if (hit) this.store.deleteShape(hit.id);
      return;
    } else if (tool === 'rect' || tool === 'circle') {
      this.drag = { type: 'create', kind: tool, a: p };
      this.draft = { kind: tool, points: [p, p] };
    } else if (tool === 'freehand') {
      this.drag = { type: 'free' };
      this.draft = { kind: 'freehand', points: [p] };
    } else if (tool === 'polygon') {
      this.drag = { type: 'polyclick', startClient };
    }
    if (this.drag) this.canvas.setPointerCapture(e.pointerId);
    this.invalidate();
  }

  private onMove(e: PointerEvent): void {
    if (!e.isPrimary) return;
    const p = this.world(e);
    this.lastWorld = p;
    const d = this.drag;
    const tol = this.tolWorld();

    if (!d) {
      if (this.store.tool === 'polygon' && this.draft) {
        this.draft.hover = p;
        this.closeNear = this.draft.points.length >= 3 && Math.hypot(p[0] - this.draft.points[0][0], p[1] - this.draft.points[0][1]) < tol;
        this.invalidate();
      } else if (e.pointerType === 'mouse') {
        this.updateHover(p, tol);
      }
      return;
    }

    switch (d.type) {
      case 'move': {
        const dist = Math.hypot(e.clientX - d.startClient[0], e.clientY - d.startClient[1]);
        if (!d.moved && dist < 3) return;
        if (!d.moved) {
          this.store.checkpoint();
          d.moved = true;
        }
        let dx = p[0] - d.start[0];
        let dy = p[1] - d.start[1];
        if (this.store.view.snap) {
          dx = snapValue(dx, this.cellStep());
          dy = snapValue(dy, this.cellStep());
        }
        const s = this.store.getShape(d.id);
        if (s) {
          s.geom = translateGeom(d.orig, dx, dy);
          this.store.touch('canvas');
        }
        break;
      }
      case 'handle': {
        const s = this.store.getShape(d.id);
        if (s) {
          if (!d.moved) {
            this.store.checkpoint();
            d.moved = true;
          }
          s.geom = applyHandle(d.orig, d.handle, p[0], p[1]);
          this.store.touch('canvas');
        }
        break;
      }
      case 'create':
        if (this.draft) this.draft.points = [d.a, p];
        break;
      case 'free': {
        const pts = this.draft?.points;
        if (pts) {
          const last = pts[pts.length - 1];
          if (Math.hypot(p[0] - last[0], p[1] - last[1]) > this.view.pxToWorld(2, this.domain)) pts.push(p);
        }
        break;
      }
      case 'polyclick':
        break;
    }
    this.invalidate();
  }

  private onUp(e: PointerEvent): void {
    if (!e.isPrimary) return;
    const d = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!d) return;
    const p = this.world(e);
    const dom = this.domain;

    if (d.type === 'create') {
      const [a] = this.draft?.points ?? [d.a];
      this.draft = null;
      const minDrag = this.view.pxToWorld(6, dom);
      const moved = Math.hypot(p[0] - a[0], p[1] - a[1]) > minDrag;
      if (d.kind === 'rect') {
        if (moved && Math.abs(p[0] - a[0]) > MIN_SIZE && Math.abs(p[1] - a[1]) > MIN_SIZE) this.store.addShape(rectFromPoints(a, p));
        else {
          // クリックだけ: 既定の大きさで置く
          const s = dom.height * 0.12;
          this.store.addShape({ kind: 'rect', x: a[0] - s / 2, y: a[1] - s / 2, w: s, h: s });
        }
      } else {
        const r = Math.hypot(p[0] - a[0], p[1] - a[1]);
        this.store.addShape({ kind: 'circle', cx: a[0], cy: a[1], r: moved && r > MIN_SIZE ? r : dom.height * 0.06 });
      }
    } else if (d.type === 'free') {
      const pts = this.draft?.points ?? [];
      this.draft = null;
      const poly = simplifyFreehand(pts, this.view.pxToWorld(2.5, dom));
      if (poly) this.store.addShape({ kind: 'polygon', points: poly });
      else toast('もう少し大きく囲むように描いてください');
    } else if (d.type === 'polyclick') {
      if (Math.hypot(e.clientX - d.startClient[0], e.clientY - d.startClient[1]) < 8) this.addPolygonPoint(p);
    }
    this.invalidate();
    this.updateBar();
  }

  private onCancel(e: PointerEvent): void {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
    if (this.store.tool !== 'polygon') this.draft = null;
    this.invalidate();
  }

  private updateHover(p: Pt, tol: number): void {
    const tool = this.store.tool;
    let cursor = 'crosshair';
    let id: string | null = null;
    if (tool === 'select') {
      const sel = this.store.getShape(this.store.selectedId);
      if (sel && hitHandle(sel.geom, p[0], p[1], tol)) cursor = 'pointer';
      else {
        const hit = hitShape(this.store.project.shapes, p[0], p[1], tol * 0.5);
        id = hit ? hit.id : null;
        cursor = hit ? 'move' : 'default';
      }
    } else if (tool === 'delete') {
      const hit = hitShape(this.store.project.shapes, p[0], p[1], tol * 0.5);
      id = hit ? hit.id : null;
      cursor = hit ? 'not-allowed' : 'default';
    }
    this.canvas.style.cursor = cursor;
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.invalidate();
    }
  }

  // ---------- 多角形 ----------

  private addPolygonPoint(p: Pt): void {
    const tol = this.tolWorld();
    if (!this.draft) this.draft = { kind: 'polygon', points: [] };
    const pts = this.draft.points;
    if (pts.length >= 3 && Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) < tol) {
      this.finishPolygon();
      return;
    }
    pts.push(p);
    this.draft.hover = p;
    this.updateBar();
  }

  finishPolygon(): void {
    if (!this.draft || this.draft.kind !== 'polygon') return;
    // ダブルクリックで同じ場所に 2 回打たれた点を除く
    const pts = dedupePoints(this.draft.points, this.view.pxToWorld(4, this.domain));
    if (pts.length < 3 || polygonArea(pts) < MIN_SIZE * MIN_SIZE) {
      toast('多角形には3点以上が必要です。点を増やしてから閉じてください');
      return;
    }
    this.draft = null;
    this.closeNear = false;
    this.store.addShape({ kind: 'polygon', points: pts });
    this.updateBar();
    this.invalidate();
  }

  cancelDraft(): void {
    this.draft = null;
    this.drag = null;
    this.closeNear = false;
    this.canvas.style.cursor = this.store.tool === 'select' ? 'default' : 'crosshair';
    this.updateBar();
    this.invalidate();
  }

  private updateBar(): void {
    const show = this.store.tool === 'polygon' && !!this.draft && this.draft.points.length > 0;
    this.bar.hidden = !show;
    const fin = this.bar.querySelector<HTMLButtonElement>('[data-act="finish"]');
    if (fin && this.draft) fin.disabled = this.draft.points.length < 3;
  }

  // ---------- キーボード ----------

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;

    if (mod && (key === 'z' || key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) this.store.redo();
      else this.store.undo();
      return;
    }
    if (mod && (key === 'y' || key === 'Y')) {
      e.preventDefault();
      this.store.redo();
      return;
    }
    if (mod || e.altKey) return;

    if (key === 'Enter' && this.draft?.kind === 'polygon') {
      e.preventDefault();
      this.finishPolygon();
    } else if (key === 'Escape') {
      if (this.draft) this.cancelDraft();
      else {
        this.store.select(null);
        if (this.store.tool !== 'select') this.store.setTool('select');
      }
    } else if (key === 'Backspace' && this.draft?.kind === 'polygon') {
      e.preventDefault();
      this.draft.points.pop();
      if (this.draft.points.length === 0) this.draft = null;
      this.updateBar();
      this.invalidate();
    } else if ((key === 'Delete' || key === 'Backspace') && this.store.selectedId) {
      e.preventDefault();
      this.store.deleteShape(this.store.selectedId);
    } else if (key.startsWith('Arrow') && this.store.selectedId) {
      const s = this.store.getShape(this.store.selectedId);
      if (!s) return;
      e.preventDefault();
      const step = this.cellStep() * (e.shiftKey ? 5 : 1);
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
      const dy = key === 'ArrowDown' ? -step : key === 'ArrowUp' ? step : 0;
      this.store.checkpoint('nudge', 600);
      s.geom = translateGeom(s.geom, dx, dy);
      this.store.touch('canvas');
    } else {
      const map: Record<string, Tool> = { v: 'select', r: 'rect', c: 'circle', p: 'polygon', f: 'freehand', x: 'delete' };
      const tool = map[key.toLowerCase()];
      if (tool) this.store.setTool(tool);
    }
  }
}
