// gmsh のメッシュ（2 次の三角形）から、CalculiX 用のメッシュを作る。格子版（mesh.ts）の「形に沿った」版。
//
// - 要素の中心の点で、物体か（最後に塗った solid / heatSource）・どの材料か・領域の中か・支持や荷重の範囲かを判定する
//   （gmsh のメッシュは、形の境目にぴったり合わせて作ってあるので、中心の判定が要素全体の判定になる。gmsh/shapes.ts）。
// - 支持の範囲の要素の全節点を完全固定する（格子版と同じ意味）。支持されていない部品（支持につながらない連結成分）は、
//   格子版と同じく解析から外す。
// - 荷重は、荷重の範囲の中の要素に、面積に比例して合計荷重を配る（格子版が「範囲の中のセルに均等」なのと同じ意味）。
//   要素の中では、一様な体積力と等価な節点荷重（角 0、辺の中点 1/3）にする。自重も同じ配り方。
// - 結果を Lite と同じ格子（nx × ny）に戻すための対応（各セルの中心がどの要素のどこにあるか）も、ここで作る。

import { getMaterial } from '../../../src/core/materials';
import { containsPoint } from '../../../src/core/raster';
import type { Project } from '../../../src/core/types';
import type { GmshMesh } from '../gmsh/msh';
import { bodyShapeAt, inDomain } from '../gmsh/shapes';
import { areaP2, insideTriangle, locateP2 } from './p2';
import { GRAVITY, MeshError, type MeshMaterial } from './mesh';

export interface ShapedMesh {
  /** 結果の格子（Lite と同じ） */
  nx: number;
  ny: number;
  h: number;
  thickness: number;
  elementType: 'CPS6';
  nodeCount: number;
  /** 節点 n（1 から）の座標は coords[2(n-1)], coords[2(n-1)+1] [m] */
  coords: Float64Array;
  /** 要素 e（1 から）の 6 節点（角 3 → 辺 1-2・2-3・3-1 の中点）。connectivity[6(e-1) .. 6(e-1)+5]（節点番号は 1 から） */
  connectivity: Int32Array;
  nodesPerElement: 6;
  elementCount: number;
  /** 要素 e（0 から）の材料の番号（materials の添字）と面積 [m²] */
  elementMaterial: Int32Array;
  elementArea: Float64Array;
  materials: MeshMaterial[];
  supportNodes: number[];
  nodalLoads: Map<number, { fx: number; fy: number }>;
  /** 解析に含めたセル（セルの中心がどれかの要素の中にある）。結果の mask になる */
  included: Uint8Array;
  /** セル c のある要素（0 から。なければ -1）と、その中での局所座標 (ξ, η) */
  cellElement: Int32Array;
  cellXi: Float64Array;
  cellEta: Float64Array;
  /** 質量 [kg]（支持されていない部品も含めた物体全体） */
  mass: number;
  /** 物体の面積 [m²]（解析に含めた要素の合計） */
  area: number;
  appliedLoad: number;
  excludedParts: number;
  excludedElements: number;
  ignoredLoad: number;
  warnings: string[];
}

export interface BuildShapedMeshOptions {
  project: Project;
  gmsh: GmshMesh;
  /** 結果の格子 */
  grid: { nx: number; ny: number; h: number };
  /** 自重を節点荷重として入れる（重力は -y 方向）。省略時は入れない */
  selfWeight?: boolean;
}

/** 辺でつながった要素（角の節点を共有する）の連結成分に番号を振る */
function labelComponents(tri: Int32Array, kept: number[], nodeCount: number): { comp: Int32Array; count: number } {
  const parent = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const e of kept) {
    union(tri[6 * e], tri[6 * e + 1]);
    union(tri[6 * e], tri[6 * e + 2]);
  }
  const rootId = new Map<number, number>();
  const comp = new Int32Array(kept.length);
  kept.forEach((e, k) => {
    const r = find(tri[6 * e]);
    let id = rootId.get(r);
    if (id === undefined) {
      id = rootId.size;
      rootId.set(r, id);
    }
    comp[k] = id;
  });
  return { comp, count: rootId.size };
}

