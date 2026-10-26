// 3D の定常熱伝導（Lite、ボクセル）。
//
// - 格子は grid3d.ts の studyGrid（PC のエンジンも同じ格子に結果を載せる）。セルの中心が部品の中なら未知数にする。
// - セル同士の熱伝導は G = k·h（面積 h²、距離 h。材料は 1 つなので調和平均は要らない）。
// - 外に出ている面（部品のセルと外のセルの境目）は voxelize.ts の surfaceFaces で求める。
//   階段状の面積は本当の面積より大きいので、面ごとの面積を補正して使う（対流・熱流束の配分に使う）。
//     * 既定: 対流（study.heat.surfaceH、周囲 ambientC）。半セルの伝導（h/2）と直列につなぐ
//     * heatFlux: 面に heatW を（補正後の）面積に比例して入れる。その面は対流しない（部品が載っているため）
//     * fixedTemp: 面を tempC に固定（半セルの熱抵抗 h/2k を通す）
//     * convection: h を上書き
//     * insulated: 熱を逃がさない
//     * support / load は熱では無視（条件なしの面と同じ）
// - study.heat.bodyHeatW は部品の中のセルに均等に配分する。
// - 解くのは周囲温度からの温度差 θ = T − ambientC。連立方程式は対称正定値なので、ヤコビ前処理付き共役勾配法で解く。
// - 放熱の経路（対流・固定温度）がない塊は温度が定まらないので解から外し、日本語の注意を出す。
//
// result().scalars に載せる「実際に使った値」（キーは固定。2D の熱と同じ key・単位をそろえる）:
// - maxTemp / minTemp / avgTemp: 最高・最低・平均温度 [°C]（解いた部品のセル）
// - totalHeat: 総発熱量 [W]（面の熱流束 + 全体の発熱）
// - heatOut: 放熱量 [W]（対流 + 固定温度へ出ていく正味の熱。定常なら totalHeat に一致する）
// - heatConv / heatFixed: そのうち対流・固定温度の面から出ていく熱 [W]
// - surfaceArea / meshArea: 補正後の表面積・三角形の本当の表面積 [m²]
// - cellSize / cells / cellsInside: セルの一辺 [mm]・格子のセル数・部品の中のセル数
// - tolerance / maxIterations: 収束判定と最大反復回数

import { getMaterial } from '../core/materials';
import { studyGrid } from '../core/grid3d';
import { meshMetrics, surfaceFaces, voxelizeMesh, type SurfaceFaces, type VoxelizeResult } from '../core/voxelize';
import type { Region3D, ResultSet3D, ScalarValue, ShapeResult, Solver3D, Solver3DFactory, SolverStatus, Study3D } from '../core/types';
import { SampledSeries, progressFromResidual } from './linear';

const DEFAULT_TOLERANCE = 1e-7;
const DEFAULT_MAX_ITERATIONS = 20000;

/** 面の種類 */
const KIND_CONV = 0;
const KIND_INSULATED = 1;
const KIND_FIXED = 2;
const KIND_FLUX = 3;

/** 熱で使う条件の種類 */
const HEAT_ROLES: ReadonlySet<string> = new Set(['heatFlux', 'fixedTemp', 'convection', 'insulated']);

interface System {
  inside: Uint8Array;
  /** 解く対象のセル（連結成分に放熱経路がある） */
  active: Uint8Array;
  /** 解く対象のセルの番号（昇順） */
  act: Int32Array;
  /** 対角係数 [W/K] */
  diag: Float64Array;
  /** 右辺 [W]（θ 基準） */
  b: Float64Array;
  faces: SurfaceFaces;
  /** 面ごとの種類と、放熱先へのコンダクタンス [W/K]、熱流束の入力 [W]、領域の番号（なければ -1） */
  faceKind: Uint8Array;
  faceG: Float64Array;
  faceQ: Float64Array;
  faceRegion: Int32Array;
  faceTemp: Float64Array;
  faceFilm: Float64Array;
  faceActive: Uint8Array;
  totalHeat: number;
  vox: VoxelizeResult;
  meshArea: number;
  warnings: string[];
  /** 領域の番号（study.regions の添字）ごとの面積などの下調べ */
  regionRoles: (Region3D | null)[];
  noSink: boolean;
  floatingHeat: number;
  floatingCells: number;
}

