// 熱のワークベンチ: 熱の伝わりと温度（有限差分）。配線だけを書く。重い部品は遅延 import。
import { ANALYSIS_INFO } from '../../core/analyses';
import { applyHeatAction, heatWorkbenchVerdict } from '../verdicts/heat';
import type { WorkbenchModule } from '../types';

export const heatWorkbench: WorkbenchModule = {
  kind: 'heat',
  label: ANALYSIS_INFO.heat.label,
  shortHint: '熱の伝わりと温度',
  order: ANALYSIS_INFO.heat.order,
  loadSolver: async () => (await import('../../solvers/heat')).createHeatSolver,
  ui: {
    loadSettings: async () => (await import('../panels/heat')).heatSettings,
    loadEasy: async () => (await import('../panels/heat')).heatEasy,
    loadPro: async () => (await import('../panels/heat')).heatPro,
  },
  hints: ({ raster }) => {
    if (!raster.solid.some((v) => v === 1)) return ['物体がありません。物体と発熱体を置いてください。'];
    if (!raster.heatGen.some((v) => v > 0) && !raster.fixedTemp.some((v) => !Number.isNaN(v))) {
      return ['熱源がありません。役割を「発熱体」にした図形か「温度固定」の図形を置いてください。'];
    }
    return [];
  },
  verdictTitle: '熱の判定',
  verdict: heatWorkbenchVerdict,
  applyAction: applyHeatAction,
  defaultField: 'temperature',
  presets: ['heatsink', 'board'],
};
