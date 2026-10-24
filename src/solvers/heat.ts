// 熱解析ソルバー: 2D 定常熱伝導（有限体積法）。
//
// - 格子セルを検査体積（セル幅 h、奥行き thickness）とみなし、物体セルの温度を未知数にする。
// - 物体セル同士の面の熱コンダクタンスは熱伝導率の調和平均:  G = k_harm · A / h
// - 物体に接する物体のないセルは、周囲温度 ambientC の空気（未知数ではない）。
//   表面の熱伝達率 surfaceH と半セルぶんの伝導を直列につないだコンダクタンスで放熱する。
// - 解くのは周囲温度からの温度差 θ = T − ambientC（桁落ちを避け、残差の基準を物理的にするため）。
// - 連立方程式は対称正定値なので、SSOR 前処理付き共役勾配法（linear.ts）で解く。

import type { EdgeBC, Field, Project, Raster, ResultSet, Solver, SolverFactory, SolverStatus } from '../core/types';
import { getMaterial } from '../core/materials';
import { PcgSolver, SampledSeries, createStencil, progressFromResidual, type Stencil5 } from './linear';

/** 収束判定: 相対残差 ‖r‖/‖b‖ がこれを下回れば収束 */
const TOLERANCE = 1e-7;
const MAX_ITERATIONS = 20000;

/** 組み立て結果 */
interface HeatSystem {
  stencil: Stencil5;
  /** セルごとの熱伝導率 [W/(m·K)]（物体でなければ 0） */
  k: Float64Array;
  /** 1 = 物体セルで温度が固定（Dirichlet） */
  fixed: Uint8Array;
  /** 未知セルが固定値・周囲へ繋がるコンダクタンスの合計 [W/K] */
  lossG: Float64Array;
  /** Σ G·(T_ref − T_amb) [W]（θ の式の右辺に入る） */
  lossGT: Float64Array;
  /** 放熱経路がなく温度が定まらない物体セル（解から除外） */
  floating: Uint8Array;
  /** 解く対象の発熱量の合計 [W] */
  totalHeat: number;
  warnings: string[];
}

/** 半セルの伝導と表面熱伝達（または任意の熱伝達率）を直列につないだコンダクタンス [W/K] */
function filmConductance(hFilm: number, k: number, h: number, thickness: number): number {
  if (!(hFilm > 0) || !(k > 0)) return 0;
  const A = h * thickness;
  return 1 / (1 / (hFilm * A) + h / 2 / (k * A));
}

