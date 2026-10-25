// 格子（Raster）から CalculiX 用の要素分割を作る。
//
// - 物体セル 1 つ = 平面応力要素 1 つ（CPS4 / CPS4R は 4 節点、CPS8R は辺の中点にも節点）。
// - 節点はセル角。物体に接する節点だけを作り、番号は 1 から詰める。
// - 支持されていない部品（支持のセルにつながっていない連結成分）は、Lite と同じく解析から外す。
// - 荷重は Lite と同じく、セルごとの力を 4 つの角の節点に 1/4 ずつ配る。

import { getMaterial } from '../../../src/core/materials';
import type { Material, Project, Raster } from '../../../src/core/types';
import type { PlaneStressElement } from './options';

export const GRAVITY = 9.80665; // [m/s²]

export interface MeshMaterial {
  /** ccx の中での名前（MAT1, MAT2, ...） */
  name: string;
  material: Material;
  /** この材料の要素番号（1 から） */
  elements: number[];
}

export interface Mesh {
  nx: number;
  ny: number;
  h: number;
  thickness: number;
  elementType: PlaneStressElement;
  nodeCount: number;
  /** 節点 n（1 から）の座標は coords[2(n-1)], coords[2(n-1)+1] [m] */
  coords: Float64Array;
  /** 要素 e（1 から）の節点番号。CPS4 は 4 個、CPS8R は 8 個ずつ並ぶ */
  connectivity: Int32Array;
  nodesPerElement: number;
  /** 要素 e（1 から）が対応するセルの番号。elementCell[e - 1] */
  elementCell: Int32Array;
  /** 解析に含めたセル（1）。結果の mask になる */
  included: Uint8Array;
  materials: MeshMaterial[];
  /** 完全固定する節点（支持セルの要素の全節点） */
  supportNodes: number[];
  /** 節点荷重 [N]。key = 節点番号 */
  nodalLoads: Map<number, { fx: number; fy: number }>;
  /** 角の節点（セルの 4 隅）の番号。要素 e の角は cornerNodes[4(e-1) .. 4(e-1)+3]（左下→右下→右上→左上） */
  cornerNodes: Int32Array;
  /** 質量 [kg]（Lite と同じく、支持されていない部品も含めた物体全体） */
  mass: number;
  /** 解析に含めた荷重の大きさの合計 |fx|+|fy|（自重を除く） */
  appliedLoad: number;
  excludedParts: number;
  excludedCells: number;
  ignoredLoad: number;
  solidCount: number;
  warnings: string[];
}

export class MeshError extends Error {}

/** 辺でつながった物体セルの連結成分に番号を振り、支持を含むかを返す */
function labelComponents(raster: Raster): { comp: Int32Array; supported: boolean[] } {
  const { nx, ny } = raster;
  const n = nx * ny;
  const comp = new Int32Array(n).fill(-1);
  const supported: boolean[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!raster.solid[s] || comp[s] >= 0) continue;
    const id = supported.length;
    let sup = false;
    const push = (c: number): void => {
      if (raster.solid[c] && comp[c] < 0) {
        comp[c] = id;
        stack.push(c);
      }
    };
    push(s);
    while (stack.length > 0) {
      const c = stack.pop() as number;
      if (raster.support[c]) sup = true;
      const i = c % nx;
      const j = (c - i) / nx;
      if (i > 0) push(c - 1);
      if (i < nx - 1) push(c + 1);
      if (j > 0) push(c - nx);
      if (j < ny - 1) push(c + nx);
    }
    supported.push(sup);
  }
  return { comp, supported };
}