function fmtMm(v: number): string {
  const mm = v * 1000;
  return mm >= 10 ? mm.toFixed(1) : mm >= 1 ? mm.toFixed(2) : mm.toPrecision(2);
}

function assemble(study: Study3D): System {
  const grid = studyGrid(study);
  const { nx, ny, nz, h } = grid;
  const nxy = nx * ny;
  const n = nx * ny * nz;
  const warnings: string[] = [];
  const amb = study.heat.ambientC;
  const mat = getMaterial(study.materialId);
  const k = mat.k;
  const G = k * h;

  const vox = voxelizeMesh(study.mesh, grid);
  const inside = vox.inside;
  // 格子のいちばん外側の層は、まわりに余白がある前提で解かない（studyGrid の格子なら部品は入らない）
  for (let c = 0; c < n; c++) {
    if (!inside[c]) continue;
    const i = c % nx;
    const j = Math.floor(c / nx) % ny;
    const kk = Math.floor(c / nxy);
    if (i === 0 || j === 0 || kk === 0 || i === nx - 1 || j === ny - 1 || kk === nz - 1) {
      inside[c] = 0;
      vox.count--;
    }
  }

  // --- 条件の面への割り当て（三角形ごとの領域の番号。後に置いた条件を優先）---
  const nt = Math.floor(study.mesh.indices.length / 3);
  const triRegion = new Int32Array(nt).fill(-1);
  const regions = study.regions ?? [];
  const regionRoles: (Region3D | null)[] = regions.map((r) => (HEAT_ROLES.has(r.role) ? r : null));
  regions.forEach((r, ri) => {
    if (!regionRoles[ri]) return;
    for (const t of r.faces) if (t >= 0 && t < nt) triRegion[t] = ri;
  });
  const groups = new Int32Array(nt);
  for (let t = 0; t < nt; t++) groups[t] = triRegion[t] + 1;

  const faces = surfaceFaces({ mesh: study.mesh, grid, inside, groups, groupCount: regions.length + 1, flipped: vox.flipped });
  const nf = faces.count;
  const faceKind = new Uint8Array(nf);
  const faceG = new Float64Array(nf);
  const faceQ = new Float64Array(nf);
  const faceTemp = new Float64Array(nf); // 固定温度の面の温度
  const faceFilm = new Float64Array(nf); // 対流の面の熱伝達率
  const faceRegion = new Int32Array(nf).fill(-1);
  const faceActive = new Uint8Array(nf);

  // 領域ごとの（補正後の）面積。heatFlux の配分に使う
  const regionArea = new Float64Array(regions.length);
  for (let f = 0; f < nf; f++) {
    const t = faces.tri[f];
    const ri = t >= 0 ? triRegion[t] : -1;
    faceRegion[f] = ri;
    if (ri >= 0) regionArea[ri] += faces.area[f];
  }

  const condHalf = h / 2 / (k * h * h); // 半セルの熱抵抗 [K/W]（面は h² の断面を通る）
  let totalHeat = 0;
  const unmatched: string[] = [];
  regions.forEach((r, ri) => {
    if (regionRoles[ri] && regionArea[ri] === 0) unmatched.push(r.name || r.id);
  });
  if (unmatched.length > 0) {
    warnings.push(
      `条件「${unmatched.join('」「')}」の面が、この格子では見つかりませんでした（面が小さすぎる、または薄くて消えた）。` +
        'セルを細かくするか、面の選び直しを試してください。この条件は反映されていません。',
    );
  }

  for (let f = 0; f < nf; f++) {
    const ri = faceRegion[f];
    const r = ri >= 0 ? regionRoles[ri] : null;
    const a = faces.area[f];
    if (!r) {
      faceKind[f] = KIND_CONV;
      faceFilm[f] = study.heat.surfaceH;
    } else if (r.role === 'insulated') {
      faceKind[f] = KIND_INSULATED;
    } else if (r.role === 'fixedTemp') {
      faceKind[f] = KIND_FIXED;
      faceTemp[f] = r.tempC ?? amb;
      faceG[f] = 1 / condHalf;
    } else if (r.role === 'heatFlux') {
      faceKind[f] = KIND_FLUX;
      faceQ[f] = regionArea[ri] > 0 ? ((r.heatW ?? 0) * a) / regionArea[ri] : 0;
    } else {
      faceKind[f] = KIND_CONV;
      faceFilm[f] = r.h ?? study.heat.surfaceH;
    }
    if (faceKind[f] === KIND_CONV) {
      const hf = faceFilm[f];
      faceG[f] = hf > 0 && a > 0 ? 1 / (1 / (hf * a) + condHalf) : 0;
    }
  }

  // --- 連結成分と放熱経路 ---
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const compSink: boolean[] = [];
  const compCells: number[][] = [];
  // 面ごとの放熱の有無を、セルごとに集める
  const cellSink = new Uint8Array(n);
  for (let f = 0; f < nf; f++) if (faceG[f] > 0) cellSink[faces.cell[f]] = 1;
  const bodyPerCell = (study.heat.bodyHeatW ?? 0) / Math.max(1, vox.count);
  const cellFlux = new Float64Array(n);
  for (let f = 0; f < nf; f++) if (faceKind[f] === KIND_FLUX) cellFlux[faces.cell[f]] += faceQ[f];

  const compHeat: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!inside[s] || comp[s] >= 0) continue;
    const id = compSink.length;
    let sp = 0;
    stack[sp++] = s;
    comp[s] = id;
    let sink = false;
    let heat = 0;
    let cnt = 0;
    while (sp > 0) {
      const c = stack[--sp];
      cnt++;
      if (cellSink[c]) sink = true;
      heat += bodyPerCell + cellFlux[c];
      const i = c % nx;
      const j = Math.floor(c / nx) % ny;
      const kk = Math.floor(c / nxy);
      if (i > 0 && inside[c - 1] && comp[c - 1] < 0) (comp[c - 1] = id), (stack[sp++] = c - 1);
      if (i < nx - 1 && inside[c + 1] && comp[c + 1] < 0) (comp[c + 1] = id), (stack[sp++] = c + 1);
      if (j > 0 && inside[c - nx] && comp[c - nx] < 0) (comp[c - nx] = id), (stack[sp++] = c - nx);
      if (j < ny - 1 && inside[c + nx] && comp[c + nx] < 0) (comp[c + nx] = id), (stack[sp++] = c + nx);
      if (kk > 0 && inside[c - nxy] && comp[c - nxy] < 0) (comp[c - nxy] = id), (stack[sp++] = c - nxy);
      if (kk < nz - 1 && inside[c + nxy] && comp[c + nxy] < 0) (comp[c + nxy] = id), (stack[sp++] = c + nxy);
    }
    compSink.push(sink);
    compHeat.push(heat);
    compCells.push([cnt]);
  }
  const active = new Uint8Array(n);
  let nAct = 0;
  let floatingHeat = 0;
  let floatingCells = 0;
  let floatingComps = 0;
  for (let c = 0; c < n; c++) {
    if (!inside[c]) continue;
    if (compSink[comp[c]]) {
      active[c] = 1;
      nAct++;
    } else floatingCells++;
  }
  compSink.forEach((s, id) => {
    if (!s) {
      floatingComps++;
      floatingHeat += compHeat[id];
    }
  });
  const noSink = nAct === 0 && vox.count > 0;
  const act = new Int32Array(nAct);
  {
    let m = 0;
    for (let c = 0; c < n; c++) if (active[c]) act[m++] = c;
  }

  // --- 行列と右辺 ---
  const diag = new Float64Array(n);
  const b = new Float64Array(n);
  for (let m = 0; m < nAct; m++) {
    const c = act[m];
    let nb = 0;
    if (inside[c - 1]) nb++;
    if (inside[c + 1]) nb++;
    if (inside[c - nx]) nb++;
    if (inside[c + nx]) nb++;
    if (inside[c - nxy]) nb++;
    if (inside[c + nxy]) nb++;
    diag[c] = G * nb;
    b[c] = bodyPerCell + cellFlux[c];
  }
  for (let m = 0; m < nAct; m++) totalHeat += b[act[m]];
  for (let f = 0; f < nf; f++) {
    const c = faces.cell[f];
    if (!active[c]) continue;
    faceActive[f] = 1;
    const g = faceG[f];
    if (g > 0) {
      diag[c] += g;
      if (faceKind[f] === KIND_FIXED) b[c] += g * (faceTemp[f] - amb);
    }
  }

  // --- 注意書き ---
  const cellsAll = n;
  warnings.push(
    `格子: セルの一辺 ${fmtMm(h)} mm、セル数 ${cellsAll.toLocaleString('ja-JP')}（うち部品の中 ${vox.count.toLocaleString('ja-JP')}）。` +
      'セルを細かくすると、曲面や薄い部分がより正確になります。',
  );
  if (vox.count === 0) {
    warnings.push('部品の中にセルが 1 つもありません。セルの一辺が部品より大きいか、3D モデルが閉じた立体になっていません。セルを小さくしてください。');
  } else if (vox.count < 200) {
    warnings.push(`部品の中のセルが ${vox.count} 個しかなく、形の細かさが失われています。セルを小さくすると結果が信頼できるようになります。`);
  }
  if (vox.openRays > 0) {
    warnings.push(
      `3D モデルが閉じた立体になっていない可能性があります（${vox.openRays} 本の光線で、表面を通る回数が奇数でした）。` +
        '穴や重なりがあると、部品の中の判定がずれます。モデルを修復してから読み込み直してください。',
    );
  }
  if (vox.thinRays > 0 || faces.lostTriangles > 0) {
    const where: string[] = [];
    if (vox.thinRays > 0) where.push(`x 方向の厚さがセル 1 つ（${fmtMm(h)} mm）に満たない部分が ${vox.thinRays} か所（光線の本数）`);
    if (faces.lostTriangles > 0) where.push(`まわりに格子の面がない大きな三角形が ${faces.lostTriangles} 枚`);
    warnings.push(
      `薄い部分が消えている可能性があります（${where.join('、')}）。` + 'セルの一辺を薄い部分の厚さの半分以下にするか、薄い部分を厚くしてください。',
    );
  }
  if (vox.meshVolume > 0 && vox.count > 0) {
    const ratio = (vox.count * h * h * h) / vox.meshVolume;
    if (Math.abs(ratio - 1) > 0.1) {
      warnings.push(
        `格子で表した体積は元の形の ${(ratio * 100).toFixed(0)}% です（階段状に近似するため）。熱の通り道の断面積も同じだけずれるので、` +
          'セルを細かくしてください。',
      );
    }
  }
  const stair = faces.rawArea / Math.max(faces.trueArea, 1e-30);
  if (nf > 0 && stair > 1.05) {
    warnings.push(
      `階段状の表面積は本当の面積の ${stair.toFixed(2)} 倍になるため、面積を補正して放熱を計算しています（補正後は本当の面積の ${(
        faces.correctedArea / Math.max(faces.trueArea, 1e-30)
      ).toFixed(3)} 倍）。`,
    );
  }
  const badScale = [...faces.groupScale].some((s, g) => s === 1 && faces.groupArea[g] > 0 && Math.abs(faces.groupTrue[g] / faces.groupArea[g] - 1) > 0.25);
  if (badScale) {
    warnings.push('一部の面（条件を置いた面など）で、格子の面積と本当の面積が 25% 以上ずれています。小さい面や薄い面は、セルを細かくしてください。');
  }
  if (noSink && vox.count > 0) {
    warnings.push(
      '放熱の経路がないため、温度が定まりません。表面の熱伝達率（対流）を 0 より大きくするか、面に固定温度か熱伝達率の条件を置いてください。結果は周囲温度のままで、解いていません。',
    );
  } else if (floatingComps > 0 && floatingHeat !== 0) {
    warnings.push(
      `発熱している部分が ${floatingComps} か所、放熱経路（対流・固定温度）を持たないため温度が定まりません。その部分は結果から除外しています。`,
    );
  } else if (floatingCells > 0 && nAct > 0) {
    warnings.push(`放熱経路のない（熱が出入りしない）部品の塊が ${floatingComps} か所あり、結果から除外しています。`);
  }

  return {
    inside,
    active,
    act,
    diag,
    b,
    faces,
    faceKind,
    faceG,
    faceQ,
    faceRegion,
    faceTemp,
    faceFilm,
    faceActive,
    totalHeat,
    vox,
    meshArea: meshMetrics(study.mesh).area,
    warnings,
    regionRoles,
    noSink,
    floatingHeat,
    floatingCells,
  };
}

