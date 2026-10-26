// 流れのワークベンチ: 空気や水の流れ（格子ボルツマン法）。配線だけを書く。重い部品は遅延 import。
import { ANALYSIS_INFO } from '../../core/analyses';
import { applyFlowAction, flowWorkbenchVerdict } from '../verdicts/flow';
import type { WorkbenchModule } from '../types';

export const flowWorkbench: WorkbenchModule = {
  kind: 'flow',
  label: ANALYSIS_INFO.flow.label,
  shortHint: '空気や水の流れ（非定常）。温度も計算できる',
  order: ANALYSIS_INFO.flow.order,
  loadSolver: async () => (await import('../../solvers/flow')).createFlowSolver,
  ui: {
    loadSettings: async () => (await import('../panels/flow')).flowSettings,
    loadEasy: async () => (await import('../panels/flow')).flowEasy,
    loadPro: async () => (await import('../panels/flow')).flowPro,
    // 温度も計算するとき、部品ごとの温度の表を結果ボックスの下に出す
    loadResultsExtra: async () => (await import('../panels/heat-results')).flowResultsExtra,
  },
  hints: ({ project, raster }) => {
    if (!raster.solid.some((v) => v === 1)) return ['物体がありません。長方形や円を置くと、そのまわりの流れを計算します。'];
    const hints: string[] = [];
    if (project.flow.thermal?.enabled === true) {
      if (!raster.heatGen.some((v) => v > 0) && !raster.fixedTemp.some((v) => !Number.isNaN(v))) {
        hints.push('温度も計算する設定ですが、熱源がありません。役割を「発熱体」にした図形か「温度固定」の図形を置いてください。');
      }
      if (!(project.flow.inletVelocity > 0)) hints.push('流入速度が 0 だと風が熱を運べず、温度が非常に高くなります。流入速度を 0 より大きくしてください。');
    }
    return hints;
  },
  verdictTitle: '流れのようす',
  verdict: flowWorkbenchVerdict,
  applyAction: applyFlowAction,
  // 速度場は流体セルで有効。流線を動かせる
  viewTraits: { vectorMask: 'fluid', particles: true },
  defaultField: 'speed',
  presets: ['karman', 'naca0012', 'fan-heatsink'],
  // 数学の窓の式（学びモード）。使うときだけ読み込む
  math: { loadProvider: async () => (await import('../../learn/providers/flow')).flowProvider },
};