function assemble(project: Project, raster: Raster): HeatSystem {
  const { nx, ny, h } = raster;
  const n = nx * ny;
  const thickness = project.thickness;
  const { ambientC, surfaceH, faceCooling, edges } = project.heat;
  const A = h * thickness;
  const volume = h * h * thickness;

  const stencil = createStencil(nx, ny);
  const k = new Float64Array(n);
  const fixed = new Uint8Array(n);
  const lossG = new Float64Array(n);
  const lossGT = new Float64Array(n);
  const floating = new Uint8Array(n);
  const warnings: string[] = [];

  // 材料の熱伝導率を引いておく
  const kCache = new Map<string, number>();
  for (let c = 0; c < n; c++) {
    if (!raster.solid[c]) continue;
    const id = raster.materialId[c];
    if (id === null) continue;
    let kv = kCache.get(id);
    if (kv === undefined) {
      kv = getMaterial(id).k;
      kCache.set(id, kv);
    }
    k[c] = kv;
    if (!Number.isNaN(raster.fixedTemp[c])) fixed[c] = 1;
  }

  // 4方向: [東, 西, 北, 南]
  const dirs = [
    { di: 1, dj: 0, coef: stencil.aE, edge: edges.right },
    { di: -1, dj: 0, coef: stencil.aW, edge: edges.left },
    { di: 0, dj: 1, coef: stencil.aN, edge: edges.top },
    { di: 0, dj: -1, coef: stencil.aS, edge: edges.bottom },
  ];

  /** 放熱先（基準温度 tRef）へのコンダクタンスを登録する */
  const addLoss = (c: number, g: number, tRef: number) => {
    if (!(g > 0)) return;
    lossG[c] += g;
    lossGT[c] += g * (tRef - ambientC);
  };
  const edgeLoss = (c: number, bc: EdgeBC) => {
    if (bc.type === 'temp') addLoss(c, (2 * k[c] * A) / h, bc.tempC);
    else if (bc.type === 'convection') addLoss(c, filmConductance(bc.h, k[c], h, thickness), ambientC);
    // adiabatic: 何もしない
  };

  let totalHeat = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!raster.solid[c] || fixed[c]) continue;
      stencil.active[c] = 1;

      for (const d of dirs) {
        const ni = i + d.di;
        const nj = j + d.dj;
        if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) {
          edgeLoss(c, d.edge); // 解析領域の辺
          continue;
        }
        const m = nj * nx + ni;
        if (raster.solid[m]) {
          // 物体同士: 調和平均の熱伝導率
          const g = ((2 * k[c] * k[m]) / (k[c] + k[m]) / h) * A;
          if (fixed[m]) addLoss(c, g, raster.fixedTemp[m]);
          else d.coef[c] = g;
        } else if (!Number.isNaN(raster.fixedTemp[m])) {
          // 物体のない固定温度セル: 面が固定温度に直接触れているとみなす（半セルの伝導のみ）
          addLoss(c, (2 * k[c] * A) / h, raster.fixedTemp[m]);
        } else {
          // 周囲の空気への対流
          addLoss(c, filmConductance(surfaceH, k[c], h, thickness), ambientC);
        }
      }
      // 板の表裏からの放熱
      if (faceCooling) addLoss(c, 2 * surfaceH * h * h, ambientC);

      stencil.b[c] = raster.heatGen[c] * volume;
      totalHeat += stencil.b[c];
    }
  }

  // 放熱経路のない（浮いた）連結成分を探す。そこは係数行列が特異になるので解から外す
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  let unboundedCount = 0;
  for (let start = 0; start < n; start++) {
    if (!stencil.active[start] || visited[start]) continue;
    const members: number[] = [];
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let hasSink = false;
    let heat = 0;
    while (sp > 0) {
      const c = stack[--sp];
      members.push(c);
      if (lossG[c] > 0) hasSink = true;
      heat += stencil.b[c];
      const nbs = [
        stencil.aE[c] > 0 ? c + 1 : -1,
        stencil.aW[c] > 0 ? c - 1 : -1,
        stencil.aN[c] > 0 ? c + nx : -1,
        stencil.aS[c] > 0 ? c - nx : -1,
      ];
      for (const m of nbs) {
        if (m >= 0 && !visited[m]) {
          visited[m] = 1;
          stack[sp++] = m;
        }
      }
    }
    if (hasSink) continue;
    for (const c of members) {
      floating[c] = 1;
      stencil.active[c] = 0;
      stencil.aE[c] = stencil.aW[c] = stencil.aN[c] = stencil.aS[c] = 0;
      stencil.b[c] = 0;
    }
    if (heat > 0) {
      unboundedCount += 1;
      totalHeat -= heat; // 解けない領域の発熱は集計から外す
    }
  }
  if (unboundedCount > 0) {
    warnings.push(
      `発熱している物体が${unboundedCount}か所、放熱経路（周囲への熱伝達・固定温度・辺の境界条件）を持たないため、温度が定まりません。` +
        '表面熱伝達率を 0 より大きくするか、固定温度や辺の境界条件を設定してください。その物体は結果から除外しています。',
    );
  }

  // 対角係数 aP = Σ a_nb + 放熱コンダクタンス
  for (let c = 0; c < n; c++) {
    if (!stencil.active[c]) continue;
    stencil.aP[c] = stencil.aE[c] + stencil.aW[c] + stencil.aN[c] + stencil.aS[c] + lossG[c];
    // 右辺: 発熱 + 固定温度側から流れ込む熱（θ 基準）
    stencil.b[c] += lossGT[c];
  }

  return { stencil, k, fixed, lossG, lossGT, floating, totalHeat, warnings };
}

