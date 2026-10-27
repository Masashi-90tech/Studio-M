// 3D の流れの設定の選択肢（風の向き・速さ・まわり・計算の細かさ）と、風洞・格子の大きさの目安（DOM に依存しない）。
// 2D のかんたんパネル（workbench/panels/flow.ts）の言葉にそろえている。
import { MATERIALS } from '../core/materials';
import { flow3DDefaults, flowAxis, flowBounds, mesh3DBounds, studyGrid, type Box3D } from '../core/grid3d';
import type { Analysis3DKind, Flow3DSettings, FlowDirection3D, Grid3D, Study3D } from '../core/types';

/** 3D の解析の切り替えに出す種類（強度はまだ画面がない） */
export const ANALYSIS_OPTIONS: readonly { id: Analysis3DKind; label: string; hint: string }[] = [
  { id: 'heat', label: '熱', hint: '部品の中の温度（定常の熱伝導）を解きます' },
  { id: 'flow', label: '流れ', hint: '部品を風洞に置いて、風（空気・水）を当てたときの流れと力を解きます' },
];

export interface FlowDirectionOption {
  id: FlowDirection3D;
  label: string;
  /** ボタンの矢印 */
  arrow: string;
  hint: string;
}

export const FLOW_DIRECTIONS: readonly FlowDirectionOption[] = [
  { id: '+x', label: '＋X', arrow: '→', hint: 'X の正の向きへ流れます（−X 側から風が当たる）' },
  { id: '-x', label: '−X', arrow: '←', hint: 'X の負の向きへ流れます（＋X 側から風が当たる）' },
  { id: '+y', label: '＋Y', arrow: '↗', hint: 'Y の正の向きへ流れます（−Y 側から風が当たる）' },
  { id: '-y', label: '−Y', arrow: '↙', hint: 'Y の負の向きへ流れます（＋Y 側から風が当たる）' },
  { id: '+z', label: '＋Z', arrow: '↑', hint: 'Z の正の向き（上向き）へ流れます（下から風が当たる）' },
  { id: '-z', label: '−Z', arrow: '↓', hint: 'Z の負の向き（下向き）へ流れます（上から風が当たる）' },
];

/** 風の向き → 単位ベクトル */
export function directionVector(direction: FlowDirection3D): [number, number, number] {
  const { axis, sign } = flowAxis(direction);
  const v: [number, number, number] = [0, 0, 0];
  v[axis] = sign;
  return v;
}

/** 風の速さの選択肢（2D のかんたんパネルと同じ） */
export const FLOW_SPEEDS: readonly { label: string; speed: number }[] = [
  { label: 'そよ風 1 m/s', speed: 1 },
  { label: '扇風機 3 m/s', speed: 3 },
  { label: '自転車 6 m/s', speed: 6 },
  { label: '車 28 m/s', speed: 28 },
];

/** 速さに合う選択肢の番号（どれにも合わなければ -1） */
export function flowSpeedIndex(speed: number): number {
  return FLOW_SPEEDS.findIndex((s) => Math.abs(s.speed - speed) < 1e-9);
}

export const WALL_OPTIONS: readonly { id: Flow3DSettings['walls']; label: string; hint: string }[] = [
  { id: 'slip', label: '開けた場所', hint: '風洞の壁の影響を受けません（部品のまわりに十分な空間があるとき）' },
  { id: 'noslip', label: 'ダクトの中', hint: '風洞の壁にも摩擦があります（部品がダクトや筐体の中に入っているとき）' },
];

/** 流体の選択肢（空気・水） */
export const FLUID_OPTIONS = MATERIALS.filter((m) => m.kind === 'fluid' && (m.id === 'air' || m.id === 'water')).map((m) => ({ value: m.id, label: m.name }));

export type FlowQualityId = 'coarse' | 'normal' | 'fine';

export interface FlowQualityOption {
  id: FlowQualityId;
  label: string;
  /** Study3D.grid.maxCells（風洞全体のセル数の上限） */
  maxCells: number;
  hint: string;
}

