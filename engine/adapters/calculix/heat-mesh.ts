// 熱解析用の要素分割: 物体セル 1 つ = 厚さ方向に 1 要素の 6 面体（DC3D8）。
//
// 2D の平面要素では「板の表裏からの放熱（faceCooling）」を書けないので、板の厚さ t をそのまま z 方向の 1 要素にして、
// 表裏の面（F1 = z 負側、F2 = z 正側）に *FILM を付ける。Lite の熱解析と同じ境界条件を、面ごとに次のように置く:
//   - 物体のない（固定温度でない）隣のセル        → その面に *FILM（surfaceH、周囲温度）
//   - 物体のない固定温度セルが隣                   → その面の節点の温度を固定
//   - 解析領域の辺（temp / convection / adiabatic） → 辺の面の節点を固定 / *FILM / 何もしない
//   - 固定温度の物体セル                           → そのセルの全節点の温度を固定
//   - faceCooling                                  → 表裏の面に *FILM（surfaceH、周囲温度）
//   - 発熱 heatGen [W/m³]                           → 体積熱流束 *DFLUX（BF）
// 熱伝導率は面内（x, y）が raster.kEff（あれば）か材料の k、板厚方向（z）は材料の k（*CONDUCTIVITY, TYPE=ORTHO）。
// 放熱の経路が一つもない部品（浮いた部品）は温度が定まらないので、Lite と同じく解析から外す。

import { getMaterial } from '../../../src/core/materials';
import type { Project, Raster } from '../../../src/core/types';

/** DC3D8 の面番号（F1..F6）。F3 = y 負側（南）、F4 = x 正側（東）、F5 = y 正側（北）、F6 = x 負側（西） */
export const FACE_NODES: readonly (readonly number[])[] = [
  [0, 1, 2, 3], // F1: z = 0
  [4, 5, 6, 7], // F2: z = t
  [0, 1, 5, 4], // F3: 南
  [1, 2, 6, 5], // F4: 東
  [2, 3, 7, 6], // F5: 北
  [3, 0, 4, 7], // F6: 西
];

export interface FilmGroup {
  /** 面番号 1〜6 */
  face: number;
  /** 熱伝達率 [W/(m²·K)] */
  h: number;
  /** 周囲（吸い込み側）の温度 [°C] */
  sink: number;
  /** 要素番号（1 から） */
  elements: number[];
}

export interface HeatMesh {
  nx: number;
  ny: number;
  h: number;
  thickness: number;
  nodeCount: number;
  /** 節点 n（1 から）の座標は coords[3(n-1) .. 3(n-1)+2] [m] */
  coords: Float64Array;
  /** 要素 e（1 から）の 8 節点。connectivity[8(e-1) .. 8(e-1)+7] */
  connectivity: Int32Array;
  elementCell: Int32Array;
  /** 解析に含めた物体セル（固定温度の物体を含む。浮いた部品は除く）。結果の mask */
  included: Uint8Array;
  /** 熱伝導率ごとの要素の組 */
  conductivity: { kx: number; ky: number; kz: number; elements: number[] }[];
  /** 発熱密度 [W/m³] ごとの要素の組 */
  heatGroups: { qv: number; elements: number[] }[];
  films: FilmGroup[];
  /** 温度を固定する節点 → 温度 [°C] */
  fixedNodes: Map<number, number>;
  /** 解く対象の発熱量の合計 [W] */
  totalHeat: number;
  usesKEff: boolean;
  warnings: string[];
}

interface CellBc {
  films: { face: number; h: number }[];
  fixedFaces: { face: number; temp: number }[];
}

const q4 = (x: number): number => Number(x.toPrecision(4));

