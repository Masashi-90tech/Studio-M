// プロジェクトの複製・検証・UI 用の定数。純粋関数だけを置く。
import { MATERIALS } from '../core/materials';
import { defaultProject, newShapeId } from '../core/project';
import type { AnalysisKind, EdgeBC, Project, Shape, ShapeGeom, ShapeRole } from '../core/types';
import { geomBBox, type Pt } from './geometry';

export const ROLE_LABELS: Record<ShapeRole, string> = {
  solid: '物体',
  heatSource: '発熱体',
  hole: '穴',
  fixedTemp: '温度固定',
  support: '支持',
  load: '荷重',
};

export const ROLE_HINTS: Record<ShapeRole, string> = {
  solid: '材料でできた部品。流れでは障害物、熱では伝導体、強度では解析する部品になります',
  heatSource: '物体であり、指定したワット数で発熱します（熱の解析）',
  hole: '重なった部分の物体を削ります（穴あけ）',
  fixedTemp: '重ねた範囲の温度を固定します（熱の解析）。ヒーターや氷水に',
  support: '壁やネジ止めなど、動かない面（強度の解析）',
  load: '物体に力を加える範囲（強度の解析）。合計の力を均等にかけます',
};

export const ROLES: ShapeRole[] = ['solid', 'heatSource', 'hole', 'fixedTemp', 'support', 'load'];

export const ANALYSIS_LABELS: Record<AnalysisKind, string> = {
  flow: '流れ',
  heat: '熱',
  stress: '強度',
  scalar: '対流拡散',
};

export const ANALYSES: AnalysisKind[] = ['flow', 'heat', 'stress', 'scalar'];

export function roleUsesMaterial(role: ShapeRole): boolean {
  return role === 'solid' || role === 'heatSource';
}

export function solidMaterials() {
  return MATERIALS.filter((m) => m.kind === 'solid');
}

export function fluidMaterials() {
  return MATERIALS.filter((m) => m.kind === 'fluid');
}

export function cloneProject(p: Project): Project {
  return JSON.parse(JSON.stringify(p)) as Project;
}

/** 役割に必要な数値が未設定なら初期値を入れる（役割を切り替えたときなど） */
export function ensureRoleDefaults(s: Shape): void {
  if (s.role === 'heatSource' && s.heatW === undefined) s.heatW = 5;
  if (s.role === 'fixedTemp' && s.tempC === undefined) s.tempC = 80;
  if (s.role === 'load' && !s.force) s.force = { fx: 0, fy: -10 };
  if (roleUsesMaterial(s.role) && !MATERIALS.some((m) => m.id === s.materialId && m.kind === 'solid')) s.materialId = 'al6061';
}

/** 「物体 2」のような重ならない名前 */
export function nextShapeName(project: Project, role: ShapeRole): string {
  const base = ROLE_LABELS[role];
  let n = project.shapes.filter((s) => s.role === role).length + 1;
  const names = new Set(project.shapes.map((s) => s.name));
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Excel数式ブック用: 格子を最大 maxNx × maxNy に収めたときの nx */
export function formulaGridNx(width: number, height: number, currentNx: number, maxNx = 120, maxNy = 80): number {
  let nx = Math.max(10, Math.min(currentNx, maxNx));
  while (nx > 10 && Math.max(1, Math.round(height / (width / nx))) > maxNy) nx--;
  return nx;
}

/** 数式ブック用に、格子を粗くしたプロジェクトの複製を作る */
export function projectForFormula(p: Project): Project {
  const c = cloneProject(p);
  c.domain.nx = formulaGridNx(c.domain.width, c.domain.height, c.domain.nx);
  return c;
}

/** ファイル名に使えない文字を除く */
export function safeFileName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'studio-m';
}

/** 流れの代表長さ: 物体全体の上下方向の幅（なければ領域高さの 1/5） */
export function characteristicLength(p: Project): number {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const s of p.shapes) {
    if (s.role !== 'solid' && s.role !== 'heatSource') continue;
    const b = geomBBox(s.geom);
    y0 = Math.min(y0, b.y0);
    y1 = Math.max(y1, b.y1);
  }
  return y1 > y0 ? y1 - y0 : p.domain.height / 5;
}

// ---------- JSON 読み込み時の検証 ----------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOr = (v: unknown, d: number): number => (isNum(v) ? v : d);
const boolOr = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function sanitizeEdge(v: unknown, d: EdgeBC): EdgeBC {
  if (!isObj(v)) return d;
  if (v.type === 'temp') return { type: 'temp', tempC: numOr(v.tempC, 25) };
  if (v.type === 'convection') return { type: 'convection', h: Math.max(0, numOr(v.h, 10)) };
  return { type: 'adiabatic' };
}

