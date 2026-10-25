// 対流拡散のワークベンチ: 動画（@CFDbyHand）と同じ Excel 式の対流拡散。配線だけを書く。重い部品は遅延 import。
import { ANALYSIS_INFO } from '../../core/analyses';
import type { WorkbenchModule } from '../types';

export const scalarWorkbench: WorkbenchModule = {
  kind: 'scalar',
  label: ANALYSIS_INFO.scalar.label,
  shortHint: '動画と同じ Excel 式の対流拡散',
  order: ANALYSIS_INFO.scalar.order,
  tabBadge: 'Excel式',
  loadSolver: async () => (await import('../../solvers/scalar')).createScalarSolver,
  ui: {
    loadSettings: async () => (await import('../panels/scalar')).scalarSettings,
    loadEasy: async () => (await import('../panels/scalar')).scalarEasy,
    loadPro: async () => (await import('../panels/scalar')).scalarPro,
  },
  hints: ({ raster }) => (raster.solid.some((v) => v === 1) ? [] : ['物体がありません。物体の表面で φ を固定して、まわりへの広がりを計算します。']),
  // 判定は出さない（verdict なし）
  defaultField: 'phi',
  presets: ['square-column'],
  // 数学の窓の式（学びモード）。使うときだけ読み込む
  math: { loadProvider: async () => (await import('../../learn/providers/scalar')).scalarProvider },
};
