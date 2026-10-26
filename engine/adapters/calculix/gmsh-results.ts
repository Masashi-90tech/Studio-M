// 形に沿ったメッシュ（gmsh + CPS6）の CalculiX の結果を、Lite と同じキー・単位・格子（nx × ny）の ResultSet に戻す。
//
// - 変位: 節点の値を、セルの中心がある要素の形状関数（2 次）で補間する。最大変位は節点の最大値。
// - 応力: 要素の積分点の値を要素ごとの 1 次式に当てはめ（ip.ts）、節点の位置の値に外挿する。
//   節点では、同じ材料の要素どうしで平均して「節点の応力」にする（材料の境目では材料ごとに分ける）。
//   セルの値は、この節点の応力を要素の形状関数で補間する。
//   最大のミーゼス応力・最小の安全率は、格子に補間する前の節点の値から取る
//   （格子のセル中心に補間すると、穴の縁などのピークが削れるため）。
// - 塑性ひずみ: 要素の平均。セルの値は、そのセルがある要素の値。
// - 反力: 格子版と同じ（支持の節点の反力の合計から、支持に直接かかる荷重を引く）。

import type { Field, ResultSet, ScalarValue } from '../../../src/core/types';
import { lastBlock, type DatBlock } from './dat';
import type { ShapedMesh } from './gmsh-mesh';
import { evalFit, readStressFits } from './ip';
import { interpP2 } from './p2';
import { computeReaction, PEEQ_EPS, type MappedResults } from './results';

const SAFETY_CAP = 100; // 表示用の安全率の上限（Lite・格子版と同じ）

const vonMises = (sxx: number, syy: number, sxy: number): number => Math.sqrt(Math.max(0, sxx * sxx - sxx * syy + syy * syy + 3 * sxy * sxy));

export function mapShapedResults(mesh: ShapedMesh, datText: string, blocks: DatBlock[], opts: { plasticity: boolean; loadScale?: number }): MappedResults {
  const { nx, ny } = mesh;
  const nCells = nx * ny;
  const nElem = mesh.elementCount;
  const nNodes = mesh.nodeCount;
  const notes: string[] = [];
  const disp = lastBlock(blocks, 'displacement');
  const fits = readStressFits(datText, nElem);
  if (!disp || !fits) {
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

  // ----- 節点変位 -----
  const ux = new Float64Array(nNodes + 1);
  const uy = new Float64Array(nNodes + 1);
  let maxDisp = 0;
  for (let k = 0; k < disp.ids.length; k++) {
    const n = disp.ids[k];
    if (n < 1 || n > nNodes) continue;
    ux[n] = disp.values[3 * k];
    uy[n] = disp.values[3 * k + 1];
    const d = Math.hypot(ux[n], uy[n]);
    if (d > maxDisp) maxDisp = d;
  }

  // ----- 節点の応力（要素ごとの外挿 → 同じ材料の要素で平均） -----
  const M = mesh.materials.length;
  const sums = [new Float64Array(nNodes * M), new Float64Array(nNodes * M), new Float64Array(nNodes * M)];
  const counts = new Int32Array(nNodes * M);
  for (let e = 0; e < nElem; e++) {
    const mat = mesh.elementMaterial[e];
    for (let a = 0; a < 6; a++) {
      const n = mesh.connectivity[6 * e + a] - 1;
      const x = mesh.coords[2 * n];
      const y = mesh.coords[2 * n + 1];
      const slot = n * M + mat;
      for (let k = 0; k < 3; k++) sums[k][slot] += evalFit(fits, e, k, x, y);
      counts[slot]++;
    }
  }
  const nodal = [new Float64Array(nNodes * M), new Float64Array(nNodes * M), new Float64Array(nNodes * M)];
  const yields = mesh.materials.map((m) => m.material.yield ?? Infinity);
  let maxVm = 0;
  let minSafety = SAFETY_CAP;
  for (let slot = 0; slot < counts.length; slot++) {
    const c = counts[slot];
    if (c === 0) continue;
    for (let k = 0; k < 3; k++) nodal[k][slot] = sums[k][slot] / c;
    const vm = vonMises(nodal[0][slot], nodal[1][slot], nodal[2][slot]);
    if (vm > maxVm) maxVm = vm;
    const safety = vm > 0 ? Math.min(SAFETY_CAP, yields[slot % M] / vm) : SAFETY_CAP;
    if (safety < minSafety) minSafety = safety;
  }

  // ----- 塑性ひずみ（要素の平均） -----
  const peeqE = new Float64Array(nElem);
  let yieldedAreaSum = 0;
  let maxPeeq = 0;
  if (peeq) {
    for (let k = 0; k < peeq.ids.length; k++) {
      const e = peeq.ids[k] - 1;
      if (e < 0 || e >= nElem) continue;
      const v = peeq.values[k];
      peeqE[e] = v;
      if (v > PEEQ_EPS) yieldedAreaSum += mesh.elementArea[e];
      if (v > maxPeeq) maxPeeq = v;
    }
  }
  const yieldedArea = mesh.area > 0 ? yieldedAreaSum / mesh.area : 0;

  // ----- セルの値（セルの中心がある要素の形状関数で補間） -----
  const vS = [new Float64Array(6), new Float64Array(6), new Float64Array(6)];
  const vUx = new Float64Array(6);
  const vUy = new Float64Array(6);
  for (let c = 0; c < nCells; c++) {
    const e = mesh.cellElement[c];
    if (e < 0) continue;
    const mat = mesh.elementMaterial[e];
    for (let a = 0; a < 6; a++) {
      const n = mesh.connectivity[6 * e + a];
      const slot = (n - 1) * M + mat;
      for (let k = 0; k < 3; k++) vS[k][a] = nodal[k][slot];
      vUx[a] = ux[n];
      vUy[a] = uy[n];
    }
    const xi = mesh.cellXi[c];
    const eta = mesh.cellEta[c];
    const sxx = interpP2(vS[0], xi, eta);
    const syy = interpP2(vS[1], xi, eta);
    const sxy = interpP2(vS[2], xi, eta);
    const vm = vonMises(sxx, syy, sxy);
    fVm.data[c] = vm;
    fSxx.data[c] = sxx;
    fSyy.data[c] = syy;
    fSxy.data[c] = sxy;
    fSafety.data[c] = vm > 0 ? Math.min(SAFETY_CAP, yields[mat] / vm) : SAFETY_CAP;
    const mx = interpP2(vUx, xi, eta);
    const my = interpP2(vUy, xi, eta);
    fUx.data[c] = mx;
    fUy.data[c] = my;
    fDisp.data[c] = Math.hypot(mx, my);
    if (fPeeq) fPeeq.data[c] = peeqE[e];
  }

  // ----- 反力 -----
  const { rx, ry, found } = computeReaction(blocks, mesh.supportNodes, mesh.nodalLoads, opts.loadScale ?? 1);
  if (!found) notes.push('支持の反力を結果から読み取れませんでした。');

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
export function toShapedResultSet(mesh: ShapedMesh, mapped: MappedResults, warnings: string[]): ResultSet {
  return { analysis: 'stress', nx: mesh.nx, ny: mesh.ny, h: mesh.h, fields: mapped.fields, scalars: mapped.scalars, history: [], warnings };
}
