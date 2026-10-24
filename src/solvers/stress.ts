// 強度解析ソルバー: 2D平面応力の線形弾性有限要素法。
//
// - 物体セル 1 つを双線形 Q4 要素（一辺 h の正方形、厚さ t）として扱う。
// - 節点はセル角 (nx+1)×(ny+1)。物体に接する節点だけが自由度（x, y の 2 つ）を持つ。
// - 正方形要素なので 8×8 の剛性行列は形が同じ。単位剛性行列を材料ごと（ポアソン比ごと）に
//   1 回だけ作り、E·t を掛けて使う。
// - K u = f は行列を組み立てず、要素ごとに掛け算する前処理付き共役勾配法（Jacobi）で解く。
//   step(budgetMs) で少しずつ反復し、UI を固めない。

import type { Field, History, Project, Raster, ResultSet, ScalarValue, Solver, SolverFactory, SolverStatus } from '../core/types';
import { getMaterial } from '../core/materials';

const GRAVITY = 9.80665; // [m/s²]
const TOLERANCE = 1e-8; // 収束判定: 相対残差
const SAFETY_CAP = 100; // 表示用の安全率の上限
const HISTORY_STRIDE = 10; // 残差履歴を記録する反復間隔

/** UI が変形図を描くために使う、節点変位つきのソルバー */
export interface StressSolver extends Solver {
  /**
   * 節点変位 [m]。節点 (i, j) のインデックスは j * (nx + 1) + i（0 <= i <= nx, 0 <= j <= ny）。
   * 解析対象外の節点は 0。配列は反復のたびに更新される（コピーしない）。
   */
  displacements(): { nodesX: number; nodesY: number; ux: Float64Array; uy: Float64Array };
}

// ---------- 要素剛性 ----------

// 局所座標 (ξ, η) ∈ [-1, 1]² での節点の符号。節点順は 左下→右下→右上→左上
const XI = [-1, 1, 1, -1];
const ETA = [-1, -1, 1, 1];

/** 平面応力の構成行列 D（E で割った値）。[d11, d12, d33] */
function planeStressD(nu: number): [number, number, number] {
  const c = 1 / (1 - nu * nu);
  return [c, c * nu, (c * (1 - nu)) / 2];
}

/** 点 (ξ, η) での B 行列（3×8、辺長 1 の正方形用）。実際の要素では 1/h を掛ける */
function bMatrix(xi: number, eta: number): Float64Array {
  const b = new Float64Array(24);
  for (let a = 0; a < 4; a++) {
    // 辺長 1 → dx/dξ = 1/2 なので d/dx = 2 d/dξ
    const dNdx = (2 * XI[a] * (1 + ETA[a] * eta)) / 4;
    const dNdy = (2 * ETA[a] * (1 + XI[a] * xi)) / 4;
    b[0 * 8 + 2 * a] = dNdx; // εx
    b[1 * 8 + 2 * a + 1] = dNdy; // εy
    b[2 * 8 + 2 * a] = dNdy; // γxy
    b[2 * 8 + 2 * a + 1] = dNdx;
  }
  return b;
}

/** E = 1, t = 1 の 8×8 剛性行列（2 次元では要素の大きさ h に依存しない）。2×2 ガウス積分 */
function unitStiffness(nu: number): Float64Array {
  const [d11, d12, d33] = planeStressD(nu);
  const g = 1 / Math.sqrt(3);
  const detJ = 1 / 4; // 辺長 1 の正方形: (1/2)²
  const ke = new Float64Array(64);
  for (const xi of [-g, g]) {
    for (const eta of [-g, g]) {
      const b = bMatrix(xi, eta);
      // DB (3×8)
      const db = new Float64Array(24);
      for (let c = 0; c < 8; c++) {
        db[c] = d11 * b[c] + d12 * b[8 + c];
        db[8 + c] = d12 * b[c] + d11 * b[8 + c];
        db[16 + c] = d33 * b[16 + c];
      }
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          ke[r * 8 + c] += (b[r] * db[c] + b[8 + r] * db[8 + c] + b[16 + r] * db[16 + c]) * detJ;
        }
      }
    }
  }
  return ke;
}

// ---------- ソルバー本体 ----------