class HeatSolver implements Solver {
  readonly analysis = 'heat' as const;

  private readonly project: Project;
  private readonly raster: Raster;
  private readonly sys: HeatSystem;
  private readonly cg: PcgSolver | null;
  private readonly history = new SampledSeries();
  private readonly extraWarnings: string[] = [];
  private iteration = 0;
  private res0 = 1;
  private lastResidual = 0;
  private maxProgress = 0;
  private done = false;
  private cache: { iteration: number; result: ResultSet } | null = null;

  constructor(project: Project, raster: Raster) {
    this.project = project;
    this.raster = raster;
    this.sys = assemble(project, raster);

    let solidCount = 0;
    for (let c = 0; c < raster.solid.length; c++) solidCount += raster.solid[c];
    if (solidCount === 0) {
      this.extraWarnings.push('物体がないため、熱解析する対象がありません。形状を追加してください。');
    }

    const s = this.sys.stencil;
    let hasActive = false;
    for (let c = 0; c < s.active.length; c++) {
      if (s.active[c]) {
        hasActive = true;
        break;
      }
    }

    // 駆動項（発熱・固定温度との温度差）が全くなければ θ = 0 が厳密解
    let bNorm = 0;
    for (let c = 0; c < s.b.length; c++) bNorm += s.b[c] * s.b[c];
    if (!hasActive || bNorm === 0) {
      this.cg = null;
      this.done = true;
      this.maxProgress = 1;
    } else {
      this.cg = new PcgSolver(s, new Float64Array(s.b.length));
      this.res0 = this.cg.relResidual;
      this.lastResidual = this.res0;
      this.history.push(0, this.res0);
    }
  }

  step(budgetMs: number): SolverStatus {
    const cg = this.cg;
    if (!this.done && cg) {
      const t0 = performance.now();
      do {
        // 数反復ごとに時刻を確認する
        for (let k = 0; k < 4 && !this.done; k++) {
          cg.iterate();
          this.iteration += 1;
          const rel = cg.relResidual;
          this.lastResidual = rel;
          this.history.push(this.iteration, rel);
          if (!Number.isFinite(rel)) {
            this.done = true;
            this.extraWarnings.push('計算が発散しました。条件（熱伝達率・材料）を見直してください。');
          } else if (rel < TOLERANCE) {
            this.done = true;
          } else if (this.iteration >= MAX_ITERATIONS) {
            this.done = true;
            this.extraWarnings.push(
              `最大反復回数（${MAX_ITERATIONS}回）に達しましたが収束しきっていません（残差 ${rel.toExponential(1)}）。結果は参考値です。`,
            );
          }
        }
      } while (!this.done && performance.now() - t0 < budgetMs);
    }
    const progress = this.done
      ? 1
      : Math.max(this.maxProgress, progressFromResidual(this.lastResidual, this.res0, TOLERANCE));
    this.maxProgress = progress;
    return { done: this.done, progress, iteration: this.iteration, residual: this.lastResidual };
  }

  result(): ResultSet {
    if (this.cache && this.cache.iteration === this.iteration) return this.cache.result;
    const result = this.buildResult();
    this.cache = { iteration: this.iteration, result };
    return result;
  }

