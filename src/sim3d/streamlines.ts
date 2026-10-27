// 流線（速度場を追って描く線）。DOM に依存しない純粋な関数だけを置く。
// - sampleVelocity:   ボクセル格子の速度を 3 次元の線形補間で読む（流体のセルだけを使う）
// - traceStreamline:  種の点から、2 次のルンゲ–クッタ（中点法）で速度場を追う
// - flowSeeds:        上流の面に並べる種の点（部品のまわりに寄せる）
// - streamlineSegments: 線分の並び（GL_LINES 用）に直し、速さで色を付ける
import { cellIndex3D, flowAxis, type Box3D } from '../core/grid3d';
import type { FlowDirection3D, Grid3D, ResultSet3D } from '../core/types';
import { buildLUT, lutIndex, type ColormapName, type Range } from '../ui/colormap';

export interface VelocityField {
  grid: Grid3D;
  ux: Float32Array;
  uy: Float32Array;
  uz: Float32Array;
  /** 1 = 流体のセル */
  mask: Uint8Array;
}

/** 結果から速度の 3 成分（ux・uy・uz）を取り出す。なければ null */
export function velocityFieldOf(result: ResultSet3D): VelocityField | null {
  const ux = result.fields.find((f) => f.key === 'ux');
  const uy = result.fields.find((f) => f.key === 'uy');
  const uz = result.fields.find((f) => f.key === 'uz');
  if (!ux || !uy || !uz) return null;
  return { grid: result.grid, ux: ux.data, uy: uy.data, uz: uz.data, mask: ux.mask };
}

/**
 * 点 p [m] の速度を out に書き込み、読めたら true。
 * 点が格子の外・固体のセルの中なら false。まわりの 8 セルのうち流体のセルだけで補間する（壁のそばでも壁の中の値を混ぜない）
 */
export function sampleVelocity(vf: VelocityField, p: readonly [number, number, number], out: [number, number, number]): boolean {
  const g = vf.grid;
  const fx = (p[0] - g.origin[0]) / g.h;
  const fy = (p[1] - g.origin[1]) / g.h;
  const fz = (p[2] - g.origin[2]) / g.h;
  if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx < g.nx && fy < g.ny && fz < g.nz)) return false;
  // 点のいるセルが固体なら、そこで線は終わり
  if (vf.mask[cellIndex3D(g, Math.floor(fx), Math.floor(fy), Math.floor(fz))] !== 1) return false;
  const cx = fx - 0.5;
  const cy = fy - 0.5;
  const cz = fz - 0.5;
  const i0 = Math.floor(cx);
  const j0 = Math.floor(cy);
  const k0 = Math.floor(cz);
  const tx = cx - i0;
  const ty = cy - j0;
  const tz = cz - k0;
  let wsum = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let c = 0; c < 8; c++) {
    const i = i0 + (c & 1);
    const j = j0 + ((c >> 1) & 1);
    const k = k0 + ((c >> 2) & 1);
    if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) continue;
    const n = cellIndex3D(g, i, j, k);
    if (vf.mask[n] !== 1) continue;
    const w = (c & 1 ? tx : 1 - tx) * ((c >> 1) & 1 ? ty : 1 - ty) * ((c >> 2) & 1 ? tz : 1 - tz);
    const a = vf.ux[n];
    const b = vf.uy[n];
    const d = vf.uz[n];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(d)) continue;
    sx += w * a;
    sy += w * b;
    sz += w * d;
    wsum += w;
  }
  if (!(wsum > 1e-9)) return false;
  out[0] = sx / wsum;
  out[1] = sy / wsum;
  out[2] = sz / wsum;
  return true;
}

export interface Streamline {
  /** x, y, z の並び [m] */
  points: Float32Array;
  /** 各点での速さ [m/s] */
  speeds: Float32Array;
}

export interface TraceOptions {
  /** 1 歩の長さ [m]（省略時 セルの 0.5 倍） */
  stepLength?: number;
  /** 線の長さの上限 [m]（省略時 格子の対角線の 2 倍） */
  maxLength?: number;
  /** この速さ [m/s] より遅くなったら止める（よどみ点。省略時 1e-9） */
  minSpeed?: number;
}

/**
 * 種の点 seed から、速度場に沿って線を追う（2 次のルンゲ–クッタ。1 歩の長さを一定にして、点の間隔をそろえる）。
 * 格子の外・固体のセル・よどみ点に着いたら止まる。種の点が流体の中でなければ点は 0 個
 */
export function traceStreamline(vf: VelocityField, seed: readonly [number, number, number], opts: TraceOptions = {}): Streamline {
  const g = vf.grid;
  const step = opts.stepLength ?? g.h * 0.5;
  const maxLength = opts.maxLength ?? 2 * Math.hypot(g.nx, g.ny, g.nz) * g.h;
  const minSpeed = opts.minSpeed ?? 1e-9;
  const maxSteps = Math.max(1, Math.min(20_000, Math.ceil(maxLength / step)));
  const pts: number[] = [];
  const spd: number[] = [];
  const u: [number, number, number] = [0, 0, 0];
  const um: [number, number, number] = [0, 0, 0];
  const p: [number, number, number] = [seed[0], seed[1], seed[2]];
  const mid: [number, number, number] = [0, 0, 0];
  for (let s = 0; s <= maxSteps; s++) {
    if (!sampleVelocity(vf, p, u)) break;
    const sp = Math.hypot(u[0], u[1], u[2]);
    pts.push(p[0], p[1], p[2]);
    spd.push(sp);
    if (!(sp > minSpeed)) break;
    // 中点法: 半歩進んだ点の速度の向きで 1 歩進む
    const half = (0.5 * step) / sp;
    mid[0] = p[0] + u[0] * half;
    mid[1] = p[1] + u[1] * half;
    mid[2] = p[2] + u[2] * half;
    if (!sampleVelocity(vf, mid, um)) break;
    const sm = Math.hypot(um[0], um[1], um[2]);
    if (!(sm > minSpeed)) break;
    p[0] += (um[0] / sm) * step;
    p[1] += (um[1] / sm) * step;
    p[2] += (um[2] / sm) * step;
  }
  return { points: Float32Array.from(pts), speeds: Float32Array.from(spd) };
}

