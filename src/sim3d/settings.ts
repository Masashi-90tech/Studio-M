// 3D 解析の設定の選択肢（まわりの冷え方・計算の細かさ）と、格子の大きさの目安（DOM に依存しない）。
import { voxelGrid, type Box3D } from '../core/grid3d';
import type { Grid3D, Study3D } from '../core/types';

export interface CoolingOption {
  id: string;
  label: string;
  /** 熱伝達率 h [W/(m²·K)]。custom は数値を自分で指定する */
  h?: number;
}

/** まわりの冷え方。h は条件を置いていない面の熱伝達率 */
export const COOLING_OPTIONS: readonly CoolingOption[] = [
  { id: 'natural', label: '自然放置（h = 8）', h: 8 },
  { id: 'breeze', label: '弱い風（h = 20）', h: 20 },
  { id: 'fan', label: 'ファン（h = 40）', h: 40 },
  { id: 'strongfan', label: '強いファン（h = 80）', h: 80 },
  { id: 'custom', label: '数値で指定' },
];

/** h に合う選択肢の ID（どれにも合わなければ custom） */
export function coolingIdFor(h: number): string {
  return COOLING_OPTIONS.find((o) => o.h !== undefined && Math.abs(o.h - h) < 1e-9)?.id ?? 'custom';
}

export type QualityId = 'coarse' | 'normal' | 'fine';

export interface QualityOption {
  id: QualityId;
  label: string;
  /** Study3D.grid.maxCells（セル数の上限） */
  maxCells: number;
  /** いちばん長い辺を何セルに分けるか。省略時は格子の決め方（grid3d.ts）の既定（標準） */
  longCells?: number;
  hint: string;
}

export const QUALITY_OPTIONS: readonly QualityOption[] = [
  { id: 'coarse', label: '粗い', maxCells: 50_000, longCells: 32, hint: '長い辺を 32 分割。数秒で、形の当たりをつける' },
  { id: 'normal', label: '標準', maxCells: 300_000, hint: '長い辺を 64 分割。ふだんはこれ' },
  { id: 'fine', label: '細かい', maxCells: 1_000_000, longCells: 128, hint: '長い辺を 128 分割（セルは 100 万個まで）。時間がかかります。細い部分や小さな穴があるとき' },
];

/** maxCells に近い細かさの選択肢（どれにも当てはまらない値は標準に近い方へ） */
export function qualityIdFor(maxCells: number | undefined): QualityId {
  if (maxCells === undefined) return 'normal';
  let best = QUALITY_OPTIONS[1];
  for (const q of QUALITY_OPTIONS) if (Math.abs(Math.log(q.maxCells / maxCells)) < Math.abs(Math.log(best.maxCells / maxCells))) best = q;
  return best.id;
}

export function qualityOf(id: QualityId): QualityOption {
  return QUALITY_OPTIONS.find((q) => q.id === id) ?? QUALITY_OPTIONS[1];
}

/**
 * 細かさの選択を Study3D.grid にする。粗い・細かいは、いちばん長い辺を分ける数（cell）も決める
 * （セル数の上限 maxCells だけでは、既定の 64 分割より細かくならないため）。標準は cell を決めず、格子の決め方の既定に任せる
 */
export function qualityGrid(id: QualityId, bounds: Box3D | null): NonNullable<Study3D['grid']> {
  const q = qualityOf(id);
  if (!q.longCells || !bounds) return { maxCells: q.maxCells };
  const longest = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  return longest > 0 ? { maxCells: q.maxCells, cell: longest / q.longCells } : { maxCells: q.maxCells };
}

/** この設定で計算するときの格子（画面に出す目安。ソルバーが使う格子と同じ決め方）。形が空なら null */
export function previewGrid(bounds: Box3D | null, grid: Study3D['grid']): Grid3D | null {
  if (!bounds) return null;
  try {
    return voxelGrid({ bounds, cell: grid?.cell, maxCells: grid?.maxCells });
  } catch {
    return null;
  }
}