  private buildResult(): ResultSet {
    const { nx, ny, h } = this.raster;
    const n = nx * ny;
    const { solid, fixedTemp } = this.raster;
    const { stencil, k, lossG, lossGT, floating } = this.sys;
    const amb = this.project.heat.ambientC;
    const theta = this.cg ? this.cg.x : new Float64Array(n);

    // 温度場: 物体は解、物体のないセルは周囲温度（固定温度セルはその値）
    const temp = new Float64Array(n);
    const tData = new Float32Array(n);
    const tMask = new Uint8Array(n);
    for (let c = 0; c < n; c++) {
      let t = amb;
      if (!Number.isNaN(fixedTemp[c])) t = fixedTemp[c];
      else if (solid[c]) t = amb + theta[c];
      temp[c] = t;
      tData[c] = t;
      tMask[c] = solid[c] && !floating[c] ? 1 : 0;
    }

    // 熱流束 [W/m²]: 物体同士の面を通る伝導熱流束の平均（東西・南北それぞれ）
    const flux = new Float32Array(n);
    const conduct = (c: number, m: number, inside: boolean): number | null => {
      if (!inside || !tMask[m]) return null;
      const kh = (2 * k[c] * k[m]) / (k[c] + k[m]);
      return (kh * (temp[c] - temp[m])) / h; // c から m へ向かう熱流束
    };
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (!tMask[c]) continue;
        const fe = conduct(c, c + 1, i < nx - 1);
        const fw = conduct(c, c - 1, i > 0);
        const fn = conduct(c, c + nx, j < ny - 1);
        const fs = conduct(c, c - nx, j > 0);
        // +x / +y 向きを正とした成分（西・南の面は向きが逆）
        const qxs: number[] = [];
        if (fe !== null) qxs.push(fe);
        if (fw !== null) qxs.push(-fw);
        const qys: number[] = [];
        if (fn !== null) qys.push(fn);
        if (fs !== null) qys.push(-fs);
        const qx = qxs.length ? qxs.reduce((a, b) => a + b, 0) / qxs.length : 0;
        const qy = qys.length ? qys.reduce((a, b) => a + b, 0) / qys.length : 0;
        flux[c] = Math.hypot(qx, qy);
      }
    }

    // 統計: 物体セルのみ
    let tMax = -Infinity;
    let tMin = Infinity;
    let tSum = 0;
    let count = 0;
    for (let c = 0; c < n; c++) {
      if (!tMask[c]) continue;
      if (temp[c] > tMax) tMax = temp[c];
      if (temp[c] < tMin) tMin = temp[c];
      tSum += temp[c];
      count += 1;
    }
    if (count === 0) {
      tMax = amb;
      tMin = amb;
      tSum = amb;
      count = 1;
    }

    // 放熱量 = 周囲・固定温度・辺の境界へ出ていく熱の合計（定常なら発熱量に一致する）
    let heatOut = 0;
    for (let c = 0; c < n; c++) {
      if (stencil.active[c]) heatOut += lossG[c] * theta[c] - lossGT[c];
    }

    const fields: Field[] = [
      // 温度は物体のないセルも周囲温度で埋めているが、色を付けるのは物体セルだけ
      { key: 'temperature', label: '温度', unit: '°C', data: tData, mask: tMask },
      { key: 'heatFlux', label: '熱流束', unit: 'W/m²', data: flux, mask: tMask },
    ];

    const warnings = [...this.sys.warnings, ...this.extraWarnings];
    if (this.hasHeatInFixed()) {
      warnings.push('固定温度のセルの中にある発熱は、固定温度の熱源に吸収されるため集計していません。');
    }

    return {
      analysis: 'heat',
      nx,
      ny,
      h,
      fields,
      scalars: [
        { key: 'maxTemp', label: '最高温度', unit: '°C', value: tMax },
        { key: 'minTemp', label: '最低温度', unit: '°C', value: tMin },
        { key: 'avgTemp', label: '平均温度', unit: '°C', value: tSum / count },
        { key: 'totalHeat', label: '総発熱量', unit: 'W', value: this.sys.totalHeat },
        { key: 'heatOut', label: '放熱量', unit: 'W', value: heatOut },
      ],
      history: [
        {
          key: 'residual',
          label: '残差',
          unit: '',
          t: [...this.history.t],
          values: [...this.history.values],
        },
      ],
      warnings,
    };
  }

  private hasHeatInFixed(): boolean {
    const { fixed } = this.sys;
    for (let c = 0; c < fixed.length; c++) {
      if (fixed[c] && this.raster.heatGen[c] > 0) return true;
    }
    return false;
  }
}

export const createHeatSolver: SolverFactory = (project, raster) => new HeatSolver(project, raster);