export interface SeedOptions {
  grid: Grid3D;
  /** 部品の外接箱 */
  part: Box3D;
  direction: FlowDirection3D;
  /** 並べる数（既定 12 × 12）。[流れに垂直な 2 方向（軸の番号順）] */
  count?: [number, number];
  /** 流入の面から何セル中に入れるか（既定 3） */
  inset?: number;
  /** 部品の半分の幅に対する、並べる範囲の倍率（既定 1.5） */
  spread?: number;
  /** 部品の中心に寄せる強さ（1 で等間隔。既定 1.3） */
  focus?: number;
}

/**
 * 上流の面に並べる種の点。流れに垂直な 2 方向に n × m 個を、部品の中心のまわりに寄せて並べる
 * （部品に当たる流れと、すぐ脇を通る流れを多めに見せる）。点は格子の内側に収める
 */
export function flowSeeds(opts: SeedOptions): [number, number, number][] {
  const { grid: g, part } = opts;
  const { axis, sign } = flowAxis(opts.direction);
  const [nu, nv] = opts.count ?? [12, 12];
  const inset = opts.inset ?? 3;
  const spread = opts.spread ?? 1.5;
  const focus = opts.focus ?? 1.3;
  const n = [g.nx, g.ny, g.nz];
  const cross = [0, 1, 2].filter((a) => a !== axis) as [number, number, number];
  const d = Math.max(...cross.map((a) => part.max[a] - part.min[a]), 1e-9);
  const along = sign > 0 ? g.origin[axis] + inset * g.h : g.origin[axis] + (n[axis] - inset) * g.h;
  const coords = (a: number, count: number): number[] => {
    const c = (part.min[a] + part.max[a]) / 2;
    const half = Math.max(((part.max[a] - part.min[a]) / 2) * spread, 0.3 * d);
    const lo = g.origin[a] + 2 * g.h;
    const hi = g.origin[a] + n[a] * g.h - 2 * g.h;
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const t = -1 + (2 * (i + 0.5)) / count;
      const s = Math.sign(t) * Math.abs(t) ** focus;
      out.push(Math.min(hi, Math.max(lo, c + half * s)));
    }
    return out;
  };
  const us = coords(cross[0], nu);
  const vs = coords(cross[1], nv);
  const seeds: [number, number, number][] = [];
  for (const v of vs)
    for (const u of us) {
      const p: [number, number, number] = [0, 0, 0];
      p[axis] = along;
      p[cross[0]] = u;
      p[cross[1]] = v;
      seeds.push(p);
    }
  return seeds;
}

/** 種の点ごとに流線を追う。点が 2 つ未満の線（すぐ止まったもの）は捨てる */
export function buildStreamlines(vf: VelocityField, seeds: readonly [number, number, number][], opts: TraceOptions = {}): Streamline[] {
  const out: Streamline[] = [];
  for (const s of seeds) {
    const line = traceStreamline(vf, s, opts);
    if (line.speeds.length >= 2) out.push(line);
  }
  return out;
}

/** 流線の速さの範囲（最小・最大）。線がなければ { min: 0, max: 1 } */
export function streamlineSpeedRange(lines: readonly Streamline[]): Range {
  let min = Infinity;
  let max = -Infinity;
  for (const l of lines) {
    for (let i = 0; i < l.speeds.length; i++) {
      const v = l.speeds[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!(min <= max)) return { min: 0, max: 1 };
  if (max - min < 1e-12) {
    const pad = Math.abs(min) * 0.01 || 1;
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
}

/** 線分の並び（隣り合う 2 点ごとに 1 本。GL_LINES 用）と、頂点ごとの色（速さをカラーマップに通したもの） */
export function streamlineSegments(lines: readonly Streamline[], range: Range, colormap: ColormapName = 'turbo'): { positions: Float32Array; colors: Float32Array; count: number } {
  const lut = buildLUT(colormap);
  let segs = 0;
  for (const l of lines) segs += Math.max(0, l.speeds.length - 1);
  const positions = new Float32Array(segs * 6);
  const colors = new Float32Array(segs * 6);
  let o = 0;
  const put = (l: Streamline, i: number): void => {
    positions[o] = l.points[i * 3];
    positions[o + 1] = l.points[i * 3 + 1];
    positions[o + 2] = l.points[i * 3 + 2];
    const c = lutIndex(l.speeds[i], range) * 4;
    colors[o] = lut[c] / 255;
    colors[o + 1] = lut[c + 1] / 255;
    colors[o + 2] = lut[c + 2] / 255;
    o += 3;
  };
  for (const l of lines) {
    for (let i = 0; i + 1 < l.speeds.length; i++) {
      put(l, i);
      put(l, i + 1);
    }
  }
  return { positions, colors, count: segs };
}
