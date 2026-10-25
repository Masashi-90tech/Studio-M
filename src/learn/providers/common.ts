// 式の提供者が共通で使う部品: プロジェクトから寸法・材料・結果の数字を取り出す。DOM に触れない。
import { getMaterial } from '../../core/materials';
import type { Material, Project, ResultSet, Shape, ShapeGeom } from '../../core/types';
import type { MathVar } from '../types';

// ---------- 変数の作成 ----------

export interface VarSpec {
  key: string;
  symbol: string;
  label: string;
  unit: string;
  value: number;
  /** 動かせる範囲。省略時は value の 1/4〜4 倍（0 や負なら value ± 幅） */
  min?: number;
  max?: number;
  log?: boolean;
  step?: number;
  display?: (v: number) => string;
  fixed?: boolean;
  source?: string;
}

/** 変数を作る。範囲が未指定、または value が範囲の外なら自動で広げる */
export function mathVar(spec: VarSpec): MathVar {
  const v = Number.isFinite(spec.value) ? spec.value : 0;
  let min = spec.min;
  let max = spec.max;
  if (min === undefined || max === undefined) {
    if (v > 0) {
      min = min ?? v / 4;
      max = max ?? v * 4;
    } else {
      min = min ?? v - 1;
      max = max ?? v + 1;
    }
  }
  min = Math.min(min, v);
  max = Math.max(max, v);
  // 範囲を自動で決めたときは対数目盛り（2 倍・半分が等間隔になり、倍率の感覚をつかみやすい）
  const auto = spec.min === undefined && spec.max === undefined;
  const log = (spec.log ?? (auto && v > 0)) && min > 0 ? true : undefined;
  return { ...spec, value: v, min, max, log };
}

// ---------- プロジェクトから取り出す ----------

export const isBody = (s: Shape): boolean => s.role === 'solid' || s.role === 'heatSource';

export function bodies(project: Project): Shape[] {
  return project.shapes.filter(isBody);
}

export function byRole(project: Project, role: Shape['role']): Shape[] {
  return project.shapes.filter((s) => s.role === role);
}

/** 材料。未知の ID なら fallbackId（なければ PLA） */
export function safeMaterial(id: string | undefined, fallbackId = 'pla'): Material {
  try {
    if (id) return getMaterial(id);
  } catch {
    /* 下で代わりを返す */
  }
  return getMaterial(fallbackId);
}

/** 最初の物体の材料。物体がなければ fallbackId */
export function primaryMaterial(project: Project, fallbackId = 'pla'): Material {
  const first = bodies(project)[0];
  return safeMaterial(first?.materialId, fallbackId);
}

export function scalarOf(result: ResultSet | null, key: string): number | undefined {
  const s = result?.scalars.find((x) => x.key === key);
  return s && Number.isFinite(s.value) ? s.value : undefined;
}

// ---------- 形 ----------

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function boxOf(g: ShapeGeom): Box {
  switch (g.kind) {
    case 'rect':
      return { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h };
    case 'circle':
      return { x0: g.cx - g.r, y0: g.cy - g.r, x1: g.cx + g.r, y1: g.cy + g.r };
    case 'polygon': {
      const b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const [x, y] of g.points) {
        b.x0 = Math.min(b.x0, x);
        b.y0 = Math.min(b.y0, y);
        b.x1 = Math.max(b.x1, x);
        b.y1 = Math.max(b.y1, y);
      }
      return b;
    }
  }
}

/** 物体全体を囲む箱。物体がなければ null */
export function bodiesBox(project: Project): Box | null {
  const list = bodies(project);
  if (list.length === 0) return null;
  const out: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const s of list) {
    const b = boxOf(s.geom);
    out.x0 = Math.min(out.x0, b.x0);
    out.y0 = Math.min(out.y0, b.y0);
    out.x1 = Math.max(out.x1, b.x1);
    out.y1 = Math.max(out.y1, b.y1);
  }
  return out.x1 > out.x0 && out.y1 > out.y0 ? out : null;
}

export const centerOf = (b: Box): { x: number; y: number } => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });

// ---------- 断面（線と形の交わり） ----------

export type Span = [number, number];

/** 縦の線 x = c が形と交わる y の区間 */
function spansOfGeom(g: ShapeGeom, c: number): Span[] {
  switch (g.kind) {
    case 'rect':
      return c >= g.x && c <= g.x + g.w ? [[g.y, g.y + g.h]] : [];
    case 'circle': {
      const d = Math.abs(c - g.cx);
      if (d > g.r) return [];
      const half = Math.sqrt(g.r * g.r - d * d);
      return [[g.cy - half, g.cy + half]];
    }
    case 'polygon': {
      const ys: number[] = [];
      const p = g.points;
      for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
        const [xa, ya] = p[a];
        const [xb, yb] = p[b];
        if (xa > c !== xb > c) ys.push(ya + ((c - xa) * (yb - ya)) / (xb - xa));
      }
      ys.sort((m, n) => m - n);
      const out: Span[] = [];
      for (let k = 0; k + 1 < ys.length; k += 2) out.push([ys[k], ys[k + 1]]);
      return out;
    }
  }
}

function transpose(g: ShapeGeom): ShapeGeom {
  switch (g.kind) {
    case 'rect':
      return { kind: 'rect', x: g.y, y: g.x, w: g.h, h: g.w };
    case 'circle':
      return { kind: 'circle', cx: g.cy, cy: g.cx, r: g.r };
    case 'polygon':
      return { kind: 'polygon', points: g.points.map(([x, y]): [number, number] => [y, x]) };
  }
}

function mergeSpans(list: Span[]): Span[] {
  const s = list.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const [lo, hi] of s) {
    const last = out[out.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

function subtractSpans(from: Span[], cut: Span[]): Span[] {
  let cur = from;
  for (const [clo, chi] of cut) {
    const next: Span[] = [];
    for (const [lo, hi] of cur) {
      if (chi <= lo || clo >= hi) next.push([lo, hi]);
      else {
        if (clo > lo) next.push([lo, clo]);
        if (chi < hi) next.push([chi, hi]);
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * 物体の断面: 線を引いたとき、物体（穴を除く）がある区間。
 * axis = 'x' なら縦の線 x = at（区間は y）、'y' なら横の線 y = at（区間は x）。
 * 形は shapes の順に重ね、後の穴は削る（格子化と同じ規則）。
 */
export function sectionSpans(project: Project, axis: 'x' | 'y', at: number): Span[] {
  let cur: Span[] = [];
  for (const s of project.shapes) {
    if (!isBody(s) && s.role !== 'hole') continue;
    const g = axis === 'x' ? s.geom : transpose(s.geom);
    const spans = spansOfGeom(g, at);
    cur = s.role === 'hole' ? subtractSpans(cur, spans) : mergeSpans([...cur, ...spans]);
  }
  return cur;
}

/** 断面の物体の合計の長さ [m] */
export function sectionLength(project: Project, axis: 'x' | 'y', at: number): number {
  return sectionSpans(project, axis, at).reduce((a, [lo, hi]) => a + (hi - lo), 0);
}
