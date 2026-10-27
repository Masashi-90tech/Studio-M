// 面の条件（Region3D）の追加・削除・編集と、それに付随する表示の決まり（DOM に依存しない）。
// Study3D は書き換えず、変えた新しい Study3D を返す（古い結果かどうかを、前後の比較で見分けられるように）。
import type { Region3D, Region3DRole, Study3D } from '../core/types';

/** 熱の解析で置ける面の条件 */
export const HEAT_ROLES: readonly Region3DRole[] = ['heatFlux', 'fixedTemp', 'convection', 'insulated'];

export interface RoleInfo {
  label: string;
  /** 一覧の名前の元（「発熱 1」のように番号を付ける） */
  baseName: string;
  /** 値の単位。値のない条件（断熱）は undefined */
  unit?: string;
  /** 3D 表示で面に重ねる色（0〜1 の RGB） */
  color: [number, number, number];
  /** 一覧の色の見本（#rrggbb） */
  css: string;
  hint: string;
}

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
const info = (label: string, baseName: string, unit: string | undefined, css: string, hint: string): RoleInfo => ({ label, baseName, unit, css, color: rgb(css), hint });

export const ROLE_INFO: Record<Region3DRole, RoleInfo> = {
  heatFlux: info('発熱', '発熱', 'W', '#e03131', '選んだ面から、合計でこれだけの熱を入れます（部品が面に載っている、など）'),
  fixedTemp: info('温度を固定', '温度固定', '°C', '#1c7ed6', '選んだ面を、この温度に保ちます（ヒートシンクや冷えた板に押し当てている面、など）'),
  convection: info('ファンが当たる', 'ファン', 'W/(m²·K)', '#0c8599', '選んだ面の熱の逃げやすさ（熱伝達率 h）を変えます。ファンの風が当たる面など'),
  insulated: info('断熱', '断熱', undefined, '#7048e8', '選んだ面から熱を逃がしません（断熱材に接している面、など）'),
  support: info('固定', '固定', undefined, '#2f9e44', '強度の解析で使います'),
  load: info('荷重', '荷重', 'N', '#d6336c', '強度の解析で使います'),
};

/** 面を選んだだけの状態の強調（黄色） */
export const SELECTION_COLOR: [number, number, number] = [0.98, 0.78, 0.12];

/** 条件の値の既定 */
export const REGION_DEFAULTS = { heatW: 5, convectionH: 40 } as const;

/** 条件の ID（既存と重ならない） */
export function nextRegionId(regions: readonly Region3D[]): string {
  let n = regions.length + 1;
  const ids = new Set(regions.map((r) => r.id));
  while (ids.has(`r${n}`)) n++;
  return `r${n}`;
}

