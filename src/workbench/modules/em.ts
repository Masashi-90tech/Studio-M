// 電磁波のワークベンチ: 電波・レーダーの伝わり方（2D FDTD）。配線だけを書く。重い部品は遅延 import。
import { ANALYSIS_INFO } from '../../core/analyses';
import { applyEmAction, emWorkbenchVerdict } from '../verdicts/em';
import type { WorkbenchModule } from '../types';

export const emWorkbench: WorkbenchModule = {
  kind: 'em',
  label: ANALYSIS_INFO.em.label,
  shortHint: '電波・レーダーの伝わり方（FDTD）',
  order: ANALYSIS_INFO.em.order,
  loadSolver: async () => (await import('../../solvers/em')).createEMSolver,
  ui: {
    loadSettings: async () => (await import('../panels/em')).emSettings,
    loadEasy: async () => (await import('../panels/em')).emEasy,
    loadPro: async () => (await import('../panels/em')).emPro,
    // 波源の印と、点波源のドラッグ移動
    loadOverlay: async () => (await import('../panels/em-marker')).emOverlay,
  },
  verdictTitle: '電波の判定',
  verdict: emWorkbenchVerdict,
  applyAction: applyEmAction,
  // 電磁波では比誘電率 εr（金属はその旨）を材料名に添える
  materialLabel: (m) => (m.conductor ? `${m.name}（金属）` : `${m.name}（εr ${m.epsR ?? 1}）`),
  defaultField: 'field',
  presets: ['radar-cover', 'metal-shadow', 'wifi-room'],
  // 数学の窓の式（学びモード）。使うときだけ読み込む
  math: { loadProvider: async () => (await import('../../learn/providers/em')).emProvider },
};