export function buildShapedMesh(opts: BuildShapedMeshOptions): ShapedMesh {
  const { project, gmsh, grid } = opts;
  const t = project.thickness;
  const warnings: string[] = [];
  const nTri = gmsh.triangleCount;
  const gx = gmsh.coords;

  // ----- 向きをそろえる（CalculiX は反時計回りの要素が必要。時計回りなら 2 と 3 を入れ替える） -----
  const tri = Int32Array.from(gmsh.triangles);
  for (let e = 0; e < nTri; e++) {
    const o = 6 * e;
    const a = tri[o];
    const b = tri[o + 1];
    const c = tri[o + 2];
    const area2 = (gx[2 * b] - gx[2 * a]) * (gx[2 * c + 1] - gx[2 * a + 1]) - (gx[2 * c] - gx[2 * a]) * (gx[2 * b + 1] - gx[2 * a + 1]);
    if (area2 < 0) {
      const [n3, n4, n5] = [tri[o + 3], tri[o + 4], tri[o + 5]];
      tri[o + 1] = c;
      tri[o + 2] = b;
      // 辺 1-2 → 辺 1-3（旧 3-1）、辺 2-3 は同じ、辺 3-1 → 辺 2-1（旧 1-2）
      tri[o + 3] = n5;
      tri[o + 4] = n4;
      tri[o + 5] = n3;
    }
  }

  // ----- 要素の中心で、物体・材料・領域を判定する -----
  const centroidX = new Float64Array(nTri);
  const centroidY = new Float64Array(nTri);
  const bodyIndex = new Int32Array(nTri).fill(-1);
  const area = new Float64Array(nTri);
  const keptAll: number[] = [];
  const xs = new Float64Array(6);
  const ys = new Float64Array(6);
  for (let e = 0; e < nTri; e++) {
    for (let a = 0; a < 6; a++) {
      xs[a] = gx[2 * tri[6 * e + a]];
      ys[a] = gx[2 * tri[6 * e + a] + 1];
    }
    const cx = (xs[0] + xs[1] + xs[2]) / 3;
    const cy = (ys[0] + ys[1] + ys[2]) / 3;
    centroidX[e] = cx;
    centroidY[e] = cy;
    if (!inDomain(project, cx, cy)) continue;
    const b = bodyShapeAt(project, cx, cy);
    if (b < 0) continue;
    bodyIndex[e] = b;
    area[e] = areaP2(xs, ys);
    keptAll.push(e);
  }
  if (keptAll.length === 0) throw new MeshError('物体がありません。形状（固体）を追加してください。');

  // ----- 材料と質量 -----
  const matIndex = new Map<string, number>();
  const materials: MeshMaterial[] = [];
  let missingProps = false;
  let mass = 0;
  const matOf = new Int32Array(nTri).fill(-1);
  for (const e of keptAll) {
    const id = project.shapes[bodyIndex[e]].materialId ?? '';
    let mi = matIndex.get(id);
    if (mi === undefined) {
      const m = getMaterial(id);
      if (m.E === undefined || m.nu === undefined) missingProps = true;
      mi = materials.length;
      materials.push({ name: `MAT${mi + 1}`, material: m, elements: [] });
      matIndex.set(id, mi);
    }
    matOf[e] = mi;
    mass += materials[mi].material.rho * area[e] * t;
  }
  if (missingProps) warnings.push('弾性率やポアソン比が未設定の材料があります。仮の値（E = 2 GPa, ν = 0.3）で計算しました。');

  // ----- 支持と、支持されていない部品 -----
  const supportShapes = project.shapes.filter((s) => s.role === 'support');
  const isSupport = (e: number): boolean => supportShapes.some((s) => containsPoint(s.geom, centroidX[e], centroidY[e]));
  const { comp, count: compCount } = labelComponents(tri, keptAll, gmsh.nodeCount);
  const compSupported = new Array<boolean>(compCount).fill(false);
  const supportElem = new Uint8Array(nTri);
  keptAll.forEach((e, k) => {
    if (isSupport(e)) {
      supportElem[e] = 1;
      compSupported[comp[k]] = true;
    }
  });
  const kept: number[] = [];
  const dropped = new Uint8Array(nTri);
  const excludedComps = new Set<number>();
  keptAll.forEach((e, k) => {
    if (compSupported[comp[k]]) kept.push(e);
    else {
      dropped[e] = 1;
      excludedComps.add(comp[k]);
    }
  });
  if (kept.length === 0) {
    throw new MeshError('支持（固定）が設定されていないため、剛体として動いてしまい解けません。物体に重なるように「支持」を置いてください。');
  }
  const excludedElements = keptAll.length - kept.length;

  // ----- 荷重（荷重の範囲の中の要素に、面積に比例して配る） -----
  const elemFx = new Float64Array(nTri);
  const elemFy = new Float64Array(nTri);
  let appliedLoad = 0;
  let ignoredLoad = 0;
  for (const s of project.shapes) {
    if (s.role !== 'load') continue;
    const fx = s.force?.fx ?? 0;
    const fy = s.force?.fy ?? 0;
    const targets = keptAll.filter((e) => containsPoint(s.geom, centroidX[e], centroidY[e]));
    if (targets.length === 0) continue;
    let total = 0;
    for (const e of targets) total += area[e];
    if (!(total > 0)) continue;
    for (const e of targets) {
      const share = area[e] / total;
      if (dropped[e]) {
        ignoredLoad += Math.abs(fx * share) + Math.abs(fy * share);
      } else {
        elemFx[e] += fx * share;
        elemFy[e] += fy * share;
        appliedLoad += Math.abs(fx * share) + Math.abs(fy * share);
      }
    }
  }
  if (excludedComps.size > 0) {
    warnings.push(`支持されていない部品があります（${excludedComps.size}個）。その部品は解析から除外しました（結果は表示されません）。`);
    if (ignoredLoad > 0) warnings.push('除外した部品に載っている荷重は無視されています。');
  }

  // ----- 節点の番号を詰める（使う節点だけ。gmsh の並び順のまま） -----
  const newId = new Int32Array(gmsh.nodeCount);
  for (const e of kept) for (let a = 0; a < 6; a++) newId[tri[6 * e + a]] = 1;
  let nodeCount = 0;
  const coordList: number[] = [];
  for (let n = 0; n < gmsh.nodeCount; n++) {
    if (!newId[n]) continue;
    newId[n] = ++nodeCount;
    coordList.push(gx[2 * n], gx[2 * n + 1]);
  }
  const coords = Float64Array.from(coordList);

  const nElem = kept.length;
  const connectivity = new Int32Array(nElem * 6);
  const elementMaterial = new Int32Array(nElem);
  const elementArea = new Float64Array(nElem);
  const supportSet = new Set<number>();
  const nodalLoads = new Map<number, { fx: number; fy: number }>();
  const addLoad = (n: number, fx: number, fy: number): void => {
    const cur = nodalLoads.get(n);
    if (cur) {
      cur.fx += fx;
      cur.fy += fy;
    } else nodalLoads.set(n, { fx, fy });
  };
  let totalArea = 0;
  kept.forEach((e, k) => {
    for (let a = 0; a < 6; a++) connectivity[6 * k + a] = newId[tri[6 * e + a]];
    elementMaterial[k] = matOf[e];
    elementArea[k] = area[e];
    totalArea += area[e];
    materials[matOf[e]].elements.push(k + 1);
    if (supportElem[e]) for (let a = 0; a < 6; a++) supportSet.add(connectivity[6 * k + a]);
    // 一様な体積力と等価な節点荷重は、角 0、辺の中点 1/3 ずつ
    const fx = elemFx[e];
    let fy = elemFy[e];
    if (opts.selfWeight) fy -= materials[matOf[e]].material.rho * GRAVITY * area[e] * t;
    if (fx !== 0 || fy !== 0) for (let a = 3; a < 6; a++) addLoad(connectivity[6 * k + a], fx / 3, fy / 3);
  });

  // ----- 結果の格子との対応（セルの中心がどの要素の中にあるか） -----
  const { nx, ny, h } = grid;
  const nCells = nx * ny;
  const cellElement = new Int32Array(nCells).fill(-1);
  const cellXi = new Float64Array(nCells);
  const cellEta = new Float64Array(nCells);
  const included = new Uint8Array(nCells);
  for (let k = 0; k < nElem; k++) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let a = 0; a < 6; a++) {
      const n = connectivity[6 * k + a] - 1;
      xs[a] = coords[2 * n];
      ys[a] = coords[2 * n + 1];
      if (xs[a] < x0) x0 = xs[a];
      if (xs[a] > x1) x1 = xs[a];
      if (ys[a] < y0) y0 = ys[a];
      if (ys[a] > y1) y1 = ys[a];
    }
    const i0 = Math.max(0, Math.floor(x0 / h - 0.5));
    const i1 = Math.min(nx - 1, Math.ceil(x1 / h - 0.5));
    const j0 = Math.max(0, Math.floor(y0 / h - 0.5));
    const j1 = Math.min(ny - 1, Math.ceil(y1 / h - 0.5));
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5) * h;
      if (py < y0 || py > y1) continue;
      for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        if (cellElement[c] >= 0) continue;
        const px = (i + 0.5) * h;
        if (px < x0 || px > x1) continue;
        const loc = locateP2(xs, ys, px, py);
        if (!loc || !insideTriangle(loc.xi, loc.eta)) continue;
        cellElement[c] = k;
        cellXi[c] = loc.xi;
        cellEta[c] = loc.eta;
        included[c] = 1;
      }
    }
  }

  return {
    nx,
    ny,
    h,
    thickness: t,
    elementType: 'CPS6',
    nodeCount,
    coords,
    connectivity,
    nodesPerElement: 6,
    elementCount: nElem,
    elementMaterial,
    elementArea,
    materials,
    supportNodes: [...supportSet].sort((a, b) => a - b),
    nodalLoads,
    included,
    cellElement,
    cellXi,
    cellEta,
    mass,
    area: totalArea,
    appliedLoad,
    excludedParts: excludedComps.size,
    excludedElements,
    ignoredLoad,
    warnings,
  };
}
