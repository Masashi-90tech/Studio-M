// ラスター（Studio M の格子）と OpenFOAM のメッシュのあいだの変換。
//
// blockMesh は 1 ブロックを x が最も速く動く順にセル番号を付けるので、blockMesh 直後のセル番号は
// ラスターの番号 j * nx + i と同じ。subsetMesh で固体セルを抜くと番号が詰まるため、
// 抜いたあとの OpenFOAM のセル → ラスターのセルの対応表（cellMap）を作る。
//
// v1912 の subsetMesh は cellMap ファイルを書かない（-overwrite の有無によらない。確認済み）。
// また Debian の v1912 は functionObject（postProcess -func writeCellCentres など）が使えない。
// そこで、subsetMesh の前に「元のセル番号を値に持つ場 cellId」を 0/ に置いておく。subsetMesh は
// 場も部分メッシュへ移すので、後で読むと OpenFOAM のセルごとの元の番号が分かる（= cellMap と同じ）。
// 読めなかったときの予備は「部分メッシュのセルは元の番号の昇順に並ぶ」こと（fvMeshSubset の挙動）。

import type { Raster } from '../../../src/core/types';

export interface FluidDomain {
  nx: number;
  ny: number;
  h: number;
  /** 固体 = 1（元の物体 + 流れから孤立した飲み込まれ領域） */
  solid: Uint8Array;
  /** 元の物体のセル数 */
  bodyCells: number;
  /** 出入口とつながらないため固体として扱った流体セル数 */
  pocketCells: number;
  /** 流体セル数 */
  fluidCells: number;
  /** 固体セルの番号（topoSet に渡す） */
  solidLabels: number[];
  /** 物体のバウンディングボックス [m]（セル境界） */
  bbox: { x0: number; x1: number; y0: number; y1: number };
  /** 代表長さ L = 物体の高さ [m]（Lite と同じ） */
  length: number;
}

/**
 * ラスターから、OpenFOAM に渡す流体領域を決める。
 * 入口の列から 4 近傍でつながる流体セルだけを残し、それ以外（物体に囲まれた空洞など）は固体にする。
 * 空洞を残すと、圧力の基準がない領域ができて計算が壊れるため。
 */
export function prepareDomain(raster: Pick<Raster, 'nx' | 'ny' | 'h' | 'solid'>): FluidDomain {
  const { nx, ny, h } = raster;
  const n = nx * ny;
  let bodyCells = 0;
  let iMin = nx, iMax = -1, jMin = ny, jMax = -1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!raster.solid[j * nx + i]) continue;
      bodyCells++;
      if (i < iMin) iMin = i;
      if (i > iMax) iMax = i;
      if (j < jMin) jMin = j;
      if (j > jMax) jMax = j;
    }
  }
  if (bodyCells === 0) {
    throw new Error('物体（solid）が 1 つもありません。OpenFOAM の計算では物体まわりの力を求めるため、物体を置いてください。');
  }

  // 入口（左の列）から広がる流体セルを探す
  const reach = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let j = 0; j < ny; j++) {
    const c = j * nx;
    if (!raster.solid[c]) {
      reach[c] = 1;
      queue[tail++] = c;
    }
  }
  if (tail === 0) throw new Error('入口（左端）がすべて物体でふさがっています。物体を左端から離してください。');
  while (head < tail) {
    const c = queue[head++];
    const i = c % nx;
    const j = (c - i) / nx;
    const visit = (k: number): void => {
      if (!raster.solid[k] && !reach[k]) {
        reach[k] = 1;
        queue[tail++] = k;
      }
    };
    if (i > 0) visit(c - 1);
    if (i < nx - 1) visit(c + 1);
    if (j > 0) visit(c - nx);
    if (j < ny - 1) visit(c + nx);
  }
  let outletOpen = false;
  for (let j = 0; j < ny; j++) if (reach[j * nx + nx - 1]) outletOpen = true;
  if (!outletOpen) {
    throw new Error('入口から出口まで流れが通る隙間がありません（物体が領域をふさいでいます）。物体を小さくするか、隙間をあけてください。');
  }

  const solid = new Uint8Array(n);
  const solidLabels: number[] = [];
  let pocketCells = 0;
  for (let c = 0; c < n; c++) {
    if (reach[c]) continue;
    solid[c] = 1;
    solidLabels.push(c);
    if (!raster.solid[c]) pocketCells++;
  }
  return {
    nx,
    ny,
    h,
    solid,
    bodyCells,
    pocketCells,
    fluidCells: n - solidLabels.length,
    solidLabels,
    bbox: { x0: iMin * h, x1: (iMax + 1) * h, y0: jMin * h, y1: (jMax + 1) * h },
    length: (jMax - jMin + 1) * h,
  };
}

/**
 * 部分メッシュの「セル番号の場」（subsetMesh が元の番号を運んでくれたもの）から、
 * OpenFOAM のセル → ラスターのセル番号を求める。
 * 範囲外・固体セル・重複があれば、メッシュが想定と違うので例外にする。
 */
export function mapCellsFromIds(ids: ArrayLike<number>, domain: Pick<FluidDomain, 'nx' | 'ny' | 'solid'>): Int32Array {
  const total = domain.nx * domain.ny;
  const out = new Int32Array(ids.length);
  const seen = new Uint8Array(total);
  for (let c = 0; c < ids.length; c++) {
    const r = Math.round(ids[c]);
    if (Math.abs(ids[c] - r) > 1e-3 || r < 0 || r >= total) throw new Error(`セル ${c} の元の番号 ${ids[c]} が範囲外です`);
    if (domain.solid[r]) throw new Error(`セル ${c} が固体セルに対応しています（subsetMesh が想定どおりに動いていません）`);
    if (seen[r]) throw new Error(`ラスターのセル ${r} に OpenFOAM のセルが 2 つ対応しています`);
    seen[r] = 1;
    out[c] = r;
  }
  return out;
}

/** 部分メッシュのセルが元の番号の昇順に並ぶとみなした対応（セル中心が使えないときの予備） */
export function mapCellsSorted(domain: Pick<FluidDomain, 'nx' | 'ny' | 'solid'>): Int32Array {
  const total = domain.nx * domain.ny;
  const out: number[] = [];
  for (let c = 0; c < total; c++) if (!domain.solid[c]) out.push(c);
  return Int32Array.from(out);
}

/**
 * 渦が出やすいよう、物体の後ろに小さな縦方向の速度の山を置いた初期速度。
 * 一様流 (uInf, 0) に、ガウス分布の uy を足す（大きさは uInf の amp 倍）。
 */
export function initialVelocity(
  cx: ArrayLike<number>,
  cy: ArrayLike<number>,
  opts: { uInf: number; bbox: FluidDomain['bbox']; length: number; amp?: number },
): { ux: Float64Array; uy: Float64Array } {
  const n = cx.length;
  const { uInf, bbox, length } = opts;
  const amp = opts.amp ?? 0.15;
  const bx = bbox.x1 + 0.4 * length;
  const by = 0.5 * (bbox.y0 + bbox.y1) + 0.2 * length;
  const sigma = 0.4 * length;
  const ux = new Float64Array(n).fill(uInf);
  const uy = new Float64Array(n);
  if (amp > 0) {
    for (let c = 0; c < n; c++) {
      const dx = cx[c] - bx;
      const dy = cy[c] - by;
      uy[c] = amp * uInf * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    }
  }
  return { ux, uy };
}
