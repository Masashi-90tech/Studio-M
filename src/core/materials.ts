import type { Material } from './types';

// 代表値。メーカー・グレード・温度で変わるので、設計判断の前にデータシートで確認すること。
// 3Dプリント材は 100% 充填・XY方向の目安。積層方向（Z）は強度が 30〜50% 下がることがある。
// 電気特性（epsR, tanD）はマイクロ波帯（数 GHz〜数十 GHz）の目安。周波数で変わる。
export const MATERIALS: Material[] = [
  // 流体（20°C）
  { id: 'air', name: '空気', kind: 'fluid', rho: 1.204, k: 0.0257, cp: 1005, viscosity: 1.516e-5, epsR: 1.0006, tanD: 0, color: '#cfe8ff' },
  { id: 'water', name: '水', kind: 'fluid', rho: 998, k: 0.598, cp: 4182, viscosity: 1.004e-6, epsR: 78, tanD: 0.12, color: '#4fa3ff', note: '電気特性は 2.4 GHz 付近の値。24 GHz では εr ≈ 34 まで下がり、損失は大きくなる' },

  // 3Dプリント樹脂
  { id: 'pla', name: 'PLA', kind: 'solid', rho: 1240, k: 0.13, cp: 1800, E: 3.5e9, nu: 0.36, yield: 50e6, epsR: 2.8, tanD: 0.01, maxTempC: 55, color: '#7bc96f', note: '3Dプリント。60°C前後で軟化する' },
  { id: 'petg', name: 'PETG', kind: 'solid', rho: 1270, k: 0.2, cp: 1200, E: 2.0e9, nu: 0.38, yield: 45e6, epsR: 2.7, tanD: 0.01, maxTempC: 70, color: '#5fb4c9', note: '3Dプリント。耐熱 70°C前後' },
  { id: 'abs', name: 'ABS', kind: 'solid', rho: 1040, k: 0.17, cp: 1400, E: 2.2e9, nu: 0.35, yield: 40e6, epsR: 2.6, tanD: 0.006, maxTempC: 85, color: '#e0a35a', note: '3Dプリント。耐熱 90°C前後' },

  // 金属
  { id: 'al6061', name: 'アルミ A6061-T6', kind: 'solid', rho: 2700, k: 167, cp: 896, E: 68.9e9, nu: 0.33, yield: 276e6, conductor: true, color: '#b8c2cc' },
  { id: 'al5052', name: 'アルミ A5052-H32', kind: 'solid', rho: 2680, k: 138, cp: 900, E: 70.3e9, nu: 0.33, yield: 193e6, conductor: true, color: '#a9b3bd' },
  { id: 'ss400', name: '鉄 SS400', kind: 'solid', rho: 7850, k: 51.6, cp: 473, E: 206e9, nu: 0.3, yield: 245e6, conductor: true, color: '#6f7780' },
  { id: 'sus304', name: 'ステンレス SUS304', kind: 'solid', rho: 7930, k: 16.3, cp: 500, E: 193e9, nu: 0.29, yield: 205e6, conductor: true, color: '#8d969e' },
  { id: 'c1100', name: '銅 C1100', kind: 'solid', rho: 8890, k: 391, cp: 385, E: 117e9, nu: 0.34, yield: 70e6, conductor: true, color: '#c8794a', note: '焼なまし材。硬質材は降伏応力がもっと高い' },

  // 電子工作
  { id: 'fr4', name: 'FR-4（基板）', kind: 'solid', rho: 1850, k: 0.3, cp: 1100, E: 22e9, nu: 0.12, yield: 300e6, epsR: 4.3, tanD: 0.02, maxTempC: 130, color: '#3f8f4f', note: '面内の値。銅箔の多い基板は実効熱伝導率がずっと高い' },

  // 建材・その他
  { id: 'glass', name: 'ガラス（ソーダ石灰）', kind: 'solid', rho: 2500, k: 1.0, cp: 840, E: 70e9, nu: 0.22, yield: 40e6, epsR: 6.5, tanD: 0.01, color: '#bfe3e0', note: '脆性材料。降伏ではなく引張破壊の目安で、傷で大きく下がる' },
  { id: 'wood', name: '木材（ヒノキ・繊維方向）', kind: 'solid', rho: 440, k: 0.12, cp: 1600, E: 9e9, nu: 0.3, yield: 40e6, epsR: 2.0, tanD: 0.05, maxTempC: 120, color: '#c9a36b', note: '異方性が強い。繊維と直角方向は剛性・強度がずっと低い。含水率で電気特性が変わる' },
  { id: 'concrete', name: 'コンクリート', kind: 'solid', rho: 2300, k: 1.6, cp: 880, E: 25e9, nu: 0.2, yield: 2.5e6, epsR: 5.5, tanD: 0.05, color: '#a7a39b', note: '引張には弱い（降伏応力は引張強度の目安）。鉄筋は含まない' },
];

export function getMaterial(id: string): Material {
  const m = MATERIALS.find((x) => x.id === id);
  if (!m) throw new Error(`未知の材料: ${id}`);
  return m;
}
