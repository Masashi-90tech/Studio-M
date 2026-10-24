// 格子（解像度）の自動決定。project.domain.autoGrid が false でないときに、解析ごとに nx を決める。
//
// 方針（セル数が多すぎると画面が固まるので、解析ごとに上限を持つ）:
// - 流れ / スカラー: 物体の高さ L のまわりを細かく切る（流れは約 32 セル、スカラーは約 20 セル）
// - 熱 / 強度:      いちばん細い部位（物体の短辺・穴の短辺）を 4 セル以上（強度は 6 セル以上）で切る
// - 電磁波:         媒質中の最短波長 λmin を 1波長あたり cellsPerWavelength セル（既定 20）で切る
// nx は 40〜500 に収め、全セル数も解析ごとの上限（流れ・電磁波・スカラー約 20 万、熱・強度約 12 万）に収める。

import { getMaterial } from './materials';
import type { AnalysisKind, Project, Shape, ShapeGeom } from './types';

export interface AutoGrid {
  nx: number;
  ny: number;
  /** セル幅 [m] */
  h: number;
  /** 利用者に見せる理由（日本語） */
  reason: string;
}

const NX_MIN = 40;
const NX_MAX = 500;
/** 物体がない / 寸法が決められないときの標準の nx */
const NX_DEFAULT = 200;
/** 流れ・スカラーで、領域が許すなら確保する最小の nx */
const NX_FLOW_FLOOR = 120;
/** 熱・強度の最小の nx */
const NX_SOLID_FLOOR = 120;
/** 全セル数の上限 */
const CELLS_MAX_FLOW = 200_000;
const CELLS_MAX_SOLID = 120_000;

const FLOW_CELLS_ACROSS = 32;
const SCALAR_CELLS_ACROSS = 20;
const HEAT_CELLS_ACROSS = 4;
const STRESS_CELLS_ACROSS = 6;
const DEFAULT_CELLS_PER_WAVELENGTH = 20;
const LIGHT_SPEED = 299_792_458;

const KIND_LABEL: Record<AnalysisKind, string> = {
  flow: '流れ',
  heat: '熱',
  stress: '強度',
  scalar: 'スカラー',
  em: '電磁波',
};

// ---------- 形状の寸法 ----------

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 形状のバウンディングボックス（格子化せず、形状そのものから求める） */
function boundingBox(g: ShapeGeom): Box {
  switch (g.kind) {
    case 'rect':
      return { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h };
    case 'circle':
      return { x0: g.cx - g.r, y0: g.cy - g.r, x1: g.cx + g.r, y1: g.cy + g.r };
    case 'polygon': {
      const b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const [x, y] of g.points) {
        b.x0 = Math.min(b.x0, x);
        b.y0 = Math.min(b.y0, y);
        b.x1 = Math.max(b.x1, x);
        b.y1 = Math.max(b.y1, y);
      }
      return b;
    }
  }
}

const isBody = (s: Shape) => s.role === 'solid' || s.role === 'heatSource';

/** 物体（solid / heatSource）全体を囲む高さ [m]。物体がなければ 0 */
function bodiesHeight(project: Project): number {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const s of project.shapes) {
    if (!isBody(s)) continue;
    const b = boundingBox(s.geom);
    y0 = Math.min(y0, b.y0);
    y1 = Math.max(y1, b.y1);
  }
  return y1 > y0 ? y1 - y0 : 0;
}

/** いちばん細い部位: 物体の短辺と穴の短辺の最小値。なければ null */
function thinnestFeature(project: Project): { size: number; name: string } | null {
  let best: { size: number; name: string } | null = null;
  for (const s of project.shapes) {
    if (!isBody(s) && s.role !== 'hole') continue;
    const b = boundingBox(s.geom);
    const size = Math.min(b.x1 - b.x0, b.y1 - b.y0);
    if (!(size > 1e-12)) continue;
    if (!best || size < best.size) best = { size, name: s.name };
  }
  return best;
}

// ---------- 格子数の計算 ----------

function rows(project: Project, nx: number): number {
  const h = project.domain.width / nx;
  return Math.max(1, Math.round(project.domain.height / h));
}

/** nx を [min, 500] に収め、全セル数が maxCells を超えないよう減らす。上限で切ったかも返す */
function clampNx(project: Project, nx: number, min: number, maxCells: number): { nx: number; capped: boolean } {
  const want = Math.ceil(nx - 1e-9); // 浮動小数点の誤差で 1 セル増えないようにする
  let v = Math.max(min, Math.min(NX_MAX, want));
  let capped = want > v;
  // 縦長の領域ではセル数の上限が先に効く（ただし NX_MIN までは下げない）
  while (v > NX_MIN && v * rows(project, v) > maxCells) {
    v--;
    capped = true;
  }
  return { nx: v, capped };
}

/** 長さを読みやすく（1 m 以上は m、それ未満は mm） */
function fmtLen(m: number): string {
  const trim = (x: number) => String(Number(x.toPrecision(3)));
  return m >= 1 ? `${trim(m)} m` : `${trim(m * 1000)} mm`;
}

function make(project: Project, nx: number, reason: string): AutoGrid {
  const h = project.domain.width / nx;
  return { nx, ny: rows(project, nx), h, reason };
}

// ---------- 解析ごとの規則 ----------

