// 取り込んだ 3D モデルを、3D 解析の検討（Study3D）にする。DOM に依存しない。
//
// 形は、ダイアログで選んだ単位を m に直した三角形メッシュ。材料・ファイル名から名前と取り込み元を決める。
// 面の条件はまだ空で、解析の画面（src/sim3d）で面を選んで足す。
import { GRID3D_DEFAULT_MAX_CELLS } from '../core/grid3d';
import { getMaterial } from '../core/materials';
import type { Study3D } from '../core/types';
import { DEFAULT_MATERIAL_ID, baseName } from './build';
import { UNIT_TO_M, type LengthUnit, type TriMesh } from './types';

/** 周囲の温度の既定 [°C] */
export const STUDY3D_DEFAULT_AMBIENT_C = 25;
/** 条件を置いていない面の熱伝達率の既定 [W/(m²·K)]（自然対流の目安） */
export const STUDY3D_DEFAULT_SURFACE_H = 8;

export interface BuildStudy3DOptions {
  mesh: TriMesh;
  /** 取り込んだファイル名（名前と取り込み元に使う） */
  fileName: string;
  /** モデルの単位。省略時 mm */
  unit?: LengthUnit;
  /** 材料の ID（materials.ts の固体）。省略時 al6061 */
  materialId?: string;
}

/** メッシュを m 単位に直して Study3D（熱）を作る。元のメッシュは書き換えない */
export function buildStudy3D(opts: BuildStudy3DOptions): Study3D {
  const s = UNIT_TO_M[opts.unit ?? 'mm'];
  const materialId = opts.materialId ?? DEFAULT_MATERIAL_ID;
  getMaterial(materialId); // 未知の材料は Error にする
  const src = opts.mesh;
  const positions = new Float32Array(src.positions.length);
  for (let i = 0; i < positions.length; i++) positions[i] = src.positions[i] * s;
  return {
    version: 1,
    name: baseName(opts.fileName),
    analysis: 'heat',
    mesh: { positions, indices: new Uint32Array(src.indices) },
    materialId,
    source: opts.fileName,
    regions: [],
    heat: { ambientC: STUDY3D_DEFAULT_AMBIENT_C, surfaceH: STUDY3D_DEFAULT_SURFACE_H },
    stress: { selfWeight: true },
    grid: { maxCells: GRID3D_DEFAULT_MAX_CELLS },
  };
}
