// 3D モデルの断面（SliceResult）を、Studio M の Project（2D の板）にする。DOM に依存しない。
//
// 外形 → role 'solid' の polygon、穴 → role 'hole' の polygon。
// shapes は後のものが前を上書きするので、入れ子の深さの浅い順（外形 → 穴 → 穴の中の島 → …）に並べる。
// 単位（mm / m / inch）は m に直す。解析領域は形の外接箱に余白を足したもの（余白は解析の種類で変える）。
import { defaultProject } from '../core/project';
import { getMaterial } from '../core/materials';
import { analysisLabel } from '../core/analyses';
import type { AnalysisKind, Project, Shape } from '../core/types';
import { AXIS_NAMES, UNIT_LABEL, UNIT_TO_M, type LengthUnit } from './types';
import type { SliceResult } from './slice';

export interface BuildOptions {
  slice: SliceResult;
  /** 取り込んだファイル名（プロジェクト名と meta に使う） */
  fileName: string;
  /** 取り込んだあとに開く解析（余白の決め方が変わる） */
  analysis: AnalysisKind;
  /** モデルの単位。省略時 mm */
  unit?: LengthUnit;
  /** 材料の ID（materials.ts の固体）。省略時 al6061 */
  materialId?: string;
  /** 板の厚さ [m]。省略時は、切った軸方向のモデルの長さ */
  thicknessM?: number;
}

export interface BuildResult {
  project: Project;
  /** 実際に使った板の厚さ [m] */
  thicknessM: number;
  /** 断面の外形の大きさ [m] */
  sizeM: { w: number; h: number };
  warnings: string[];
}

export const DEFAULT_MATERIAL_ID = 'al6061';

const FALLBACK_THICKNESS_M = 0.01;

/** 余白 [m]。W・H は形の幅と高さ [m] */
export function domainMargins(analysis: AnalysisKind, W: number, H: number): { left: number; right: number; bottom: number; top: number } {
  if (analysis === 'flow' || analysis === 'scalar') {
    // 流れ: 上流 1 倍・下流 3 倍（形の幅 W を基準）、上下は 1 倍（高さ H を基準。平たい形でも W の 1/4 は確保する）
    const side = Math.max(H, 0.25 * W);
    return { left: W, right: 3 * W, bottom: side, top: side };
  }
  // 電磁波は波が回り込む分だけ広めに、熱・強度は少しだけ
  const pad = (analysis === 'em' ? 0.15 : 0.05) * Math.max(W, H);
  return { left: pad, right: pad, bottom: pad, top: pad };
}

function baseName(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').replace(/\.(stl|obj)$/i, '').replace(/（サンプル）$/, '');
  return base || '3D モデル';
}

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

export function buildMeshProject(opts: BuildOptions): BuildResult {
  const { slice, analysis } = opts;
  const unit = opts.unit ?? 'mm';
  const s = UNIT_TO_M[unit];
  const materialId = opts.materialId ?? DEFAULT_MATERIAL_ID;
  getMaterial(materialId); // 未知の材料はここで Error にする
  if (!slice.bounds2d || slice.loops.length === 0) {
    throw new Error('断面が空なので、プロジェクトを作れません。モデルの内側で切る位置を選び直してください。');
  }
  const [u0, v0, u1, v1] = slice.bounds2d;
  const W = (u1 - u0) * s;
  const H = (v1 - v0) * s;
  const m = domainMargins(analysis, W, H);

  const axisLen = (slice.axisRange[1] - slice.axisRange[0]) * s;
  const thicknessM = opts.thicknessM !== undefined && opts.thicknessM > 0 ? opts.thicknessM : axisLen > 0 ? axisLen : FALLBACK_THICKNESS_M;

  const posLabel = `${AXIS_NAMES[slice.axis]} = ${fmt(slice.position)} ${UNIT_LABEL[unit]}`;
  const meta = (depth: number): Record<string, string> => ({
    source: opts.fileName,
    axis: AXIS_NAMES[slice.axis],
    position: fmt(slice.position),
    unit,
    depth: String(depth),
  });

  const shapes: Shape[] = [];
  let solids = 0;
  let holes = 0;
  for (const loop of slice.loops) {
    const points = loop.points.map(([u, v]): [number, number] => [(u - u0) * s + m.left, (v - v0) * s + m.bottom]);
    if (loop.hole) {
      holes++;
      shapes.push({ id: `mesh-hole-${holes}`, name: `穴 ${holes}`, role: 'hole', materialId, geom: { kind: 'polygon', points }, meta: meta(loop.depth) });
    } else {
      solids++;
      shapes.push({ id: `mesh-solid-${solids}`, name: solids === 1 ? '外形' : `外形 ${solids}`, role: 'solid', materialId, geom: { kind: 'polygon', points }, meta: meta(loop.depth) });
    }
  }

  const width = m.left + W + m.right;
  const height = m.bottom + H + m.top;
  const project = defaultProject();
  project.name = `${baseName(opts.fileName)}（${posLabel} の断面）`;
  project.domain = { width, height, nx: 200, autoGrid: true };
  project.thickness = thicknessM;
  project.shapes = shapes;
  // 電磁波の点波源は、領域の左 1/4・中央の高さに置いておく（プリセットと同じ）
  project.em = { ...project.em, pointX: width * 0.25, pointY: height * 0.5 };

  const warnings: string[] = [...slice.warnings];
  if (analysis === 'stress') warnings.push(`${analysisLabel('stress')}解析では、固定する場所と荷重を自分で足してください（図形の役割「支持」「荷重」を選んで描きます）。`);
  if (analysis === 'heat') warnings.push(`${analysisLabel('heat')}解析では、熱源か固定温度を自分で足してください（図形の役割「発熱体」「温度固定」を選んで描きます）。`);

  return { project, thicknessM, sizeM: { w: W, h: H }, warnings };
}