/** 流れ・スカラー: 物体の高さ L を cellsAcross セルで切る（nx は 120 以上を確保） */
function gridByBodyHeight(project: Project, kind: 'flow' | 'scalar', cellsAcross: number): AutoGrid {
  const label = KIND_LABEL[kind];
  const L = bodiesHeight(project);
  const W = project.domain.width;
  if (!(L > 0) || !(W > 0)) {
    const { nx } = clampNx(project, NX_DEFAULT, NX_MIN, CELLS_MAX_FLOW);
    return make(project, nx, `物体がないため標準の ${nx} セルで分割（${label}）`);
  }
  const wanted = (cellsAcross * W) / L;
  const floored = wanted < NX_FLOW_FLOOR;
  const { nx, capped } = clampNx(project, Math.max(wanted, NX_FLOW_FLOOR), NX_MIN, CELLS_MAX_FLOW);
  const cells = Math.max(1, Math.round((L * nx) / W));
  const base = `物体の高さ ${fmtLen(L)} を`;
  if (capped) return make(project, nx, `${base}約 ${cells} セルで分割（${label}・上限のため）`);
  if (floored) return make(project, nx, `${base} ${cells} セルで分割（${label}・最低 ${NX_FLOW_FLOOR} セルを確保）`);
  return make(project, nx, `${base} ${cells} セルで分割（${label}）`);
}

/** 熱・強度: いちばん細い部位を cellsAcross セル以上で切る */
function gridByThinnest(project: Project, kind: 'heat' | 'stress', cellsAcross: number): AutoGrid {
  const label = KIND_LABEL[kind];
  const W = project.domain.width;
  const f = thinnestFeature(project);
  if (!f || !(W > 0)) {
    const { nx } = clampNx(project, NX_DEFAULT, NX_SOLID_FLOOR, CELLS_MAX_SOLID);
    return make(project, nx, `物体がないため標準の ${nx} セルで分割（${label}）`);
  }
  const wanted = (cellsAcross * W) / f.size;
  const floored = wanted < NX_SOLID_FLOOR;
  const { nx, capped } = clampNx(project, Math.max(wanted, NX_SOLID_FLOOR), NX_SOLID_FLOOR, CELLS_MAX_SOLID);
  const cells = Math.max(1, Math.round((f.size * nx) / W));
  const base = `最も細い部位「${f.name}」の幅 ${fmtLen(f.size)} を`;
  if (capped) return make(project, nx, `${base}約 ${cells} セルで分割（${label}・上限のため）`);
  if (floored) return make(project, nx, `${base} ${cells} セルで分割（${label}・最低 ${NX_SOLID_FLOOR} セルを確保）`);
  return make(project, nx, `${base} ${cells} セル以上で分割（${label}）`);
}

/** 材料の比誘電率。未知の材料や未設定は 1 */
function epsRof(materialId: string): number {
  try {
    return getMaterial(materialId).epsR ?? 1;
  } catch {
    return 1;
  }
}

function isConductor(materialId: string): boolean {
  try {
    return getMaterial(materialId).conductor === true;
  } catch {
    return false;
  }
}

/** 電磁波: 媒質中の最短波長を 1波長あたり cellsPerWavelength セルで切る */
function gridByWavelength(project: Project): AutoGrid {
  const { em, domain } = project;
  const f = em.frequencyGHz * 1e9;
  if (!(f > 0) || !(domain.width > 0)) {
    const { nx } = clampNx(project, NX_DEFAULT, NX_MIN, CELLS_MAX_FLOW);
    return make(project, nx, `周波数が不明のため標準の ${nx} セルで分割（電磁波）`);
  }
  // 導体は電場 0 の壁として扱うので波長の計算には入れない
  let epsMax = epsRof(em.mediumId);
  for (const s of project.shapes) {
    if (!isBody(s) || isConductor(s.materialId)) continue;
    epsMax = Math.max(epsMax, epsRof(s.materialId));
  }
  const lambdaMin = LIGHT_SPEED / f / Math.sqrt(epsMax);
  const cpw = em.advanced?.cellsPerWavelength ?? DEFAULT_CELLS_PER_WAVELENGTH;
  const wanted = domain.width / (lambdaMin / cpw);
  const { nx, capped } = clampNx(project, wanted, NX_MIN, CELLS_MAX_FLOW);
  const base = `最短波長 ${fmtLen(lambdaMin)}（εr 最大 ${Number(epsMax.toPrecision(3))}）`;
  if (capped) {
    const actual = Math.max(1, Math.round((lambdaMin * nx) / domain.width));
    return make(project, nx, `${base}を分割。上限のため 1波長あたり約 ${actual} セル（電磁波）`);
  }
  return make(project, nx, `${base}を 1波長あたり ${cpw} セルで分割（電磁波）`);
}

// ---------- 公開関数 ----------

/** 解析ごとに最適な格子を提案する（autoGrid の設定は見ない。手動かどうかは resolveProject が判断する） */
export function autoGrid(project: Project, kind: AnalysisKind): AutoGrid {
  switch (kind) {
    case 'flow':
      return gridByBodyHeight(project, 'flow', FLOW_CELLS_ACROSS);
    case 'scalar':
      return gridByBodyHeight(project, 'scalar', SCALAR_CELLS_ACROSS);
    case 'heat':
      return gridByThinnest(project, 'heat', HEAT_CELLS_ACROSS);
    case 'stress':
      return gridByThinnest(project, 'stress', STRESS_CELLS_ACROSS);
    case 'em':
      return gridByWavelength(project);
  }
}

/**
 * 解析に使うプロジェクトを返す。autoGrid が false でなければ nx を自動で決めた浅いコピー、
 * false なら元の nx のまま（理由は「手動設定」）。
 */
export function resolveProject(project: Project, kind: AnalysisKind): { project: Project; grid: AutoGrid } {
  if (project.domain.autoGrid === false) {
    const nx = project.domain.nx;
    return { project: { ...project, domain: { ...project.domain } }, grid: make(project, nx, '手動設定') };
  }
  const grid = autoGrid(project, kind);
  return { project: { ...project, domain: { ...project.domain, nx: grid.nx } }, grid };
}