class Heat3DSolver implements Solver3D {
  readonly analysis = 'heat' as const;

  private readonly study: Study3D;
  private readonly grid: ReturnType<typeof studyGrid>;
  private readonly sys: System;
  private readonly G: number;
  private readonly k: number;
  private readonly tolerance: number;
  private readonly maxIterations: number;
  private readonly history = new SampledSeries();
  private readonly extraWarnings: string[] = [];

  // 共役勾配法の作業領域（ホットループでは確保しない）
  private readonly x: Float64Array;
  private readonly r: Float64Array;
  private readonly z: Float64Array;
  private readonly p: Float64Array;
  private readonly q: Float64Array;
  private readonly invDiag: Float64Array;
  private rz = 0;
  private bNorm = 0;

  private iteration = 0;
  private lastResidual = 0;
  private maxProgress = 0;
  private done = false;
  private solved = true;
  private cache: { iteration: number; result: ResultSet3D } | null = null;

  constructor(study: Study3D) {
    this.study = study;
    this.grid = studyGrid(study);
    this.sys = assemble(study);
    this.k = getMaterial(study.materialId).k;
    this.G = this.k * this.grid.h;
    this.tolerance = DEFAULT_TOLERANCE;
    this.maxIterations = DEFAULT_MAX_ITERATIONS;
    const n = this.grid.nx * this.grid.ny * this.grid.nz;
    const { act, diag, b } = this.sys;
    this.x = new Float64Array(n);
    this.r = new Float64Array(n);
    this.z = new Float64Array(n);
    this.p = new Float64Array(n);
    this.q = new Float64Array(n);
    this.invDiag = new Float64Array(n);

    if (this.sys.noSink || this.sys.vox.count === 0) this.solved = false;

    let bb = 0;
    for (let m = 0; m < act.length; m++) {
      const c = act[m];
      this.invDiag[c] = 1 / diag[c];
      bb += b[c] * b[c];
    }
    this.bNorm = Math.sqrt(bb);
    if (!this.solved || act.length === 0 || this.bNorm === 0) {
      // 駆動項がなければ θ = 0 が厳密解（解けない場合は解かない）
      this.done = true;
      this.maxProgress = 1;
      return;
    }
    let rz = 0;
    for (let m = 0; m < act.length; m++) {
      const c = act[m];
      this.r[c] = b[c];
      const zc = b[c] * this.invDiag[c];
      this.z[c] = zc;
      this.p[c] = zc;
      rz += b[c] * zc;
    }
    this.rz = rz;
    this.lastResidual = 1;
    this.history.push(0, 1);
  }

