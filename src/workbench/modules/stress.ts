// 強度のワークベンチ: 力をかけたときの応力と変形（有限要素法）。配線だけを書く。重い部品は遅延 import。
import { ANALYSIS_INFO } from '../../core/analyses';
import { applyStressAction, stressWorkbenchVerdict } from '../verdicts/stress';
import type { WorkbenchModule } from '../types';

export const stressWorkbench: WorkbenchModule = {
  kind: 'stress',
  label: ANALYSIS_INFO.stress.label,
  shortHint: '力をかけたときの応力と変形',
  order: ANALYSIS_INFO.stress.order,
  loadSolver: async () => (await import('../../solvers/stress')).createStressSolver,
  ui: {
    loadSettings: async () => (await import('../panels/stress')).stressSettings,
    loadEasy: async () => (await import('../panels/stress')).stressEasy,
    loadPro: async () => (await import('../panels/stress')).stressPro,
  },
  hints: ({ project, raster: r }) => {
    if (!r.solid.some((v) => v === 1)) return ['物体がありません。部品の形を描いてください。'];
    const hints: string[] = [];
    let supportOnBody = 0;
    let loadSum = 0;
    for (let c = 0; c < r.solid.length; c++) {
      if (r.solid[c] && r.support[c]) supportOnBody++;
      loadSum += Math.abs(r.loadFx[c]) + Math.abs(r.loadFy[c]);
    }
    if (supportOnBody === 0) hints.push('「支持」が物体に重なっていません。固定したい面に役割「支持」の図形を重ねてください。');
    if (loadSum === 0 && !project.stress.selfWeight) hints.push('「荷重」が物体に重なっていません。力をかけたい場所に役割「荷重」の図形を重ねてください。');
    return hints;
  },
  verdictTitle: '強度の判定',
  verdict: stressWorkbenchVerdict,
  applyAction: applyStressAction,
  // 変位場（ux, uy）は物体セルで有効。変形を強調表示できる
  viewTraits: { vectorMask: 'solid', deform: true },
  defaultField: 'vonMises',
  presets: ['l-bracket', 'cantilever'],
  // 数学の窓の式（学びモード）。使うときだけ読み込む
  math: { loadProvider: async () => (await import('../../learn/providers/stress')).stressProvider },
};