export function buildMesh(project: Project, raster: Raster, elementType: PlaneStressElement): Mesh {
  const { nx, ny, h } = raster;
  const t = project.thickness;
  const nCells = nx * ny;
  const nodesX = nx + 1;
  const warnings: string[] = [];

  // ----- 物体の有無・支持の有無 -----
  let solidCount = 0;
  for (let c = 0; c < nCells; c++) if (raster.solid[c]) solidCount++;
  if (solidCount === 0) throw new MeshError('物体がありません。形状（固体）を追加してください。');

  const { comp, supported } = labelComponents(raster);
  const included = new Uint8Array(nCells);
  let excludedCells = 0;
  const excludedComps = new Set<number>();
  let ignoredLoad = 0;
  for (let c = 0; c < nCells; c++) {
    if (!raster.solid[c]) continue;
    if (supported[comp[c]]) included[c] = 1;
    else {
      excludedCells++;
      excludedComps.add(comp[c]);
      ignoredLoad += Math.abs(raster.loadFx[c]) + Math.abs(raster.loadFy[c]);
    }
  }
  const nElem = solidCount - excludedCells;
  if (nElem === 0) {
    throw new MeshError(
      '支持（固定）が設定されていないため、剛体として動いてしまい解けません。物体に重なるように「支持」を置いてください。',
    );
  }
  if (excludedCells > 0) {
    warnings.push(`支持されていない部品があります（${excludedComps.size}個）。その部品は解析から除外しました（結果は表示されません）。`);
    if (ignoredLoad > 0) warnings.push('除外した部品に載っている荷重は無視されています。');
  }

  // ----- 材料 -----
  const matIndex = new Map<string, number>();
  const materials: MeshMaterial[] = [];
  let missingProps = false;
  let mass = 0;
  const cellMat = new Int32Array(nCells).fill(-1);
  for (let c = 0; c < nCells; c++) {
    if (!raster.solid[c]) continue;
    const id = raster.materialId[c] ?? '';
    let mi = matIndex.get(id);
    if (mi === undefined) {
      const m = getMaterial(id);
      if (m.E === undefined || m.nu === undefined) missingProps = true;
      mi = materials.length;
      materials.push({ name: `MAT${mi + 1}`, material: m, elements: [] });
      matIndex.set(id, mi);
    }
    cellMat[c] = mi;
    mass += materials[mi].material.rho * h * h * t;
  }
  if (missingProps) warnings.push('弾性率やポアソン比が未設定の材料があります。仮の値（E = 2 GPa, ν = 0.3）で計算しました。');

  // ----- 節点（物体に接するものだけ。角 → 辺の中点の順に番号を付ける） -----
  const cornerId = new Int32Array(nodesX * (ny + 1)); // 0 = 使わない
  for (let c = 0; c < nCells; c++) {
    if (!included[c]) continue;
    const i = c % nx;
    const j = (c - i) / nx;
    const n0 = j * nodesX + i;
    cornerId[n0] = cornerId[n0 + 1] = cornerId[n0 + nodesX] = cornerId[n0 + nodesX + 1] = 1;
  }
  let nodeCount = 0;
  const coordList: number[] = [];
  for (let jn = 0; jn <= ny; jn++) {
    for (let in_ = 0; in_ <= nx; in_++) {
      const g = jn * nodesX + in_;
      if (!cornerId[g]) continue;
      cornerId[g] = ++nodeCount;
      coordList.push(in_ * h, jn * h);
    }
  }
  // 辺の中点（CPS8R のみ）。水平辺 (i, j): 節点 (i, j)-(i+1, j)、垂直辺 (i, j): 節点 (i, j)-(i, j+1)
  const quad8 = elementType === 'CPS8R';
  const hMid = quad8 ? new Int32Array(nx * (ny + 1)) : null;
  const vMid = quad8 ? new Int32Array(nodesX * ny) : null;
  const midNode = (arr: Int32Array, idx: number, x: number, y: number): number => {
    if (!arr[idx]) {
      arr[idx] = ++nodeCount;
      coordList.push(x, y);
    }
    return arr[idx];
  };

  // ----- 要素 -----
  const nodesPerElement = quad8 ? 8 : 4;
  const connectivity = new Int32Array(nElem * nodesPerElement);
  const cornerNodes = new Int32Array(nElem * 4);
  const elementCell = new Int32Array(nElem);
  const supportSet = new Set<number>();
  let e = 0;
  for (let c = 0; c < nCells; c++) {
    if (!included[c]) continue;
    const i = c % nx;
    const j = (c - i) / nx;
    const n0 = j * nodesX + i;
    const ns = [cornerId[n0], cornerId[n0 + 1], cornerId[n0 + 1 + nodesX], cornerId[n0 + nodesX]];
    const o = e * nodesPerElement;
    for (let a = 0; a < 4; a++) {
      connectivity[o + a] = ns[a];
      cornerNodes[e * 4 + a] = ns[a];
    }
    if (quad8 && hMid && vMid) {
      // 下辺・右辺・上辺・左辺の順
      connectivity[o + 4] = midNode(hMid, j * nx + i, (i + 0.5) * h, j * h);
      connectivity[o + 5] = midNode(vMid, j * nodesX + i + 1, (i + 1) * h, (j + 0.5) * h);
      connectivity[o + 6] = midNode(hMid, (j + 1) * nx + i, (i + 0.5) * h, (j + 1) * h);
      connectivity[o + 7] = midNode(vMid, j * nodesX + i, i * h, (j + 0.5) * h);
    }
    elementCell[e] = c;
    materials[cellMat[c]].elements.push(e + 1);
    if (raster.support[c]) for (let a = 0; a < nodesPerElement; a++) supportSet.add(connectivity[o + a]);
    e++;
  }

  // ----- 荷重（セルごとの力を角の節点に 1/4 ずつ） -----
  const nodalLoads = new Map<number, { fx: number; fy: number }>();
  let appliedLoad = 0;
  for (let k = 0; k < nElem; k++) {
    const c = elementCell[k];
    const fx = raster.loadFx[c] / 4;
    const fy = raster.loadFy[c] / 4;
    appliedLoad += Math.abs(raster.loadFx[c]) + Math.abs(raster.loadFy[c]);
    if (fx === 0 && fy === 0) continue;
    for (let a = 0; a < 4; a++) {
      const n = cornerNodes[k * 4 + a];
      const cur = nodalLoads.get(n);
      if (cur) {
        cur.fx += fx;
        cur.fy += fy;
      } else nodalLoads.set(n, { fx, fy });
    }
  }

  return {
    nx,
    ny,
    h,
    thickness: t,
    elementType,
    nodeCount,
    coords: Float64Array.from(coordList),
    connectivity,
    nodesPerElement,
    elementCell,
    included,
    materials,
    supportNodes: [...supportSet].sort((a, b) => a - b),
    nodalLoads,
    cornerNodes,
    mass,
    appliedLoad,
    excludedParts: excludedComps.size,
    excludedCells,
    ignoredLoad,
    solidCount,
    warnings,
  };
}
