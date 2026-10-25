// 流れのワークベンチ: 空気や水の流れ（格子ボルツマン法）。配線だけを書く。重い部品は遅延 import。
import { ANALYSIS_INFO } from '../../core/analyses';
import { flowWorkbenchVerdict } from '../verdicts/flow';
import type { WorkbenchModule } from '../types';

export const flowWorkbench: WorkbenchModule = {
  kind: 'flow',
  label: ANALYSIS_INFO.flow.label,
  shortHint: '空気や水の流れ（非定常）',
  order: ANALYSIS_INFO.flow.order,
  loadSolver: async () => (await import('../../solvers/flow')).createFlowSolver,
  ui: {
    loadSettings: async () => (await import('../panels/flow')).flowSettings,
    loadEasy: async () => (await import('../panels/flow')).flowEasy,
    loadPro: async () => (await import('../panels/flow')).flowPro,
  },
  hints: ({ raster }) => (raster.solid.some((v) => v === 1) ? [] : ['物体がありません。長方形や円を置くと、そのまわりの流れを計算します。']),
  verdictTitle: '流れのようす',
  verdict: flowWorkbenchVerdict,
  // 速度場は流体セルで有効。流線を動かせる
  viewTraits: { vectorMask: 'fluid', particles: true },
  defaultField: 'speed',
  presets: ['karman', 'naca0012'],
};