  /** 共役勾配法を 1 反復進める。収束・発散なら done にする */
  private iterate(): void {
    const { nx, ny } = this.grid;
    const nxy = nx * ny;
    const { act, diag } = this.sys;
    const { p, q, x, r, z, invDiag } = this;
    const G = this.G;
    const m = act.length;
    let pq = 0;
    for (let t = 0; t < m; t++) {
      const c = act[t];
      // 部品の外のセルの p は 0 のままなので、隣が外かどうかは調べなくてよい
      const v = diag[c] * p[c] - G * (p[c - 1] + p[c + 1] + p[c - nx] + p[c + nx] + p[c - nxy] + p[c + nxy]);
      q[c] = v;
      pq += p[c] * v;
    }
    if (!(pq > 0) || !Number.isFinite(pq)) {
      this.finish(!Number.isFinite(pq) ? 'diverged' : 'stalled');
      return;
    }
    const alpha = this.rz / pq;
    let rzNew = 0;
    let rr = 0;
    for (let t = 0; t < m; t++) {
      const c = act[t];
      x[c] += alpha * p[c];
      const rc = r[c] - alpha * q[c];
      r[c] = rc;
      const zc = rc * invDiag[c];
      z[c] = zc;
      rzNew += rc * zc;
      rr += rc * rc;
    }
    const beta = rzNew / this.rz;
    this.rz = rzNew;
    for (let t = 0; t < m; t++) {
      const c = act[t];
      p[c] = z[c] + beta * p[c];
    }
    this.iteration++;
    const rel = Math.sqrt(rr) / this.bNorm;
    this.lastResidual = rel;
    this.history.push(this.iteration, rel);
    if (!Number.isFinite(rel)) this.finish('diverged');
    else if (rel < this.tolerance) this.finish('converged');
    else if (this.iteration >= this.maxIterations) this.finish('max');
  }

