// 熱解析の結果（.dat のブロック）を、Lite と同じキー・単位の ResultSet に戻す。
//
// - 温度: セルの 8 つの節点の平均（セル中心の値）。物体のないセルは周囲温度（固定温度セルはその値）
// - 熱流束: 要素の積分点の平均の面内成分の大きさ √(qx² + qy²) [W/m²]
// - 放熱量: 表裏・側面の膜（*FILM）から出る熱 + 固定温度の節点から出る熱（定常なら発熱量に一致する）

import { getMaterial } from '../../../src/core/materials';
import type { Field, Project, Raster, ResultSet, ScalarValue, ShapeResult } from '../../../src/core/types';
import { lastBlock, type DatBlock } from './dat';
import { FACE_NODES, type HeatMesh } from './heat-mesh';

export interface HeatMapped {
  fields: Field[];
  scalars: ScalarValue[];
  perShape?: ShapeResult[];
  totalHeat: number;
  heatOut: number;
  notes: string[];
}

function materialLimit(materialId: string): number | undefined {
  try {
    return getMaterial(materialId).maxTempC;
  } catch {
    return undefined;
  }
}

export function mapHeatResults(opts: { project: Project; raster: Raster; mesh: HeatMesh; blocks: DatBlock[] }): HeatMapped {
  const { project, raster, mesh, blocks } = opts;
  const { nx, ny, h } = mesh;
  const n = nx * ny;
  const amb = project.heat.ambientC;
  const notes: string[] = [];
  const tBlock = lastBlock(blocks, 'temperature');
  if (!tBlock) throw new Error('CalculiX の結果ファイルから温度を読み取れませんでした。計算が途中で止まった可能性があります（ログを確認してください）。');

  const nodeT = new Float64Array(mesh.nodeCount + 1);
  for (let k = 0; k < tBlock.ids.length; k++) {
    const id = tBlock.ids[k];
    if (id >= 1 && id <= mesh.nodeCount) nodeT[id] = tBlock.values[k];
  }

  // ----- 温度場 -----
  const temp = new Float64Array(n);
  const tData = new Float32Array(n);
  const mask = mesh.included;
  for (let c = 0; c < n; c++) temp[c] = Number.isNaN(raster.fixedTemp[c]) ? amb : raster.fixedTemp[c];
  const nElem = mesh.elementCell.length;
  for (let e = 0; e < nElem; e++) {
    let sum = 0;
    for (let a = 0; a < 8; a++) sum += nodeT[mesh.connectivity[8 * e + a]];
    temp[mesh.elementCell[e]] = sum / 8;
  }
  for (let c = 0; c < n; c++) tData[c] = temp[c];

  // ----- 熱流束（面内） -----
  const flux = new Float32Array(n);
  const hf = lastBlock(blocks, 'heatFlux');
  if (hf) {
    for (let k = 0; k < hf.ids.length; k++) {
      const e = hf.ids[k] - 1;
      if (e >= 0 && e < nElem) flux[mesh.elementCell[e]] = Math.hypot(hf.values[3 * k], hf.values[3 * k + 1]);
    }
  } else notes.push('熱流束を結果から読み取れませんでした。');

  // ----- 統計 -----
  let tMax = -Infinity;
  let tMin = Infinity;
  let tSum = 0;
  let count = 0;
  for (let c = 0; c < n; c++) {
    if (!mask[c]) continue;
    if (temp[c] > tMax) tMax = temp[c];
    if (temp[c] < tMin) tMin = temp[c];
    tSum += temp[c];
    count++;
  }
  if (count === 0) {
    tMax = tMin = tSum = amb;
    count = 1;
  }

  // ----- 放熱量 -----
  // 膜から出る熱: h × 面積 × (面の 4 節点の平均温度 − 周囲)。側面の面積は h·t、表裏は h²
  let heatOut = 0;
  for (const g of mesh.films) {
    const area = g.face <= 2 ? h * h : h * mesh.thickness;
    for (const el of g.elements) {
      const e = el - 1;
      let s = 0;
      for (const a of FACE_NODES[g.face - 1]) s += nodeT[mesh.connectivity[8 * e + a]];
      heatOut += g.h * area * (s / 4 - g.sink);
    }
  }
  // 固定温度の節点から出る熱（ccx の RFL は、熱が出ていくとき負）
  const rfl = lastBlock(blocks, 'totalHeat', 'NFIX');
  if (mesh.fixedNodes.size > 0 && !rfl) notes.push('固定温度の節点の熱の出入りを結果から読み取れませんでした。');
  heatOut -= rfl?.values[0] ?? 0;

  const totalHeat = mesh.totalHeat;
  const fields: Field[] = [
    { key: 'temperature', label: '温度', unit: '°C', data: tData, mask },
    { key: 'heatFlux', label: '熱流束', unit: 'W/m²', data: flux, mask },
  ];
  const scalars: ScalarValue[] = [
    { key: 'maxTemp', label: '最高温度', unit: '°C', value: tMax },
    { key: 'minTemp', label: '最低温度', unit: '°C', value: tMin },
    { key: 'avgTemp', label: '平均温度', unit: '°C', value: tSum / count },
    { key: 'totalHeat', label: '総発熱量', unit: 'W', value: totalHeat },
    { key: 'heatOut', label: '放熱量', unit: 'W', value: heatOut },
    { key: 'elementCount', label: '要素数', unit: '個', value: nElem },
  ];
  return { fields, scalars, perShape: buildPerShape(project, raster, temp, mask), totalHeat, heatOut, notes };
}

/**
 * 部品ごとの結果（Lite と同じ）: 発熱体と、上限温度（shape.maxTempC）を持つ形状について、最高・平均温度、発熱、余裕。
 * raster.shapeIndex がなければ出さない。上限は shape.maxTempC ?? 材料の maxTempC
 */
function buildPerShape(project: Project, raster: Raster, temp: Float64Array, mask: Uint8Array): ShapeResult[] | undefined {
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
    if (!mask[c]) continue;
    const acc = wanted.get(shapeIndex[c]);
    if (!acc) continue;
    if (temp[c] > acc.max) acc.max = temp[c];
    acc.sum += temp[c];
    acc.heat += heatGen[c] * volume;
    acc.count += 1;
  }
  const out: ShapeResult[] = [];
  for (const [i, acc] of wanted) {
    if (acc.count === 0) continue;
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

export function toHeatResultSet(mesh: HeatMesh, mapped: HeatMapped, warnings: string[]): ResultSet {
  return {
    analysis: 'heat',
    nx: mesh.nx,
    ny: mesh.ny,
    h: mesh.h,
    fields: mapped.fields,
    scalars: mapped.scalars,
    history: [],
    warnings,
    perShape: mapped.perShape,
  };
}
