// CalculiX アダプターのオプション（画面のプロモードで選べる項目）と、計算の細かさ（quality）の扱い。

import type { EngineOptionSpec, JobQuality, JobRequest } from '../../../src/core/engine-protocol';
import { resolveProject } from '../../../src/core/auto';
import type { Project } from '../../../src/core/types';

/** 要素の種類。CPS4 = 4 節点の平面応力、CPS4R = 低減積分、CPS8R = 8 節点（辺の中点にも節点）・低減積分 */
export type PlaneStressElement = 'CPS4' | 'CPS4R' | 'CPS8R';

/** 画面で選べる値。auto = 弾性は CPS4（Lite と同じ形）、塑性は CPS8R */
export type ElementChoice = 'auto' | PlaneStressElement;

export interface StressOptions {
  plasticity: boolean;
  largeDeformation: boolean;
  elementType: ElementChoice;
  /** 塑性ありのとき、プロジェクトの荷重に掛けて最終的にかける倍率 */
  loadFactor: number;
  /** 降伏後の硬化係数（E に対する割合 [%]）。0 で完全弾塑性 */
  hardeningPercent: number;
}

/** 要素数の上限（格子を細かくしすぎたときの安全弁） */
export const MAX_CELLS = 250_000;

export const STRESS_OPTION_SPECS: EngineOptionSpec[] = [
  {
    key: 'plasticity',
    label: '塑性（降伏したあとの変形）も計算する',
    kind: 'boolean',
    default: false,
    hint: '降伏応力を超えた部分が塑性変形する様子を、荷重を少しずつ増やしながら計算します（完全弾塑性）。降伏した面積の割合も出ます。',
  },
  {
    key: 'loadFactor',
    label: '荷重の倍率（塑性ありのとき）',
    kind: 'number',
    default: 1,
    unit: '倍',
    hint: '荷重を 0 からこの倍率まで増やしていきます。壊れる様子を見たいときは 2〜5 倍にしてみてください。',
  },
  {
    key: 'hardeningPercent',
    label: '降伏後の硬化（塑性ありのとき）',
    kind: 'number',
    default: 0,
    unit: '%',
    hint: '0 で完全弾塑性（降伏後は応力が増えない）。数 % を入れると、降伏後もわずかに強くなる材料として扱います。',
  },
  {
    key: 'largeDeformation',
    label: '大きな変形（幾何学的非線形）を考慮する',
    kind: 'boolean',
    default: false,
    hint: '変形で形が変わる効果を入れます。たわみが部材の寸法の 1 割を超えるようなときに有効です（時間は少し長くなります）。',
  },
  {
    key: 'elementType',
    label: '要素の種類',
    kind: 'select',
    default: 'auto',
    choices: [
      { value: 'auto', label: 'おまかせ（弾性は CPS4、塑性は CPS8R）' },
      { value: 'CPS4', label: 'CPS4（4 節点・Lite と同じ形）' },
      { value: 'CPS4R', label: 'CPS4R（4 節点・低減積分）' },
      { value: 'CPS8R', label: 'CPS8R（8 節点・低減積分。曲げに強い）' },
    ],
    hint: 'Lite と比べたいときは CPS4。塑性では CPS4 が実際より硬くなる（体積ロッキング）ので、おまかせでは CPS8R を使います。',
  },
];

const asBool = (v: unknown, fallback: boolean): boolean => {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  return fallback;
};

const asNumber = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
};

export function parseStressOptions(options: JobRequest['options']): StressOptions {
  const o = options ?? {};
  const et = String(o.elementType ?? 'auto').toUpperCase();
  return {
    plasticity: asBool(o.plasticity, false),
    largeDeformation: asBool(o.largeDeformation, false),
    elementType: et === 'CPS4' || et === 'CPS4R' || et === 'CPS8R' ? et : 'auto',
    loadFactor: Math.max(0.01, asNumber(o.loadFactor, 1)),
    hardeningPercent: Math.max(0, asNumber(o.hardeningPercent, 0)),
  };
}

const QUALITY_FACTOR: Record<JobQuality, number> = { draft: 1, standard: 1.5, fine: 2 };

export interface GridChoice {
  /** 格子を決め直したプロジェクト（domain.nx が使う値） */
  project: Project;
  /** Lite と同じ格子の nx */
  baseNx: number;
  nx: number;
  ny: number;
  factor: number;
  /** 利用者に見せる一言 */
  note: string;
}

const rowsOf = (project: Project, nx: number): number =>
  Math.max(1, Math.round(project.domain.height / (project.domain.width / nx)));

/**
 * 格子を決める。autoGrid が false でなければ core/auto の規則（Lite と同じ）で nx を決め、
 * quality に応じて細かくする（draft = Lite と同じ、standard = ×1.5、fine = ×2）。
 * 全セル数が maxCells（既定 MAX_CELLS）を超えないように、超えるときは細かさを減らす。
 */
export function chooseGrid(opts: { project: Project; analysis: 'stress' | 'heat'; quality?: JobQuality; maxCells?: number }): GridChoice {
  const maxCells = opts.maxCells ?? MAX_CELLS;
  const { project: resolved } = resolveProject(opts.project, opts.analysis);
  const baseNx = resolved.domain.nx;
  const wanted = QUALITY_FACTOR[opts.quality ?? 'standard'] ?? 1;
  let nx = Math.max(baseNx, Math.round(baseNx * wanted));
  let capped = false;
  while (nx > baseNx && nx * rowsOf(resolved, nx) > maxCells) {
    nx--;
    capped = true;
  }
  const out: Project = { ...resolved, domain: { ...resolved.domain, nx } };
  const ny = rowsOf(out, nx);
  const factor = nx / baseNx;
  let note: string;
  if (nx === baseNx) note = `格子は Lite と同じ ${nx} × ${ny} セルです。`;
  else note = `格子は Lite（${baseNx} セル幅）の ${factor.toFixed(2).replace(/\.?0+$/, '')} 倍の細かさ（${nx} × ${ny} セル）にしました。`;
  if (capped) note += `要素数の上限（${maxCells.toLocaleString('ja-JP')}）のため、細かさを抑えました。`;
  return { project: out, baseNx, nx, ny, factor, note };
}