  private finish(why: 'converged' | 'diverged' | 'stalled' | 'max'): void {
    this.done = true;
    if (why === 'diverged') {
      this.extraWarnings.push('計算が発散しました。条件（熱伝達率・材料・固定温度）を見直してください。');
    } else if (why === 'stalled') {
      this.extraWarnings.push('計算が途中で止まりました。形や条件に矛盾がないか確かめてください。結果は参考値です。');
    } else if (why === 'max') {
      this.extraWarnings.push(
        `最大反復回数（${this.maxIterations}回）に達しましたが収束しきっていません（残差 ${this.lastResidual.toExponential(1)}）。結果は参考値です。`,
      );
    }
  }

  step(budgetMs: number): SolverStatus {
    if (!this.done) {
      const t0 = performance.now();
      do {
        this.iterate();
        if (!this.done) this.iterate();
      } while (!this.done && performance.now() - t0 < budgetMs);
    }
    const progress = this.done ? 1 : Math.max(this.maxProgress, progressFromResidual(this.lastResidual, 1, this.tolerance));
    this.maxProgress = progress;
    return { done: this.done, progress, iteration: this.iteration, residual: this.lastResidual };
  }

  result(): ResultSet3D {
    if (this.cache && this.cache.iteration === this.iteration) return this.cache.result;
    const result = this.buildResult();
    this.cache = { iteration: this.iteration, result };
    return result;
  }

