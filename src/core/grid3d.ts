// 3D 解析のボクセル格子を決める。Lite（ブラウザ）と PC のエンジンの両方が同じ関数で格子を決めるので、
// 結果を同じ格子に載せて比べられる（契約は types.ts の Grid3D・ResultSet3D）。
import type { Grid3D, Mesh3D, Study3D } from './types';

/** セル数の上限の既定（ブラウザで数秒〜数十秒で解ける大きさ） */
export const GRID3D_DEFAULT_MAX_CELLS = 300_000;
/** 自動のとき、いちばん長い辺を何セルに分けるか */
export const GRID3D_DEFAULT_LONG_CELLS = 64;
/** 部品のまわりに足す余白 [セル]（面の外側のセルで放熱・条件を扱うため） */
export const GRID3D_MARGIN_CELLS = 1;

export interface Box3D {
  min: [number, number, number];
  max: [number, number, number];
}

/** メッシュの外接箱（使われている頂点だけで決める）。三角形がなければ null */
export function mesh3DBounds(mesh: Mesh3D): Box3D | null {
  const { positions: p, indices: idx } = mesh;
  if (idx.length < 3) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < idx.length; t++) {
    const v = idx[t] * 3;
    for (let a = 0; a < 3; a++) {
      const x = p[v + a];
      if (x < min[a]) min[a] = x;
      if (x > max[a]) max[a] = x;
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/**
 * 外接箱を覆うボクセル格子。まわりに GRID3D_MARGIN_CELLS セルの余白を足す。
 * - cell があればその大きさ（ただしセル数が maxCells を超えるときは、超えないところまで大きくする）
 * - なければ、いちばん長い辺を GRID3D_DEFAULT_LONG_CELLS に分け、maxCells を超えないようにする
 */
export function voxelGrid(opts: { bounds: Box3D; cell?: number; maxCells?: number }): Grid3D {
  const { min, max } = opts.bounds;
  const size = [0, 1, 2].map((a) => Math.max(max[a] - min[a], 0));
  const longest = Math.max(...size);
  if (!(longest > 0) || !Number.isFinite(longest)) throw new Error('形の大きさが 0 です。3D モデルが正しく読み込めているか確かめてください。');
  const maxCells = Math.max(1000, Math.floor(opts.maxCells ?? GRID3D_DEFAULT_MAX_CELLS));
  const m = GRID3D_MARGIN_CELLS;
  // メッシュの座標は float32 なので、0.1 m は 0.10000000149 m になる。セルの一辺でちょうど割り切れる寸法で
  // セルが 1 つ増えないよう、割り算の結果を float32 の精度（相対 1e-6）で丸めてから切り上げる
  const cellsAlong = (s: number, h: number): number => Math.max(1, Math.ceil(s / h - 1e-6 * Math.max(1, s / h)));
  const count = (h: number): number => size.reduce((n, s) => n * (cellsAlong(s, h) + 2 * m), 1);
  let h = opts.cell !== undefined && opts.cell > 0 && Number.isFinite(opts.cell) ? opts.cell : longest / GRID3D_DEFAULT_LONG_CELLS;
  // セル数が上限を超えるあいだ、セルを少しずつ大きくする
  for (let guard = 0; count(h) > maxCells && guard < 200; guard++) h *= 1.05;
  const n = size.map((s) => cellsAlong(s, h) + 2 * m);
  // 形を格子の真ん中に置く
  const origin = [0, 1, 2].map((a) => (min[a] + max[a]) / 2 - (n[a] * h) / 2) as [number, number, number];
  return { nx: n[0], ny: n[1], nz: n[2], h, origin };
}

/** Study3D の格子（Lite もエンジンもこれを使う）。形が空なら日本語のエラー */
export function studyGrid(study: Study3D): Grid3D {
  const bounds = mesh3DBounds(study.mesh);
  if (!bounds) throw new Error('3D モデルに三角形がありません。STL / OBJ を読み込み直してください。');
  return voxelGrid({ bounds, cell: study.grid?.cell, maxCells: study.grid?.maxCells });
}

/** セル (i, j, k) の配列の番号 */
export function cellIndex3D(g: Grid3D, i: number, j: number, k: number): number {
  return (k * g.ny + j) * g.nx + i;
}

/** セル (i, j, k) の中心の座標 [m] */
export function cellCenter3D(g: Grid3D, i: number, j: number, k: number): [number, number, number] {
  return [g.origin[0] + (i + 0.5) * g.h, g.origin[1] + (j + 0.5) * g.h, g.origin[2] + (k + 0.5) * g.h];
}

/**
 * 点 p [m] での場の値。部品の中のセル（mask = 1）だけを使って 3 次元の線形補間をする（表面の色付けに使う）。
 * まわり 8 セルのどれも部品の外なら、近くの部品のセル（最大 2 セル先まで）の値を使い、それもなければ NaN
 */
export function sampleField3D(g: Grid3D, data: Float32Array, mask: Uint8Array, p: readonly [number, number, number]): number {
  const fx = (p[0] - g.origin[0]) / g.h - 0.5;
  const fy = (p[1] - g.origin[1]) / g.h - 0.5;
  const fz = (p[2] - g.origin[2]) / g.h - 0.5;
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fy);
  const k0 = Math.floor(fz);
  let sum = 0;
  let wsum = 0;
  for (let c = 0; c < 8; c++) {
    const i = i0 + (c & 1);
    const j = j0 + ((c >> 1) & 1);
    const k = k0 + ((c >> 2) & 1);
    if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) continue;
    const n = cellIndex3D(g, i, j, k);
    if (mask[n] !== 1 || !Number.isFinite(data[n])) continue;
    const w = (c & 1 ? fx - i0 : 1 - (fx - i0)) * ((c >> 1) & 1 ? fy - j0 : 1 - (fy - j0)) * ((c >> 2) & 1 ? fz - k0 : 1 - (fz - k0));
    sum += w * data[n];
    wsum += w;
  }
  if (wsum > 1e-9) return sum / wsum;
  // 補間に使えるセルがない（面がセルの境目にある）: いちばん近い部品のセル
  const ci = Math.round(fx);
  const cj = Math.round(fy);
  const ck = Math.round(fz);
  let best = NaN;
  let bestD = Infinity;
  for (let dk = -2; dk <= 2; dk++)
    for (let dj = -2; dj <= 2; dj++)
      for (let di = -2; di <= 2; di++) {
        const i = ci + di;
        const j = cj + dj;
        const k = ck + dk;
        if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) continue;
        const n = cellIndex3D(g, i, j, k);
        if (mask[n] !== 1 || !Number.isFinite(data[n])) continue;
        const d = (i - fx) ** 2 + (j - fy) ** 2 + (k - fz) ** 2;
        if (d < bestD) {
          bestD = d;
          best = data[n];
        }
      }
  return best;
}
