// 部品ごとの温度の集計（熱解析と、流れ＋熱の連成で共通）。
//
// 発熱体（role: heatSource）と、上限温度（shape.maxTempC）を持つ形状について、最高・平均温度・発熱・余裕を出す。
// raster.shapeIndex がなければ出さない。上限は shape.maxTempC ?? 材料の maxTempC。
// key と値の並びは ResultSet.perShape の約束（maxTemp / avgTemp / heatW / limitC / marginC）で、
// 画面の部品ごとの表（workbench/panels/heat-results.ts）が読む。

import { getMaterial } from '../core/materials';
import type { Project, Raster, ScalarValue, ShapeResult } from '../core/types';

/** 材料の使用上限の目安 [°C]（なければ undefined） */
export function materialLimit(materialId: string): number | undefined {
  try {
    return getMaterial(materialId).maxTempC;
  } catch {
    return undefined;
  }
}

export interface PartTempOptions {
  project: Project;
  raster: Raster;
  /** セルごとの温度 [°C]（長さ nx * ny） */
  temp: ArrayLike<number>;
  /** 1 = 温度が有効なセル（物体のセル）。0 のセルは集計しない */
  valid: Uint8Array;
}

/** 部品ごとの結果を作る。出す対象の部品がなければ（または raster.shapeIndex がなければ）undefined */
export function buildPartTemps(opts: PartTempOptions): ShapeResult[] | undefined {
  const { project, raster, temp, valid } = opts;
  const { shapeIndex, heatGen, h } = raster;
  if (!shapeIndex) return undefined;
  const shapes = project.shapes;
  const volume = h * h * project.thickness;
  const wanted = new Map<number, { max: number; sum: number; heat: number; count: number }>();
  shapes.forEach((s, i) => {
    if (s.role === 'heatSource' || s.maxTempC !== undefined) wanted.set(i, { max: -Infinity, sum: 0, heat: 0, count: 0 });
  });
  if (wanted.size === 0) return undefined;
  for (let c = 0; c < shapeIndex.length; c++) {
    if (!valid[c]) continue;
    const acc = wanted.get(shapeIndex[c]);
    if (!acc) continue;
    if (temp[c] > acc.max) acc.max = temp[c];
    acc.sum += temp[c];
    acc.heat += heatGen[c] * volume;
    acc.count += 1;
  }
  const out: ShapeResult[] = [];
  for (const [i, acc] of wanted) {
    if (acc.count === 0) continue; // 後から重ねた形に隠れた、または温度が定まらない
    const shape = shapes[i];
    const values: ScalarValue[] = [
      { key: 'maxTemp', label: '最高温度', unit: '°C', value: acc.max },
      { key: 'avgTemp', label: '平均温度', unit: '°C', value: acc.sum / acc.count },
      { key: 'heatW', label: '発熱', unit: 'W', value: acc.heat },
    ];
    const limit = shape.maxTempC ?? materialLimit(shape.materialId);
    if (limit !== undefined) {
      values.push({ key: 'limitC', label: '上限温度', unit: '°C', value: limit });
      values.push({ key: 'marginC', label: '余裕（上限 − 最高）', unit: 'K', value: limit - acc.max });
    }
    out.push({ shapeId: shape.id, label: shape.name, values });
  }
  return out;
}