  private buildResult(): ResultSet3D {
    const { grid, sys, study } = this;
    const { nx, ny, nz, h } = grid;
    const n = nx * ny * nz;
    const amb = study.heat.ambientC;
    const { act, faces } = sys;
    const x = this.x;
    const solved = this.solved;

    const tData = new Float32Array(n).fill(amb);
    const tMask = new Uint8Array(n);
    let tMax = -Infinity;
    let tMin = Infinity;
    let tSum = 0;
    let cnt = 0;
    if (solved) {
      for (let m = 0; m < act.length; m++) {
        const c = act[m];
        const t = amb + x[c];
        tData[c] = t;
        tMask[c] = 1;
        if (t > tMax) tMax = t;
        if (t < tMin) tMin = t;
        tSum += t;
        cnt++;
      }
    }
    if (cnt === 0) {
      tMax = amb;
      tMin = amb;
      tSum = amb;
      cnt = 1;
    }

    // 熱の出入り
    let heatConv = 0;
    let heatFixed = 0;
    for (let f = 0; f < faces.count; f++) {
      if (!sys.faceActive[f]) continue;
      const th = x[faces.cell[f]];
      if (sys.faceKind[f] === KIND_CONV) heatConv += sys.faceG[f] * th;
      else if (sys.faceKind[f] === KIND_FIXED) heatFixed += sys.faceG[f] * (th - (sys.faceTemp[f] - amb));
    }

    // 面の条件ごとの結果（面の温度 = セルの温度から、半セルの伝導・対流の温度差を補正した値）
    const perRegion: ShapeResult[] = [];
    const regions = study.regions ?? [];
    const condHalf = h / 2 / (this.k * h * h);
    regions.forEach((reg, ri) => {
      if (!sys.regionRoles[ri]) return;
      let tmax = -Infinity;
      let tmin = Infinity;
      let tsum = 0;
      let asum = 0;
      let heatOut = 0;
      for (let f = 0; f < faces.count; f++) {
        if (sys.faceRegion[f] !== ri || !sys.faceActive[f]) continue;
        const c = faces.cell[f];
        const a = faces.area[f];
        const tc = amb + x[c];
        let ts = tc;
        const kind = sys.faceKind[f];
        if (kind === KIND_CONV) {
          const q = sys.faceG[f] * x[c];
          heatOut += q;
          ts = amb + (sys.faceFilm[f] > 0 && a > 0 ? q / (sys.faceFilm[f] * a) : x[c]);
        } else if (kind === KIND_FIXED) {
          ts = sys.faceTemp[f];
          heatOut += sys.faceG[f] * (x[c] - (sys.faceTemp[f] - amb));
        } else if (kind === KIND_FLUX) {
          ts = tc + sys.faceQ[f] * condHalf;
          heatOut -= sys.faceQ[f];
        }
        if (!solved) ts = amb;
        if (ts > tmax) tmax = ts;
        if (ts < tmin) tmin = ts;
        tsum += ts * a;
        asum += a;
      }
      const values: ScalarValue[] = [];
      if (asum > 0) {
        values.push(
          { key: 'maxTemp', label: '最高温度', unit: '°C', value: tmax },
          { key: 'minTemp', label: '最低温度', unit: '°C', value: tmin },
          { key: 'avgTemp', label: '平均温度', unit: '°C', value: tsum / asum },
          { key: 'area', label: '面積（補正後）', unit: 'm²', value: asum },
          { key: 'heatOut', label: 'この面から出る熱', unit: 'W', value: heatOut },
        );
      }
      perRegion.push({ shapeId: reg.id, label: reg.name, values });
    });

    const warnings = [...sys.warnings, ...this.extraWarnings];
    const scalars: ScalarValue[] = [
      { key: 'maxTemp', label: '最高温度', unit: '°C', value: tMax },
      { key: 'minTemp', label: '最低温度', unit: '°C', value: tMin },
      { key: 'avgTemp', label: '平均温度', unit: '°C', value: tSum / cnt },
      { key: 'totalHeat', label: '総発熱量', unit: 'W', value: solved ? sys.totalHeat : 0 },
      { key: 'heatOut', label: '放熱量', unit: 'W', value: heatConv + heatFixed },
      { key: 'heatConv', label: '対流で逃げる熱', unit: 'W', value: heatConv },
      { key: 'heatFixed', label: '固定温度の面へ流れる熱', unit: 'W', value: heatFixed },
      { key: 'surfaceArea', label: '表面積（補正後）', unit: 'm²', value: faces.correctedArea },
      { key: 'meshArea', label: '表面積（形の本当の値）', unit: 'm²', value: sys.meshArea },
      { key: 'cellSize', label: 'セルの一辺', unit: 'mm', value: h * 1000 },
      { key: 'cells', label: '格子のセル数', unit: '個', value: n },
      { key: 'cellsInside', label: '部品の中のセル数', unit: '個', value: sys.vox.count },
      { key: 'tolerance', label: '収束判定（相対残差）', unit: '', value: this.tolerance },
      { key: 'maxIterations', label: '最大反復回数', unit: '回', value: this.maxIterations },
    ];

    return {
      analysis: 'heat',
      grid,
      fields: [{ key: 'temp', label: '温度', unit: '°C', data: tData, mask: tMask }],
      scalars,
      history: [{ key: 'residual', label: '残差', unit: '', t: [...this.history.t], values: [...this.history.values] }],
      warnings,
      perRegion,
    };
  }
}

export const createHeat3DSolver: Solver3DFactory = (study: Study3D): Solver3D => new Heat3DSolver(study);