export const FLOW_QUALITY_OPTIONS: readonly FlowQualityOption[] = [
  { id: 'coarse', label: '粗い（8 万）', maxCells: 80_000, hint: '風洞全体で約 8 万セル。流れの向きや大まかな形をつかむ' },
  { id: 'normal', label: '標準（25 万）', maxCells: 250_000, hint: '風洞全体で約 25 万セル。ふだんはこれ' },
  { id: 'fine', label: '細かい（60 万）', maxCells: 600_000, hint: '風洞全体で約 60 万セル。進みは遅くなります。細い部品や、渦を細かく見たいとき' },
];

export function flowQualityOf(id: FlowQualityId): FlowQualityOption {
  return FLOW_QUALITY_OPTIONS.find((q) => q.id === id) ?? FLOW_QUALITY_OPTIONS[1];
}

/** maxCells に近い細かさの選択肢（省略時は標準） */
export function flowQualityIdFor(maxCells: number | undefined): FlowQualityId {
  if (maxCells === undefined || !(maxCells > 0)) return 'normal';
  let best = FLOW_QUALITY_OPTIONS[1];
  for (const q of FLOW_QUALITY_OPTIONS) if (Math.abs(Math.log(q.maxCells / maxCells)) < Math.abs(Math.log(best.maxCells / maxCells))) best = q;
  return best.id;
}

/** 細かさの選択を Study3D.grid にする（流れはセル数の上限だけ決め、セルの大きさは風洞の大きさから決まる） */
export function flowQualityGrid(id: FlowQualityId): NonNullable<Study3D['grid']> {
  return { maxCells: flowQualityOf(id).maxCells };
}

/** 流れの設定を、省略された項目を既定で補って取り出す */
export function flowOf(study: Study3D): Flow3DSettings {
  return { ...flow3DDefaults(), ...study.flow };
}

/** 流れの設定を一部だけ変えた新しい Study3D（domain・advanced・thermal は項目ごとに混ぜる） */
export function withFlow(study: Study3D, patch: Partial<Flow3DSettings>): Study3D {
  const cur = flowOf(study);
  return { ...study, flow: { ...cur, ...patch } };
}

/**
 * 解析の種類を切り替えた新しい Study3D。熱の面の条件・設定はそのまま残す。
 * 流れに切り替えるとき、流れの設定がなければ既定を入れる。格子の細かさは解析ごとに別（grid を渡して差し替える）
 */
export function switchAnalysis(study: Study3D, analysis: Analysis3DKind, grid?: Study3D['grid']): Study3D {
  if (study.analysis === analysis) return study;
  const next: Study3D = { ...study, analysis, grid };
  if (analysis === 'flow') next.flow = flowOf(study);
  return next;
}

/** 風が当たる部品の大きさ D（流れに垂直な 2 方向の寸法の大きい方）[m] と、流れの向きの長さ [m] */
export function flowPartSize(bounds: Box3D, direction: FlowDirection3D): { d: number; length: number } {
  const { axis } = flowAxis(direction);
  const size = [0, 1, 2].map((a) => bounds.max[a] - bounds.min[a]);
  return { d: Math.max(...[0, 1, 2].filter((a) => a !== axis).map((a) => size[a]), 0), length: size[axis] };
}

/** 風洞の範囲（部品の外接箱を広げたもの）。形が空なら null */
export function tunnelBox(study: Study3D): Box3D | null {
  const b = mesh3DBounds(study.mesh);
  return b ? flowBounds(b, flowOf(study)) : null;
}

export interface FlowGridInfo {
  grid: Grid3D;
  cells: number;
  /** セルの一辺 [mm] */
  cellMm: number;
  /** 部品の D [m] */
  d: number;
  /** 部品の D が何セルか */
  dCells: number;
}

/** この設定で計算するときの風洞の格子（画面に出す目安。ソルバーが使う格子と同じ決め方）。決められなければ null */
export function flowGridInfo(study: Study3D): FlowGridInfo | null {
  const b = mesh3DBounds(study.mesh);
  if (!b) return null;
  try {
    const grid = studyGrid({ ...study, analysis: 'flow', flow: flowOf(study) });
    const { d } = flowPartSize(b, flowOf(study).direction);
    return { grid, cells: grid.nx * grid.ny * grid.nz, cellMm: grid.h * 1e3, d, dCells: d / grid.h };
  } catch {
    return null;
  }
}
