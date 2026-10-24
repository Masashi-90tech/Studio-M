// キャンバス描画の本体。場のヒートマップ → グリッド → 流線 → 図形 → 変形輪郭 → 選択 → 凡例の順に重ねる。
import { getMaterial } from '../core/materials';
import type { AnalysisKind, Field, Project, Raster, ResultSet, Shape } from '../core/types';
import { fieldRange, type ColormapName, type Range } from './colormap';
import {
  drawDeformed,
  drawDraft,
  drawGrid,
  drawHandles,
  drawLegend,
  drawScaleBar,
  drawShape,
  exaggerationFactor,
  getLUT,
  maxDisplacement,
  type Draft,
  type DispField,
  type Paint,
} from './overlay';
import { ParticleLayer } from './particles';
import type { ViewOptions } from './state';

export interface RenderInput {
  project: Project;
  raster: Raster | null;
  result: ResultSet | null;
  field: Field | null;
  analysis: AnalysisKind;
  opts: ViewOptions;
  selectedId: string | null;
  hoverId: string | null;
  draft: Draft | null;
  draftCloseNear: boolean;
  touch: boolean;
  /** 計算が進行中か（流線を動かすかどうか） */
  running: boolean;
  /** ソルバーを作り直すたびに増える数（流線の軌跡を消す合図） */
  generation: number;
}

const BG = '#f3f1ec';
const VOID_RGB: [number, number, number] = [233, 230, 223];
const MAX_BACKING = 2600;

