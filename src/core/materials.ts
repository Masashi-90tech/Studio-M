import type { Material } from './types';

// 代表値。メーカー・グレード・温度で変わるので、設計判断の前にデータシートで確認すること。
// 3Dプリント材は 100% 充填・XY方向の目安。積層方向（Z）は強度が 30〜50% 下がることがある。
export const MATERIALS: Material[] = [
  // 流体（20°C）
  { id: 'air', name: '空気', kind: 'fluid', rho: 1.204, k: 0.0257, cp: 1005, viscosity: 1.516e-5, color: '#cfe8ff' },
  { id: 'water', name: '水', kind: 'fluid', rho: 998, k: 0.598, cp: 4182, viscosity: 1.004e-6, color: '#4fa3ff' },

  // 3Dプリント樹脂
  { id: 'pla', name: 'PLA', kind: 'solid', rho: 1240, k: 0.13, cp: 1800, E: 3.5e9, nu: 0.36, yield: 50e6, color: '#7bc96f', note: '3Dプリント。60°C前後で軟化する' },
  { id: 'petg', name: 'PETG', kind: 'solid', rho: 1270, k: 0.2, cp: 1200, E: 2.0e9, nu: 0.38, yield: 45e6, color: '#5fb4c9', note: '3Dプリント。耐熱 70°C前後' },
  { id: 'abs', name: 'ABS', kind: 'solid', rho: 1040, k: 0.17, cp: 1400, E: 2.2e9, nu: 0.35, yield: 40e6, color: '#e0a35a', note: '3Dプリント。耐熱 90°C前後' },

  // 金属
  { id: 'al6061', name: 'アルミ A6061-T6', kind: 'solid', rho: 2700, k: 167, cp: 896, E: 68.9e9, nu: 0.33, yield: 276e6, color: '#b8c2cc' },
  { id: 'al5052', name: 'アルミ A5052-H32', kind: 'solid', rho: 2680, k: 138, cp: 900, E: 70.3e9, nu: 0.33, yield: 193e6, color: '#a9b3bd' },
  { id: 'ss400', name: '鉄 SS400', kind: 'solid', rho: 7850, k: 51.6, cp: 473, E: 206e9, nu: 0.3, yield: 245e6, color: '#6f7780' },
  { id: 'sus304', name: 'ステンレス SUS304', kind: 'solid', rho: 7930, k: 16.3, cp: 500, E: 193e9, nu: 0.29, yield: 205e6, color: '#8d969e' },
  { id: 'c1100', name: '銅 C1100', kind: 'solid', rho: 8890, k: 391, cp: 385, E: 117e9, nu: 0.34, yield: 70e6, color: '#c8794a', note: '焼なまし材。硬質材は降伏応力がもっと高い' },

  // 電子工作
  { id: 'fr4', name: 'FR-4（基板）', kind: 'solid', rho: 1850, k: 0.3, cp: 1100, E: 22e9, nu: 0.12, yield: 300e6, color: '#3f8f4f', note: '面内の値。銅箔の多い基板は実効熱伝導率がずっと高い' },
];

export function getMaterial(id: string): Material {
  const m = MATERIALS.find((x) => x.id === id);
  if (!m) throw new Error(`未知の材料: ${id}`);
  return m;
}