/** 同じ種類の中で重ならない名前（「発熱 1」「発熱 2」…） */
export function nextRegionName(regions: readonly Region3D[], role: Region3DRole): string {
  const base = ROLE_INFO[role].baseName;
  const names = new Set(regions.map((r) => r.name));
  let n = 1;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** 条件の値の欄（その条件が持つ値）。断熱は値がない */
export type RegionValueKey = 'heatW' | 'tempC' | 'h';
export function valueKeyOf(role: Region3DRole): RegionValueKey | null {
  if (role === 'heatFlux') return 'heatW';
  if (role === 'fixedTemp') return 'tempC';
  if (role === 'convection') return 'h';
  return null;
}

export interface AddRegionOptions {
  role: Region3DRole;
  faces: readonly number[];
  /** 値（省略時は既定: 発熱 5 W、温度固定は周囲の温度、ファン h = 40） */
  value?: number;
  name?: string;
}

export interface AddRegionResult {
  study: Study3D;
  region: Region3D;
  /** 新しい条件に面を取られて、面がなくなったので消した条件の名前 */
  removed: string[];
}

/**
 * 条件を足す。面はひとつの条件にだけ属するので、すでに別の条件に入っている面は新しい条件に移る
 * （面がなくなった条件は消す）。面が 1 つもなければ Error
 */
export function addRegion(study: Study3D, opts: AddRegionOptions): AddRegionResult {
  const n = Math.floor(study.mesh.indices.length / 3);
  const faces = [...new Set(opts.faces)].filter((t) => Number.isInteger(t) && t >= 0 && t < n).sort((a, b) => a - b);
  if (faces.length === 0) throw new Error('面が選ばれていません。3D の図で面をクリックして選んでから、条件を足してください。');
  const taken = new Set(faces);
  const removed: string[] = [];
  const kept: Region3D[] = [];
  for (const r of study.regions) {
    const rest = r.faces.filter((t) => !taken.has(t));
    if (rest.length === 0) {
      removed.push(r.name);
      continue;
    }
    kept.push(rest.length === r.faces.length ? r : { ...r, faces: rest });
  }
  const region: Region3D = { id: nextRegionId(study.regions), name: opts.name?.trim() || nextRegionName(kept, opts.role), role: opts.role, faces };
  if (opts.role === 'heatFlux') region.heatW = opts.value ?? REGION_DEFAULTS.heatW;
  else if (opts.role === 'fixedTemp') region.tempC = opts.value ?? study.heat.ambientC;
  else if (opts.role === 'convection') region.h = opts.value ?? REGION_DEFAULTS.convectionH;
  return { study: { ...study, regions: [...kept, region] }, region, removed };
}

export function removeRegion(study: Study3D, id: string): Study3D {
  if (!study.regions.some((r) => r.id === id)) return study;
  return { ...study, regions: study.regions.filter((r) => r.id !== id) };
}

/** 名前と値を変える。値は、その条件が持つ項目だけが変わる（断熱の値は無視） */
export function updateRegion(study: Study3D, id: string, patch: { name?: string; value?: number }): Study3D {
  return {
    ...study,
    regions: study.regions.map((r) => {
      if (r.id !== id) return r;
      const next: Region3D = { ...r };
      if (patch.name !== undefined) next.name = patch.name;
      const key = valueKeyOf(r.role);
      if (patch.value !== undefined && key && Number.isFinite(patch.value)) next[key] = patch.value;
      return next;
    }),
  };
}

/** 条件の値の表示（「5 W」「80 °C」「h = 40」「断熱」） */
export function regionValueText(r: Region3D): string {
  switch (r.role) {
    case 'heatFlux':
      return `${r.heatW ?? 0} W`;
    case 'fixedTemp':
      return `${r.tempC ?? 0} °C`;
    case 'convection':
      return `h = ${r.h ?? 0}`;
    case 'insulated':
      return '断熱';
    default:
      return ROLE_INFO[r.role].label;
  }
}

/** 三角形 → 条件の番号（regions の並びでの番号。属さなければ -1）。表示で面を色分けするのに使う */
export function faceOwners(study: Study3D): Int16Array {
  const n = Math.floor(study.mesh.indices.length / 3);
  const owner = new Int16Array(n).fill(-1);
  study.regions.forEach((r, i) => {
    for (const t of r.faces) if (t >= 0 && t < n) owner[t] = i;
  });
  return owner;
}

/**
 * 形・条件・設定が同じかどうかを見分けるための印（名前は含めない）。結果を出したときの印と今の印が違えば、結果は古い。
 * 形（mesh）は途中で変わらないので含めない
 */
export function studySignature(study: Study3D): string {
  // 流れは、流れの設定だけで決まる（熱の設定や面の条件を変えても、流れの結果は古くならない。流れ＋熱は次の段階）
  if (study.analysis === 'flow') return JSON.stringify([study.analysis, study.flow, study.flow?.thermal?.enabled ? [study.materialId, study.heat] : null, study.grid]);
  const r =study.regions.map((g) => {
    let h = 2166136261;
    for (const t of g.faces) h = Math.imul(h ^ t, 16777619);
    return [g.id, g.role, g.heatW, g.tempC, g.h, g.force?.fx, g.force?.fy, g.force?.fz, g.faces.length, h >>> 0].join(':');
  });
  return JSON.stringify([study.analysis, study.materialId, study.heat, study.stress, study.grid, r]);
}