function hexRGB(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** 速度・変位の組（キー ux, uy）を結果から取り出す。無ければ null */
export function hasVectorFields(r: ResultSet | null): boolean {
  return !!r && r.fields.some((f) => f.key === 'ux') && r.fields.some((f) => f.key === 'uy');
}

const maskCache = new WeakMap<Raster, Uint8Array>();

/** 流体セル = 1 のマスク（物体セルでは速度を使わない） */
function fluidMask(raster: Raster): Uint8Array {
  let m = maskCache.get(raster);
  if (!m) {
    m = new Uint8Array(raster.solid.length);
    for (let c = 0; c < m.length; c++) m[c] = raster.solid[c] ? 0 : 1;
    maskCache.set(raster, m);
  }
  return m;
}

/** analysis が flow なら流体セル、stress なら物体セルを有効とみなす（場にマスクがないとき） */
function vectorFields(r: ResultSet | null, raster: Raster | null, analysis: AnalysisKind): DispField | null {
  if (!r) return null;
  const fx = r.fields.find((f) => f.key === 'ux');
  const fy = r.fields.find((f) => f.key === 'uy');
  if (!fx || !fy) return null;
  let mask = fx.mask ?? fy.mask;
  if (!mask && raster && raster.nx === r.nx && raster.ny === r.ny) mask = analysis === 'flow' ? fluidMask(raster) : raster.solid;
  return { ux: fx.data, uy: fy.data, mask, nx: r.nx, ny: r.ny, h: r.h };
}

export class CanvasView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private wrap: HTMLElement;
  private dpr = 1;
  private fieldCanvas = document.createElement('canvas');
  private fieldCtx = this.fieldCanvas.getContext('2d')!;
  private image: ImageData | null = null;
  private particles = new ParticleLayer();
  private matRGB = new Map<string, [number, number, number]>();
  private layoutDirty = true;
  private layoutKey = '';
  private lastGen = -1;
  /** 図形の上に重ねて描く追加の部品（プローブ・断面線・電波の波源など） */
  overlays: ((p: Paint) => void)[] = [];
  /** 再描画が必要か */
  invalid = true;
  lastRange: Range | null = null;

  constructor(canvas: HTMLCanvasElement, wrap: HTMLElement) {
    this.canvas = canvas;
    this.wrap = wrap;
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => {
      this.layoutDirty = true;
      this.invalid = true;
    }).observe(wrap);
    window.addEventListener('resize', () => {
      this.layoutDirty = true;
      this.invalid = true;
    });
  }

  // ---------- 配置 ----------

  /** 領域のアスペクト比を保ったまま、コンテナに収まる大きさにする */
  private fit(domainW: number, domainH: number): void {
    const aspect = domainW / domainH;
    const compact = window.matchMedia('(max-width: 860px)').matches;
    const availW = Math.max(120, this.wrap.clientWidth);
    const availH = compact ? Math.max(160, window.innerHeight * 0.5) : Math.max(120, this.wrap.clientHeight);
    let cssW = Math.min(availW, availH * aspect);
    let cssH = cssW / aspect;
    if (cssH > availH) {
      cssH = availH;
      cssW = cssH * aspect;
    }
    if (compact) this.wrap.style.height = `${Math.ceil(cssH)}px`;
    else this.wrap.style.height = '';
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    let bw = Math.round(cssW * this.dpr);
    if (bw > MAX_BACKING) {
      this.dpr = (this.dpr * MAX_BACKING) / bw;
      bw = MAX_BACKING;
    }
    const bh = Math.round(bw / aspect);
    const s = this.canvas.style;
    s.width = `${cssW}px`;
    s.height = `${cssH}px`;
    s.left = `${(availW - cssW) / 2}px`;
    s.top = `${((compact ? cssH : availH) - cssH) / 2}px`;
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.particles.resize(bw, bh);
    this.layoutDirty = false;
  }

  /** 画面座標 → ワールド座標 [m] */
  toWorld(clientX: number, clientY: number, domain: { width: number; height: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((clientX - r.left) / r.width) * domain.width, (1 - (clientY - r.top) / r.height) * domain.height];
  }

  /** CSS ピクセルの長さ → ワールドの長さ [m] */
  pxToWorld(cssPx: number, domain: { width: number }): number {
    const r = this.canvas.getBoundingClientRect();
    return (cssPx / Math.max(1, r.width)) * domain.width;
  }

  // ---------- 描画 ----------

  render(inp: RenderInput): void {
    const dom = inp.project.domain;
    const domainH = dom.height;
    const key = `${dom.width}x${domainH}`;
    if (this.layoutDirty || key !== this.layoutKey) {
      this.layoutKey = key;
      this.fit(dom.width, domainH);
    }
    if (inp.generation !== this.lastGen) {
      this.lastGen = inp.generation;
      this.particles.clear();
    }
    this.invalid = false;

    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    const paint: Paint = { ctx, sc: W / dom.width, H, dpr: this.dpr };

    const field = inp.field;
    const showField = !!field && !!inp.result && field.data.length === inp.result.nx * inp.result.ny;
    let cmap: ColormapName = inp.opts.colormap;
    if (showField && field) {
      if (field.diverging) cmap = 'diverging';
      else if (cmap === 'diverging') cmap = 'turbo';
      this.drawField(inp, field, cmap);
    } else {
      this.lastRange = null;
    }

    if (inp.opts.grid) drawGrid(paint, dom.width, domainH);

    // 流線
    if (inp.analysis === 'flow' && inp.opts.particles && inp.result) {
      const v = vectorFields(inp.result, inp.raster, 'flow');
      if (v) {
        this.particles.update(v, W, H, inp.running);
        this.particles.draw(ctx);
      }
    }

    // 図形
    for (const s of inp.project.shapes) {
      let material;
      if (!showField && (s.role === 'solid' || s.role === 'heatSource')) {
        try {
          material = getMaterial(s.materialId);
        } catch {
          material = undefined;
        }
      }
      drawShape(paint, s, { fillBody: !showField, material, selected: s.id === inp.selectedId, hover: s.id === inp.hoverId });
    }

    // 変形輪郭
    if (inp.analysis === 'stress' && inp.opts.deform) {
      const d = vectorFields(inp.result, inp.raster, 'stress');
      if (d) {
        const m = maxDisplacement(d);
        if (m > 0) drawDeformed(paint, inp.project.shapes, d, exaggerationFactor(m, Math.min(dom.width, domainH)));
      }
    }

    // 選択ハンドル・作図中
    const sel: Shape | undefined = inp.selectedId ? inp.project.shapes.find((s) => s.id === inp.selectedId) : undefined;
    if (sel) drawHandles(paint, sel.geom, inp.touch);
    if (inp.draft) drawDraft(paint, inp.draft, inp.draftCloseNear);

    for (const draw of this.overlays) draw(paint);

    if (showField && field && this.lastRange) drawLegend(paint, field, this.lastRange, cmap);
    drawScaleBar(paint);
  }

  private colorOf(materialId: string | null): [number, number, number] {
    if (!materialId) return VOID_RGB;
    let c = this.matRGB.get(materialId);
    if (!c) {
      try {
        c = hexRGB(getMaterial(materialId).color);
      } catch {
        c = [184, 194, 204];
      }
      this.matRGB.set(materialId, c);
    }
    return c;
  }

  private drawField(inp: RenderInput, field: Field, cmap: ColormapName): void {
    const r = inp.result!;
    const { nx, ny } = r;
    if (!this.image || this.image.width !== nx || this.image.height !== ny) {
      this.fieldCanvas.width = nx;
      this.fieldCanvas.height = ny;
      this.image = this.fieldCtx.createImageData(nx, ny);
    }
    const range = fieldRange(field.data, field.mask, !!field.diverging);
    this.lastRange = range;
    const lut = getLUT(cmap);
    const span = range.max - range.min;
    const px = this.image.data;
    const mask = field.mask;
    const raster = inp.raster && inp.raster.nx === nx && inp.raster.ny === ny ? inp.raster : null;
    const data = field.data;
    for (let j = 0; j < ny; j++) {
      const row = (ny - 1 - j) * nx;
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const o = (row + i) * 4;
        const v = data[c];
        if ((mask && mask[c] === 0) || !Number.isFinite(v)) {
          // 場の値がないセル: 物体なら材料の色、そうでなければ空白
          const rgb = raster && raster.solid[c] ? this.colorOf(raster.materialId[c]) : VOID_RGB;
          px[o] = rgb[0];
          px[o + 1] = rgb[1];
          px[o + 2] = rgb[2];
        } else {
          let t = (v - range.min) / span;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const k = ((t * 255 + 0.5) | 0) * 4;
          px[o] = lut[k];
          px[o + 1] = lut[k + 1];
          px[o + 2] = lut[k + 2];
        }
        px[o + 3] = 255;
      }
    }
    this.fieldCtx.putImageData(this.image, 0, 0);
    this.ctx.imageSmoothingEnabled = inp.opts.smooth;
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(this.fieldCanvas, 0, 0, nx, ny, 0, 0, this.canvas.width, this.canvas.height);
  }
}

/** カーソル位置 (x, y) [m] にある場の値（なければ null） */
export function probeField(r: ResultSet | null, f: Field | null, x: number, y: number): number | null {
  if (!r || !f || f.data.length !== r.nx * r.ny) return null;
  const i = Math.floor(x / r.h);
  const j = Math.floor(y / r.h);
  if (i < 0 || j < 0 || i >= r.nx || j >= r.ny) return null;
  const c = j * r.nx + i;
  if (f.mask && f.mask[c] === 0) return null;
  const v = f.data[c];
  return Number.isFinite(v) ? v : null;
}
