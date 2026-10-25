// CalculiX の結果（.dat を読んだブロック）を、Lite と同じキー・単位の ResultSet に戻す。
//
// - 応力: 要素の積分点の平均（= セル中心の値）。ミーゼス応力は平面応力の式 √(σx² − σxσy + σy² + 3τxy²)
//   （Lite と同じ）。CalculiX の σz は平面応力ではほぼ 0 になる。
// - 変位: セルの 4 つの角の節点の平均（Lite と同じ）。最大変位は節点の最大値。
// - 反力: 支持の節点での反力の合計（ベクトルの大きさ）。

import type { Field, ResultSet, ScalarValue } from '../../../src/core/types';
import { lastBlock, type DatBlock } from './dat';
import type { Mesh } from './mesh';

const SAFETY_CAP = 100; // 表示用の安全率の上限（Lite と同じ）
/** これより大きい相当塑性ひずみを「降伏した」とみなす（数値の誤差を除く） */
export const PEEQ_EPS = 1e-8;

export interface MappedResults {
  fields: Field[];
  scalars: ScalarValue[];
  /** 結果の読み取りで気づいたこと（利用者向けの警告） */
  notes: string[];
  maxVonMises: number;
  minSafety: number;
  yieldedArea: number;
}

export function mapResults(mesh: Mesh, blocks: DatBlock[], opts: { plasticity: boolean }): MappedResults {
  const { nx, ny } = mesh;
  const nCells = nx * ny;
  const notes: string[] = [];
  const stress = lastBlock(blocks, 'stress');
  const disp = lastBlock(blocks, 'displacement');
  if (!stress || !disp) {
    throw new Error('CalculiX の結果ファイルから応力や変位を読み取れませんでした。計算が途中で止まった可能性があります（ログを確認してください）。');
  }
  const peeq = opts.plasticity ? lastBlock(blocks, 'plasticStrain') : undefined;
  if (opts.plasticity && !peeq) notes.push('塑性ひずみを結果から読み取れませんでした。');

  const mk = (key: string, label: string, unit: string, diverging = false): Field => ({
    key,
    label,
    unit,
    data: new Float32Array(nCells),
    mask: mesh.included,
    diverging: diverging || undefined,
  });
  const fVm = mk('vonMises', 'ミーゼス応力', 'Pa');
  const fDisp = mk('displacement', '変位', 'm');
  const fSxx = mk('sxx', '応力σx', 'Pa', true);
  const fSyy = mk('syy', '応力σy', 'Pa', true);
  const fSxy = mk('sxy', 'せん断応力τxy', 'Pa', true);
  const fSafety = mk('safety', '安全率', '');
  const fUx = mk('ux', 'x方向変位', 'm', true);
  const fUy = mk('uy', 'y方向変位', 'm', true);
  const fPeeq = peeq ? mk('plasticStrain', '相当塑性ひずみ', '') : undefined;

  // 材料の降伏応力を要素ごとに引く
  const yieldOf = new Float64Array(mesh.elementCell.length).fill(Infinity);
  for (const m of mesh.materials) {
    const y = m.material.yield ?? Infinity;
    for (const e of m.elements) yieldOf[e - 1] = y;
  }

  // 節点変位
  const ux = new Float64Array(mesh.nodeCount + 1);
  const uy = new Float64Array(mesh.nodeCount + 1);
  let maxDisp = 0;
  for (let k = 0; k < disp.ids.length; k++) {
    const n = disp.ids[k];
    if (n < 1 || n > mesh.nodeCount) continue;
    ux[n] = disp.values[3 * k];
    uy[n] = disp.values[3 * k + 1];
    const d = Math.hypot(ux[n], uy[n]);
    if (d > maxDisp) maxDisp = d;
  }

  let maxVm = 0;
  let minSafety = SAFETY_CAP;
  for (let k = 0; k < stress.ids.length; k++) {
    const e = stress.ids[k] - 1;
    if (e < 0 || e >= mesh.elementCell.length) continue;
    const c = mesh.elementCell[e];
    const sxx = stress.values[6 * k];
    const syy = stress.values[6 * k + 1];
    const sxy = stress.values[6 * k + 3];
    const vm = Math.sqrt(Math.max(0, sxx * sxx - sxx * syy + syy * syy + 3 * sxy * sxy));
    const safety = vm > 0 ? Math.min(SAFETY_CAP, yieldOf[e] / vm) : SAFETY_CAP;
    fVm.data[c] = vm;
    fSxx.data[c] = sxx;
    fSyy.data[c] = syy;
    fSxy.data[c] = sxy;
    fSafety.data[c] = safety;
    if (vm > maxVm) maxVm = vm;
    if (safety < minSafety) minSafety = safety;
    // 変位はセルの 4 つの角の平均
    let mx = 0;
    let my = 0;
    for (let a = 0; a < 4; a++) {
      const n = mesh.cornerNodes[e * 4 + a];
      mx += ux[n];
      my += uy[n];
    }
    mx /= 4;
    my /= 4;
    fUx.data[c] = mx;
    fUy.data[c] = my;
    fDisp.data[c] = Math.hypot(mx, my);
  }

  let yielded = 0;
  let maxPeeq = 0;
  if (peeq && fPeeq) {
    for (let k = 0; k < peeq.ids.length; k++) {
      const e = peeq.ids[k] - 1;
      if (e < 0 || e >= mesh.elementCell.length) continue;
      const v = peeq.values[k];
      fPeeq.data[mesh.elementCell[e]] = v;
      if (v > PEEQ_EPS) yielded++;
      if (v > maxPeeq) maxPeeq = v;
    }
  }
  const nElem = mesh.elementCell.length;
  const yieldedArea = nElem > 0 ? yielded / nElem : 0;

  // 反力
  const rf = lastBlock(blocks, 'totalForce', 'NSUP');
  const rx = rf?.values[0] ?? 0;
  const ry = rf?.values[1] ?? 0;
  if (!rf) notes.push('支持の反力を結果から読み取れませんでした。');

  const scalars: ScalarValue[] = [
    { key: 'maxVonMises', label: '最大ミーゼス応力', unit: 'Pa', value: maxVm },
    { key: 'maxDisplacement', label: '最大変位', unit: 'm', value: maxDisp },
    { key: 'minSafety', label: '最小安全率', unit: '', value: minSafety },
    { key: 'mass', label: '質量', unit: 'kg', value: mesh.mass },
    { key: 'reaction', label: '反力合計', unit: 'N', value: Math.hypot(rx, ry) },
    { key: 'elementCount', label: '要素数', unit: '個', value: nElem },
  ];
  if (peeq) {
    scalars.push(
      { key: 'yieldedArea', label: '降伏した面積の割合', unit: '', value: yieldedArea },
      { key: 'maxPlasticStrain', label: '最大の相当塑性ひずみ', unit: '', value: maxPeeq },
    );
  }

  const fields = [fVm, fDisp, fSxx, fSyy, fSxy, fSafety, fUx, fUy];
  if (fPeeq) fields.push(fPeeq);
  return { fields, scalars, notes, maxVonMises: maxVm, minSafety, yieldedArea };
}

/** 結果を ResultSet にまとめる（warnings は呼び出し側で作る） */
export function toResultSet(mesh: Mesh, mapped: MappedResults, warnings: string[]): ResultSet {
  return {
    analysis: 'stress',
    nx: mesh.nx,
    ny: mesh.ny,
    h: mesh.h,
    fields: mapped.fields,
    scalars: mapped.scalars,
    history: [],
    warnings,
  };
}