interface MatInfo {
  E: number;
  nu: number;
  yield: number;
  rho: number;
  /** E·t を掛けた 8×8 要素剛性 */
  ke: Float64Array;
}

export function createStressSolverDetailed(project: Project, raster: Raster): StressSolver {
  const { nx, ny, h } = raster;
  const t = project.thickness;
  const nCells = nx * ny;
  const nodesX = nx + 1;
  const nodesY = ny + 1;
  const nNodes = nodesX * nodesY;
  const nDof = 2 * nNodes;
  const warnings: string[] = [];

  // ----- 材料 -----
  const mats: MatInfo[] = [];
  const matIndex = new Map<string, number>();
  const cellMat = new Int32Array(nCells).fill(-1);
  let missingProps = false;
  let totalMass = 0;
  for (let c = 0; c < nCells; c++) {
    if (!raster.solid[c]) continue;
    const id = raster.materialId[c] ?? '';
    let mi = matIndex.get(id);
    if (mi === undefined) {
      const m = getMaterial(id);
      if (m.E === undefined || m.nu === undefined) missingProps = true;
      const E = m.E ?? 2e9;
      const nu = Math.min(0.49, Math.max(0, m.nu ?? 0.3));
      const ke = unitStiffness(nu);
      for (let k = 0; k < 64; k++) ke[k] *= E * t;
      mi = mats.length;
      mats.push({ E, nu, yield: m.yield ?? Infinity, rho: m.rho, ke });
      matIndex.set(id, mi);
    }
    cellMat[c] = mi;
    totalMass += mats[mi].rho * h * h * t;
  }
  if (missingProps) warnings.push('弾性率やポアソン比が未設定の材料があります。仮の値（E = 2 GPa, ν = 0.3）で計算しました。');

  // ----- 支持されている部品の判定（辺でつながったセルの連結成分） -----
  const comp = new Int32Array(nCells).fill(-1);
  const compSupported: boolean[] = [];
  const stack: number[] = [];
  for (let s = 0; s < nCells; s++) {
    if (!raster.solid[s] || comp[s] >= 0) continue;
    const id = compSupported.length;
    let supported = false;
    // 上下左右に隣り合う物体セルを辿る
    const push = (n: number): void => {
      if (raster.solid[n] && comp[n] < 0) {
        comp[n] = id;
        stack.push(n);
      }
    };
    push(s);
    while (stack.length > 0) {
      const c = stack.pop() as number;
      if (raster.support[c]) supported = true;
      const i = c % nx;
      const j = (c - i) / nx;
      if (i > 0) push(c - 1);
      if (i < nx - 1) push(c + 1);
      if (j > 0) push(c - nx);
      if (j < ny - 1) push(c + nx);
    }
    compSupported.push(supported);
  }

  // 解析に含める要素（支持された部品の物体セル）
  const elemList: number[] = [];
  let excludedCells = 0;
  const excludedComps = new Set<number>();
  let solidCount = 0;
  for (let c = 0; c < nCells; c++) {
    if (!raster.solid[c]) continue;
    solidCount++;
    if (compSupported[comp[c]]) elemList.push(c);
    else {
      excludedCells++;
      excludedComps.add(comp[c]);
    }
  }
  const nElem = elemList.length;
  const elemCell = Int32Array.from(elemList);
  const included = new Uint8Array(nCells);
  for (const c of elemList) included[c] = 1;

  // ----- 自由度の準備 -----
  const edof = new Int32Array(nElem * 8);
  const nodeActive = new Uint8Array(nNodes);
  const nodeFixed = new Uint8Array(nNodes);
  for (let e = 0; e < nElem; e++) {
    const c = elemCell[e];
    const i = c % nx;
    const j = (c - i) / nx;
    const n0 = j * nodesX + i;
    const ns = [n0, n0 + 1, n0 + 1 + nodesX, n0 + nodesX];
    for (let a = 0; a < 4; a++) {
      edof[e * 8 + 2 * a] = 2 * ns[a];
      edof[e * 8 + 2 * a + 1] = 2 * ns[a] + 1;
      nodeActive[ns[a]] = 1;
      if (raster.support[c]) nodeFixed[ns[a]] = 1;
    }
  }
  /** 1 = 未知の自由度（使われている節点で、固定でないもの） */
  const free = new Uint8Array(nDof);
  let nFree = 0;
  for (let n = 0; n < nNodes; n++) {
    if (nodeActive[n] && !nodeFixed[n]) {
      free[2 * n] = 1;
      free[2 * n + 1] = 1;
      nFree += 2;
    }
  }
  const elemMat = new Int32Array(nElem);
  for (let e = 0; e < nElem; e++) elemMat[e] = cellMat[elemCell[e]];

  // ----- 荷重ベクトル -----
  const f = new Float64Array(nDof);
  let appliedLoad = 0;
  const useSelfWeight = project.stress.selfWeight;
  for (let e = 0; e < nElem; e++) {
    const c = elemCell[e];
    const fx = raster.loadFx[c] / 4;
    let fy = raster.loadFy[c] / 4;
    if (useSelfWeight) fy -= (mats[elemMat[e]].rho * GRAVITY * h * h * t) / 4;
    appliedLoad += Math.abs(fx) + Math.abs(fy);
    for (let a = 0; a < 4; a++) {
      f[edof[e * 8 + 2 * a]] += fx;
      f[edof[e * 8 + 2 * a + 1]] += fy;
    }
  }
  // 支持されていない部品に載っている荷重は無視される
  let ignoredLoad = 0;
  for (let c = 0; c < nCells; c++) {
    if (raster.solid[c] && !included[c]) ignoredLoad += Math.abs(raster.loadFx[c]) + Math.abs(raster.loadFy[c]);
  }

  // ----- 前処理用の対角成分 -----
  const diag = new Float64Array(nDof);
  for (let e = 0; e < nElem; e++) {
    const ke = mats[elemMat[e]].ke;
    for (let r = 0; r < 8; r++) diag[edof[e * 8 + r]] += ke[r * 9];
  }

  /** y = K x（全自由度。拘束の処理は呼び出し側） */
  const xe = new Float64Array(8);
  function matvec(x: Float64Array, y: Float64Array): void {
    y.fill(0);
    for (let e = 0; e < nElem; e++) {
      const o = e * 8;
      const ke = mats[elemMat[e]].ke;
      for (let k = 0; k < 8; k++) xe[k] = x[edof[o + k]];
      for (let r = 0; r < 8; r++) {
        const row = r * 8;
        y[edof[o + r]] +=
          ke[row] * xe[0] + ke[row + 1] * xe[1] + ke[row + 2] * xe[2] + ke[row + 3] * xe[3] +
          ke[row + 4] * xe[4] + ke[row + 5] * xe[5] + ke[row + 6] * xe[6] + ke[row + 7] * xe[7];
      }
    }
  }

  // ----- 解けない／自明な場合の判定 -----
  const hasSupport = nElem > 0;
  const hasLoad = appliedLoad > 0;
  let state: 'cg' | 'trivial' | 'unsolvable' = 'cg';
  if (solidCount === 0) {
    state = 'unsolvable';
    warnings.push('物体がありません。形状を追加してください。');
  } else if (!hasSupport) {
    state = 'unsolvable';
    warnings.push('支持（固定）が設定されていないため、剛体として動いてしまい解けません。物体に重なるように「支持」を置いてください。');
  } else {
    if (excludedCells > 0) {
      warnings.push(`支持されていない部品があります（${excludedComps.size}個）。その部品は解析から除外しました（結果は表示されません）。`);
      if (ignoredLoad > 0) warnings.push('除外した部品に載っている荷重は無視されています。');
    }
    if (!hasLoad) {
      state = 'trivial';
      warnings.push('荷重も自重もないため、応力と変位はゼロです。荷重を置くか、自重を有効にしてください。');
    }
  }

  // ----- 共役勾配法の状態 -----
  const u = new Float64Array(nDof);
  const r = new Float64Array(nDof);
  const z = new Float64Array(nDof);
  const p = new Float64Array(nDof);
  const Ap = new Float64Array(nDof);
  let rz = 0;
  let fNorm = 0;
  let iteration = 0;
  let residual = state === 'cg' ? 1 : 0;
  let done = state !== 'cg';
  let hitMaxIter = false;
  const maxIter = Math.max(2000, 20 * (nx + ny));
  const history: History = { key: 'residual', label: '残差', unit: '', t: [], values: [] };

  if (state === 'cg') {
    // 初期値 u = 0 → 残差 r = f（自由度のみ）、前処理後 z、探索方向 p
    for (let k = 0; k < nDof; k++) {
      if (!free[k]) continue;
      r[k] = f[k];
      fNorm += f[k] * f[k];
      z[k] = r[k] / diag[k];
      p[k] = z[k];
      rz += r[k] * z[k];
    }
    fNorm = Math.sqrt(fNorm);
    if (fNorm === 0) {
      // 荷重が全部固定節点に載っている場合など
      state = 'trivial';
      done = true;
      residual = 0;
      warnings.push('荷重が支持部に直接加わっているため、変形は生じません。');
    } else {
      history.t.push(0);
      history.values.push(1);
    }
  }

  /** 共役勾配法を 1 反復進める。収束したら true */
  function cgIteration(): boolean {
    matvec(p, Ap);
    let pAp = 0;
    for (let k = 0; k < nDof; k++) {
      if (!free[k]) Ap[k] = 0;
      else pAp += p[k] * Ap[k];
    }
    if (!(pAp > 0)) return true; // 数値的に進めない（通常は起きない）
    const alpha = rz / pAp;
    let rr = 0;
    let rzNew = 0;
    for (let k = 0; k < nDof; k++) {
      if (!free[k]) continue;
      u[k] += alpha * p[k];
      r[k] -= alpha * Ap[k];
      rr += r[k] * r[k];
      z[k] = r[k] / diag[k];
      rzNew += r[k] * z[k];
    }
    const beta = rzNew / rz;
    rz = rzNew;
    for (let k = 0; k < nDof; k++) {
      if (free[k]) p[k] = z[k] + beta * p[k];
    }
    iteration++;
    residual = Math.sqrt(rr) / fNorm;
    if (iteration % HISTORY_STRIDE === 0) {
      history.t.push(iteration);
      history.values.push(residual);
    }
    return residual < TOLERANCE;
  }

  // ----- 結果の組み立て -----
  let cache: ResultSet | null = null;
  let cacheIteration = -1;

  const uxNode = new Float64Array(nNodes);
  const uyNode = new Float64Array(nNodes);
  function syncNodal(): void {
    for (let n = 0; n < nNodes; n++) {
      uxNode[n] = u[2 * n];
      uyNode[n] = u[2 * n + 1];
    }
  }

  const bCenter = bMatrix(0, 0);

  function buildResult(): ResultSet {
    syncNodal();
    const mk = (key: string, label: string, unit: string, diverging = false): Field => ({
      key,
      label,
      unit,
      data: new Float32Array(nCells),
      mask: included,
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

    let maxVm = 0;
    let minSafety = SAFETY_CAP;
    let maxDisp = 0;
    const ue = new Float64Array(8);
    for (let e = 0; e < nElem; e++) {
      const c = elemCell[e];
      const m = mats[elemMat[e]];
      for (let k = 0; k < 8; k++) ue[k] = u[edof[e * 8 + k]];
      // 要素中心のひずみ（B は辺長 1 用なので 1/h を掛ける）
      let ex = 0;
      let ey = 0;
      let gxy = 0;
      for (let k = 0; k < 8; k++) {
        ex += bCenter[k] * ue[k];
        ey += bCenter[8 + k] * ue[k];
        gxy += bCenter[16 + k] * ue[k];
      }
      ex /= h;
      ey /= h;
      gxy /= h;
      const [d11, d12, d33] = planeStressD(m.nu);
      const sxx = m.E * (d11 * ex + d12 * ey);
      const syy = m.E * (d12 * ex + d11 * ey);
      const sxy = m.E * d33 * gxy;
      const vm = Math.sqrt(Math.max(0, sxx * sxx - sxx * syy + syy * syy + 3 * sxy * sxy));
      const safety = vm > 0 ? Math.min(SAFETY_CAP, m.yield / vm) : SAFETY_CAP;
      const mx = (ue[0] + ue[2] + ue[4] + ue[6]) / 4;
      const my = (ue[1] + ue[3] + ue[5] + ue[7]) / 4;

      fVm.data[c] = vm;
      fSxx.data[c] = sxx;
      fSyy.data[c] = syy;
      fSxy.data[c] = sxy;
      fSafety.data[c] = safety;
      fUx.data[c] = mx;
      fUy.data[c] = my;
      fDisp.data[c] = Math.hypot(mx, my);
      if (vm > maxVm) maxVm = vm;
      if (safety < minSafety) minSafety = safety;
    }
    for (let n = 0; n < nNodes; n++) {
      if (!nodeActive[n]) continue;
      const d = Math.hypot(uxNode[n], uyNode[n]);
      if (d > maxDisp) maxDisp = d;
    }

    // 反力: 固定節点での K u − f の合計（符号を反転した大きさが荷重と釣り合う）
    let rx = 0;
    let ry = 0;
    if (state === 'cg' && iteration > 0) {
      matvec(u, Ap);
      for (let n = 0; n < nNodes; n++) {
        if (!nodeFixed[n]) continue;
        rx += Ap[2 * n] - f[2 * n];
        ry += Ap[2 * n + 1] - f[2 * n + 1];
      }
    }

    const scalars: ScalarValue[] = [
      { key: 'maxVonMises', label: '最大ミーゼス応力', unit: 'Pa', value: maxVm },
      { key: 'maxDisplacement', label: '最大変位', unit: 'm', value: maxDisp },
      { key: 'minSafety', label: '最小安全率', unit: '', value: minSafety },
      { key: 'mass', label: '質量', unit: 'kg', value: totalMass },
      { key: 'reaction', label: '反力合計', unit: 'N', value: Math.hypot(rx, ry) },
    ];

    const out: string[] = [...warnings];
    if (hitMaxIter) out.push(`反復の上限（${maxIter}回）に達しました。収束していない可能性があります（相対残差 ${residual.toExponential(1)}）。`);
    if (state === 'cg' && done && !hitMaxIter) {
      if (minSafety < 1) out.push(`降伏応力を超えています（安全率 ${minSafety.toFixed(2)}）。形状を厚くするか、材料を変えてください。`);
      else if (minSafety < 2) out.push(`安全率が低めです（${minSafety.toFixed(2)}）。繰り返し荷重や衝撃がある場合は余裕を持たせてください。`);
    }
    if (state === 'cg') {
      out.push('支持や荷重の角では応力が集中し、格子を細かくするほど最大応力が大きく出る傾向があります。');
    }
    out.push('2D平面応力による近似です。3Dプリント品は積層方向（Z）の強度が低く、実際はより弱くなることがあります。');

    return {
      analysis: 'stress',
      nx,
      ny,
      h,
      fields: [fVm, fDisp, fSxx, fSyy, fSxy, fSafety, fUx, fUy],
      scalars,
      history: [history],
      warnings: out,
    };
  }

  return {
    analysis: 'stress',

    step(budgetMs: number): SolverStatus {
      if (!done) {
        const start = performance.now();
        do {
          // 時計の確認は数反復に 1 回にして、計算の邪魔をしない
          for (let k = 0; k < 5 && !done; k++) {
            if (cgIteration()) done = true;
            else if (iteration >= maxIter) {
              done = true;
              hitMaxIter = true;
            }
          }
        } while (!done && performance.now() - start < budgetMs);
        if (done) {
          // 最終点を履歴に残す
          if (history.t[history.t.length - 1] !== iteration) {
            history.t.push(iteration);
            history.values.push(residual);
          }
        }
      }
      const progress = done ? 1 : Math.min(0.99, Math.max(0, -Math.log10(Math.max(residual, 1e-300)) / -Math.log10(TOLERANCE)));
      return {
        done,
        progress,
        iteration,
        residual,
        message: done ? (state === 'cg' ? (hitMaxIter ? '反復上限に達しました' : '収束しました') : '計算できませんでした') : '計算中',
      };
    },

    result(): ResultSet {
      if (!cache || cacheIteration !== iteration) {
        cache = buildResult();
        cacheIteration = iteration;
      }
      return cache;
    },

    displacements() {
      syncNodal();
      return { nodesX, nodesY, ux: uxNode, uy: uyNode };
    },
  };
}

export const createStressSolver: SolverFactory = createStressSolverDetailed;