function sanitizeGeom(v: unknown): ShapeGeom | null {
  if (!isObj(v)) return null;
  if (v.kind === 'rect' && isNum(v.x) && isNum(v.y) && isNum(v.w) && isNum(v.h) && v.w > 0 && v.h > 0) {
    return { kind: 'rect', x: v.x, y: v.y, w: v.w, h: v.h };
  }
  if (v.kind === 'circle' && isNum(v.cx) && isNum(v.cy) && isNum(v.r) && v.r > 0) {
    return { kind: 'circle', cx: v.cx, cy: v.cy, r: v.r };
  }
  if (v.kind === 'polygon' && Array.isArray(v.points) && v.points.length >= 3) {
    const pts: Pt[] = [];
    for (const p of v.points) {
      if (Array.isArray(p) && isNum(p[0]) && isNum(p[1])) pts.push([p[0], p[1]]);
    }
    return pts.length >= 3 ? { kind: 'polygon', points: pts } : null;
  }
  return null;
}

function sanitizeShape(v: unknown, index: number): Shape | null {
  if (!isObj(v)) return null;
  const geom = sanitizeGeom(v.geom);
  if (!geom) return null;
  const role = ROLES.includes(v.role as ShapeRole) ? (v.role as ShapeRole) : 'solid';
  const s: Shape = {
    id: typeof v.id === 'string' && v.id ? v.id : newShapeId(),
    name: typeof v.name === 'string' && v.name ? v.name : `${ROLE_LABELS[role]} ${index + 1}`,
    geom,
    role,
    materialId: typeof v.materialId === 'string' ? v.materialId : 'al6061',
  };
  if (isNum(v.heatW)) s.heatW = v.heatW;
  if (isNum(v.tempC)) s.tempC = v.tempC;
  if (isObj(v.force) && isNum(v.force.fx) && isNum(v.force.fy)) s.force = { fx: v.force.fx, fy: v.force.fy };
  ensureRoleDefaults(s);
  return s;
}

/** JSON から読んだ値を Project として安全に取り込む。壊れていれば null */
export function sanitizeProject(raw: unknown): Project | null {
  if (!isObj(raw) || !isObj(raw.domain)) return null;
  const base = defaultProject();
  const w = raw.domain.width;
  const hh = raw.domain.height;
  if (!isNum(w) || !isNum(hh) || w <= 0 || hh <= 0) return null;
  if (!Array.isArray(raw.shapes)) return null;

  const flow = isObj(raw.flow) ? raw.flow : {};
  const heat = isObj(raw.heat) ? raw.heat : {};
  const edges = isObj(heat.edges) ? heat.edges : {};
  const stress = isObj(raw.stress) ? raw.stress : {};
  const scalar = isObj(raw.scalar) ? raw.scalar : {};

  const fluidIds = fluidMaterials().map((m) => m.id);
  const shapes = raw.shapes.map((s, i) => sanitizeShape(s, i)).filter((s): s is Shape => s !== null);

  return {
    version: 1,
    name: typeof raw.name === 'string' && raw.name ? raw.name : '無題',
    domain: { width: w, height: hh, nx: Math.round(Math.min(800, Math.max(20, numOr(raw.domain.nx, base.domain.nx)))) },
    thickness: isNum(raw.thickness) && raw.thickness > 0 ? raw.thickness : base.thickness,
    shapes,
    flow: {
      fluidId: fluidIds.includes(flow.fluidId as string) ? (flow.fluidId as string) : base.flow.fluidId,
      inletVelocity: Math.max(0, numOr(flow.inletVelocity, base.flow.inletVelocity)),
      walls: flow.walls === 'noslip' ? 'noslip' : 'slip',
    },
    heat: {
      ambientC: numOr(heat.ambientC, base.heat.ambientC),
      surfaceH: Math.max(0, numOr(heat.surfaceH, base.heat.surfaceH)),
      faceCooling: boolOr(heat.faceCooling, base.heat.faceCooling),
      edges: {
        left: sanitizeEdge(edges.left, base.heat.edges.left),
        right: sanitizeEdge(edges.right, base.heat.edges.right),
        top: sanitizeEdge(edges.top, base.heat.edges.top),
        bottom: sanitizeEdge(edges.bottom, base.heat.edges.bottom),
      },
    },
    stress: { selfWeight: boolOr(stress.selfWeight, base.stress.selfWeight) },
    scalar: {
      u: numOr(scalar.u, base.scalar.u),
      gamma: Math.max(1e-12, numOr(scalar.gamma, base.scalar.gamma)),
      rho: Math.max(1e-12, numOr(scalar.rho, base.scalar.rho)),
      phiInlet: numOr(scalar.phiInlet, base.scalar.phiInlet),
      phiBody: numOr(scalar.phiBody, base.scalar.phiBody),
    },
  };
}