export function buildHeatMesh(opts: { project: Project; raster: Raster }): HeatMesh {
  const { project, raster } = opts;
  const { nx, ny, h } = raster;
  const t = project.thickness;
  const n = nx * ny;
  const { ambientC, surfaceH, faceCooling, edges } = project.heat;
  const warnings: string[] = [];

  const isFixedSolid = (c: number): boolean => raster.solid[c] === 1 && !Number.isNaN(raster.fixedTemp[c]);

  // ----- セルごとの境界条件 -----
  const bc: (CellBc | undefined)[] = new Array<CellBc | undefined>(n);
  const sink = new Uint8Array(n); // 放熱の経路がある（固定温度か、膜か、固定した面）
  const dirs = [
    { di: 1, dj: 0, face: 4, edge: edges.right },
    { di: -1, dj: 0, face: 6, edge: edges.left },
    { di: 0, dj: 1, face: 5, edge: edges.top },
    { di: 0, dj: -1, face: 3, edge: edges.bottom },
  ];
  let solidCount = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!raster.solid[c]) continue;
      solidCount++;
      if (isFixedSolid(c)) {
        sink[c] = 1;
        continue;
      }
      const cb: CellBc = { films: [], fixedFaces: [] };
      for (const d of dirs) {
        const ni = i + d.di;
        const nj = j + d.dj;
        if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) {
          if (d.edge.type === 'temp') cb.fixedFaces.push({ face: d.face, temp: d.edge.tempC });
          else if (d.edge.type === 'convection' && d.edge.h > 0) cb.films.push({ face: d.face, h: d.edge.h });
          continue;
        }
        const m = nj * nx + ni;
        if (raster.solid[m]) continue;
        if (!Number.isNaN(raster.fixedTemp[m])) cb.fixedFaces.push({ face: d.face, temp: raster.fixedTemp[m] });
        else if (surfaceH > 0) cb.films.push({ face: d.face, h: surfaceH });
      }
      if (faceCooling && surfaceH > 0) {
        cb.films.push({ face: 1, h: surfaceH }, { face: 2, h: surfaceH });
      }
      bc[c] = cb;
      if (cb.films.length > 0 || cb.fixedFaces.length > 0) sink[c] = 1;
    }
  }

  // ----- 放熱経路のない（浮いた）連結成分を外す -----
  const included = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const stack: number[] = [];
  let unboundedHeated = 0;
  for (let s = 0; s < n; s++) {
    if (!raster.solid[s] || visited[s]) continue;
    const members: number[] = [];
    let hasSink = false;
    let heat = 0;
    visited[s] = 1;
    stack.push(s);
    while (stack.length > 0) {
      const c = stack.pop() as number;
      members.push(c);
      if (sink[c]) hasSink = true;
      if (!isFixedSolid(c)) heat += raster.heatGen[c];
      const i = c % nx;
      const j = (c - i) / nx;
      const nbs = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1];
      for (const m of nbs) {
        if (m >= 0 && raster.solid[m] && !visited[m]) {
          visited[m] = 1;
          stack.push(m);
        }
      }
    }
    if (hasSink) for (const c of members) included[c] = 1;
    else if (heat > 0) unboundedHeated++;
  }
  if (unboundedHeated > 0) {
    warnings.push(
      `発熱している物体が${unboundedHeated}か所、放熱経路（周囲への熱伝達・固定温度・辺の境界条件）を持たないため、温度が定まりません。` +
        '表面熱伝達率を 0 より大きくするか、固定温度や辺の境界条件を設定してください。その物体は結果から除外しています。',
    );
  }
  let includedCount = 0;
  for (let c = 0; c < n; c++) includedCount += included[c];
  if (solidCount === 0) throw new Error('物体がないため、熱解析する対象がありません。形状を追加してください。');
  if (includedCount === 0) {
    throw new Error(
      '放熱経路（周囲への熱伝達・固定温度・辺の境界条件）のある物体がなく、温度が定まりません。表面熱伝達率を 0 より大きくするか、固定温度を置いてください。',
    );
  }

  // ----- 節点（上下 2 層。物体に接するものだけ） -----
  const nodesX = nx + 1;
  const corner = new Int32Array(nodesX * (ny + 1));
  for (let c = 0; c < n; c++) {
    if (!included[c]) continue;
    const i = c % nx;
    const j = (c - i) / nx;
    const n0 = j * nodesX + i;
    corner[n0] = corner[n0 + 1] = corner[n0 + nodesX] = corner[n0 + nodesX + 1] = 1;
  }
  let n2 = 0;
  for (let g = 0; g < corner.length; g++) if (corner[g]) corner[g] = ++n2;
  const nodeCount = 2 * n2;
  const coords = new Float64Array(nodeCount * 3);
  for (let jn = 0; jn <= ny; jn++) {
    for (let in_ = 0; in_ <= nx; in_++) {
      const id = corner[jn * nodesX + in_];
      if (!id) continue;
      coords.set([in_ * h, jn * h, 0], 3 * (id - 1));
      coords.set([in_ * h, jn * h, t], 3 * (id - 1 + n2));
    }
  }

  // ----- 要素・熱伝導率・発熱・膜・固定温度 -----
  const nElem = includedCount;
  const connectivity = new Int32Array(nElem * 8);
  const elementCell = new Int32Array(nElem);
  const kGroups = new Map<string, { kx: number; ky: number; kz: number; elements: number[] }>();
  const qGroups = new Map<string, { qv: number; elements: number[] }>();
  const filmGroups = new Map<string, FilmGroup>();
  const fixedNodes = new Map<number, number>();
  const kEff = raster.kEff;
  let usesKEff = false;
  let totalHeat = 0;
  const volume = h * h * t;

  // 固定温度の物体セルが先（面で固定する温度より優先）
  const faceNodesOf = (e: number, face: number): number[] => FACE_NODES[face - 1].map((a) => connectivity[8 * e + a]);
  let e = 0;
  const elementOfCell = new Int32Array(n).fill(-1);
  for (let c = 0; c < n; c++) {
    if (!included[c]) continue;
    const i = c % nx;
    const j = (c - i) / nx;
    const n0 = j * nodesX + i;
    const b = [corner[n0], corner[n0 + 1], corner[n0 + 1 + nodesX], corner[n0 + nodesX]];
    for (let a = 0; a < 4; a++) {
      connectivity[8 * e + a] = b[a];
      connectivity[8 * e + 4 + a] = b[a] + n2;
    }
    elementCell[e] = c;
    elementOfCell[c] = e;

    const material = getMaterial(raster.materialId[c] ?? '');
    const kz = q4(material.k);
    const ke = kEff ? kEff[c] : NaN;
    const kxy = Number.isFinite(ke) && ke > 0 ? q4(ke) : kz;
    if (kxy !== kz) usesKEff = true;
    const kKey = `${kxy}|${kz}`;
    let kg = kGroups.get(kKey);
    if (!kg) kGroups.set(kKey, (kg = { kx: kxy, ky: kxy, kz, elements: [] }));
    kg.elements.push(e + 1);

    if (isFixedSolid(c)) {
      for (let a = 0; a < 8; a++) fixedNodes.set(connectivity[8 * e + a], raster.fixedTemp[c]);
    } else if (raster.heatGen[c] > 0) {
      const qKey = raster.heatGen[c].toPrecision(8);
      let qg = qGroups.get(qKey);
      if (!qg) qGroups.set(qKey, (qg = { qv: raster.heatGen[c], elements: [] }));
      qg.elements.push(e + 1);
      totalHeat += raster.heatGen[c] * volume;
    }
    e++;
  }
  for (let k = 0; k < nElem; k++) {
    const c = elementCell[k];
    const cb = bc[c];
    if (!cb) continue;
    for (const f of cb.films) {
      const key = `${f.face}|${f.h}|${ambientC}`;
      let g = filmGroups.get(key);
      if (!g) filmGroups.set(key, (g = { face: f.face, h: f.h, sink: ambientC, elements: [] }));
      g.elements.push(k + 1);
    }
    for (const ff of cb.fixedFaces) {
      for (const node of faceNodesOf(k, ff.face)) if (!fixedNodes.has(node)) fixedNodes.set(node, ff.temp);
    }
  }
  if (usesKEff) {
    warnings.push('基板の銅箔を、厚さで重み付けした実効熱伝導率として扱っています（面内のみ。板厚方向は基材の値）。銅箔の細かい配線の向きは考えていません。');
  }
  for (let c = 0; c < n; c++) {
    if (isFixedSolid(c) && included[c] && raster.heatGen[c] > 0) {
      warnings.push('固定温度のセルの中にある発熱は、固定温度の熱源に吸収されるため集計していません。');
      break;
    }
  }

  return {
    nx,
    ny,
    h,
    thickness: t,
    nodeCount,
    coords,
    connectivity,
    elementCell,
    included,
    conductivity: [...kGroups.values()],
    heatGroups: [...qGroups.values()],
    films: [...filmGroups.values()],
    fixedNodes,
    totalHeat,
    usesKEff,
    warnings,
  };
}
