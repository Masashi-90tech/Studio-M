// プロ用ツール: プローブ（点の値）と断面（線に沿った値）の状態と、場のサンプリング。
// 位置は UI の状態で、プロジェクトファイルには保存しない。
import type { Field } from '../core/types';
import type { Pt } from './geometry';

export const MAX_PROBES = 12;

/** サンプリングに必要な格子の情報（ResultSet の一部） */
export interface GridInfo {
  nx: number;
  ny: number;
  h: number;
}

export interface Probe {
  id: number;
  x: number;
  y: number;
}

const valid = (f: Field, c: number): boolean => (!f.mask || f.mask[c] !== 0) && Number.isFinite(f.data[c]);

/** 点 (x, y) [m] を含むセルの値。範囲外や無効なセルは null */
export function sampleNearest(g: GridInfo, f: Field, x: number, y: number): number | null {
  if (f.data.length !== g.nx * g.ny) return null;
  const i = Math.floor(x / g.h);
  const j = Math.floor(y / g.h);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return null;
  const c = j * g.nx + i;
  return valid(f, c) ? f.data[c] : null;
}

/** セル中心の値を双一次補間する。無効なセルは重みから外し、全部無効なら null */
export function sampleBilinear(g: GridInfo, f: Field, x: number, y: number): number | null {
  if (f.data.length !== g.nx * g.ny) return null;
  if (x < 0 || y < 0 || x > g.nx * g.h || y > g.ny * g.h) return null;
  const u = x / g.h - 0.5;
  const v = y / g.h - 0.5;
  const i0 = Math.floor(u);
  const j0 = Math.floor(v);
  const fx = u - i0;
  const fy = v - j0;
  let sum = 0;
  let wsum = 0;
  for (let dj = 0; dj <= 1; dj++) {
    for (let di = 0; di <= 1; di++) {
      const i = Math.min(g.nx - 1, Math.max(0, i0 + di));
      const j = Math.min(g.ny - 1, Math.max(0, j0 + dj));
      const c = j * g.nx + i;
      if (!valid(f, c)) continue;
      const w = (di === 0 ? 1 - fx : fx) * (dj === 0 ? 1 - fy : fy);
      sum += w * f.data[c];
      wsum += w;
    }
  }
  return wsum > 1e-9 ? sum / wsum : null;
}

export interface ProfilePoint {
  /** 始点からの距離 [m] */
  s: number;
  v: number | null;
}

/** 線分 a→b に沿った場の値。セルの大きさの約半分の間隔で、最大 maxPoints 点 */
export function sectionProfile(g: GridInfo, f: Field, a: Pt, b: Pt, maxPoints = 400): ProfilePoint[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(len > 0)) return [];
  const n = Math.max(2, Math.min(maxPoints, Math.ceil(len / (g.h * 0.5)) + 1));
  const out: ProfilePoint[] = [];
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    out.push({ s: t * len, v: sampleBilinear(g, f, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) });
  }
  return out;
}

type Listener = () => void;

/** プローブと断面線の置き場。変更を購読できる */
export class ProState {
  probes: Probe[] = [];
  section: { a: Pt; b: Pt } | null = null;
  private nextId = 1;
  private listeners = new Set<Listener>();

  on(fn: Listener): void {
    this.listeners.add(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  /** 追加できたら true（上限を超えたら false） */
  addProbe(x: number, y: number): boolean {
    if (this.probes.length >= MAX_PROBES) return false;
    this.probes.push({ id: this.nextId++, x, y });
    this.emit();
    return true;
  }

  moveProbe(id: number, x: number, y: number): void {
    const p = this.probes.find((q) => q.id === id);
    if (!p) return;
    p.x = x;
    p.y = y;
    this.emit();
  }

  removeProbe(id: number): void {
    this.probes = this.probes.filter((p) => p.id !== id);
    this.emit();
  }

  clearProbes(): void {
    this.probes = [];
    this.emit();
  }

  setSection(a: Pt, b: Pt): void {
    this.section = { a, b };
    this.emit();
  }

  clearSection(): void {
    this.section = null;
    this.emit();
  }

  clearAll(): void {
    this.probes = [];
    this.section = null;
    this.emit();
  }
}
