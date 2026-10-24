// スカラー解析ソルバー（レベル①）: 一様流 u の中の定常な対流拡散方程式（有限体積法）。
// 動画「CFD by hand」の Excel と同じ離散化（Versteeg & Malalasekera のハイブリッド法）を使う。
//
//     ∂(ρ u φ)/∂x = ∂/∂x(Γ ∂φ/∂x) + ∂/∂y(Γ ∂φ/∂y)
//
// 流速は解かない（流体のあるセルすべてで x 方向に一様な u）。未知数は物体のないセルの φ。
// 連立方程式は非対称なので SOR（辞書式 Gauss–Seidel + 過緩和）で解く。

import type { Field, Project, Raster, ResultSet, Solver, SolverFactory, SolverStatus } from '../core/types';
import { SampledSeries, createStencil, progressFromResidual, residualL1, sorSweep, type Stencil5 } from './linear';

/** 収束判定: 規格化した残差（Σ|r| / Σ aP·|φ入口−φ物体|）がこれを下回れば収束。1e-8 で打ち切り誤差は φ のレンジの 1e-4 程度 */
const TOLERANCE = 1e-8;
const MAX_ITERATIONS = 200000;

/** scalarCoefficients の戻り値。すべて長さ nx*ny、インデックスは j * nx + i */
export interface ScalarCoefficients {
  nx: number;
  ny: number;
  /** 1 = 流体セル（未知数）。0 = 物体セル（φ = phiBody の境界として扱う） */
  unknown: Uint8Array;
  aP: Float64Array;
  aE: Float64Array;
  aW: Float64Array;
  aN: Float64Array;
  aS: Float64Array;
  /** 境界（入口・物体表面）に接する面の係数の合計。aP に含まれ、b にも φ_境界 を掛けて入る */
  aB: Float64Array;
  /** 右辺の定数項（境界の寄与 Σ a_境界 · φ_境界） */
  b: Float64Array;
  /** 離散化の説明（Excel 出力などの注記用） */
  description: string;
}

/**
 * スカラー輸送の離散化係数を作る。ソルバーと Excel 出力で同じ式を使うための共通関数。
 *
 * 各流体セルの式:  aP·φP = aE·φE + aW·φW + aN·φN + aS·φS + b
 *  - 面の流量 F = ρ·u·h、拡散コンダクタンス D = Γ（= Γ·h/h、奥行き 1）
 *  - ハイブリッド法: aE = max(−F, D − F/2, 0)、aW = max(F, D + F/2, 0)、aN = aS = D（y 方向の対流なし）
 *  - 左端（入口）: φ = phiInlet、境界面はセル中心から h/2 なので拡散は 2D。aW = max(F, 2D + F/2, 0) を
 *    aB と b（= aW·phiInlet）に入れる
 *  - 右端（出口）: 勾配ゼロなので aE = 0（東側の項を作らない）
 *  - 上下端: 対称（流束ゼロ）なので北・南の項を作らない
 *  - 物体に接する面: 表面 φ = phiBody、距離 h/2 なので 2D（対流は通さない）を aB と b に入れる
 *  - aP = aE + aW + aN + aS + aB（連続の式 Fe = Fw を使うので ΔF の項は省く）
 * 物体セルの行は全部 0 のまま返す。
 */
export function scalarCoefficients(project: Project, raster: Raster): ScalarCoefficients {
  const { nx, ny, h } = raster;
  const n = nx * ny;
  const { u, gamma, rho, phiInlet, phiBody } = project.scalar;
  const F = rho * u * h;
  const D = gamma;

  const unknown = new Uint8Array(n);
  const aP = new Float64Array(n);
  const aE = new Float64Array(n);
  const aW = new Float64Array(n);
  const aN = new Float64Array(n);
  const aS = new Float64Array(n);
  const aB = new Float64Array(n);
  const b = new Float64Array(n);

  const hybridE = Math.max(-F, D - F / 2, 0);
  const hybridW = Math.max(F, D + F / 2, 0);
  const inletW = Math.max(F, 2 * D + F / 2, 0);

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (raster.solid[c]) continue;
      unknown[c] = 1;

      // 物体表面（φ = phiBody、距離 h/2）
      const wall = (coef: number) => {
        aB[c] += coef;
        b[c] += coef * phiBody;
      };

      // 東
      if (i < nx - 1) {
        if (raster.solid[c + 1]) wall(2 * D);
        else aE[c] = hybridE;
      } // 右端は出口（勾配ゼロ）
      // 西
      if (i > 0) {
        if (raster.solid[c - 1]) wall(2 * D);
        else aW[c] = hybridW;
      } else {
        aB[c] += inletW;
        b[c] += inletW * phiInlet;
      }
      // 北・南（上下端は対称で何もしない）
      if (j < ny - 1) {
        if (raster.solid[c + nx]) wall(2 * D);
        else aN[c] = D;
      }
      if (j > 0) {
        if (raster.solid[c - nx]) wall(2 * D);
        else aS[c] = D;
      }
      aP[c] = aE[c] + aW[c] + aN[c] + aS[c] + aB[c];
    }
  }

  return {
    nx,
    ny,
    unknown,
    aP,
    aE,
    aW,
    aN,
    aS,
    aB,
    b,
    description:
      'ハイブリッド法の有限体積法。aE = max(−F, D−F/2, 0)、aW = max(F, D+F/2, 0)、aN = aS = D、' +
      'aP = aE+aW+aN+aS+境界の係数。入口は φ固定（面距離 h/2）、出口は勾配ゼロ、上下は対称、物体表面は φ固定で対流は通さない。',
  };
}

/** セルペクレ数 |F|/D に応じた SOR の緩和係数（対流が強いほど過緩和は控えめにする） */
function omegaFor(project: Project, h: number): number {
  const { u, gamma, rho } = project.scalar;
  if (!(gamma > 0)) return 1;
  const pe = Math.abs(rho * u * h) / gamma;
  if (pe < 0.5) return 1.9;
  if (pe < 1.5) return 1.5;
  if (pe < 4) return 1.2;
  return 1.0;
}

class ScalarSolver implements Solver {
  readonly analysis = 'scalar' as const;

  private readonly project: Project;
  private readonly raster: Raster;
  private readonly coef: ScalarCoefficients;
  private readonly sys: Stencil5;
  private readonly x: Float64Array;
  private omega: number;
  /** これまでの最小残差（発散検知用） */
  private minResidual = Infinity;
  /** 残差を規格化する基準 Σ aP · |φ の代表差| */
  private readonly norm: number;
  private readonly history = new SampledSeries();
  private readonly warnings: string[] = [];
  private iteration = 0;
  private residual = 1;
  private res0 = 1;
  private maxProgress = 0;
  private done = false;
  private cache: { iteration: number; result: ResultSet } | null = null;

  constructor(project: Project, raster: Raster) {
    this.project = project;
    this.raster = raster;
    this.coef = scalarCoefficients(project, raster);
    const { nx, ny, unknown, aP, aE, aW, aN, aS, b } = this.coef;
    const s = createStencil(nx, ny);
    s.active.set(unknown);
    s.aP.set(aP);
    s.aE.set(aE);
    s.aW.set(aW);
    s.aN.set(aN);
    s.aS.set(aS);
    s.b.set(b);
    this.sys = s;

    const { phiInlet, phiBody, u, gamma, rho } = project.scalar;
    this.x = new Float64Array(nx * ny).fill(phiInlet);
    this.omega = omegaFor(project, raster.h);

    let sumAP = 0;
    let fluidCount = 0;
    for (let c = 0; c < aP.length; c++) {
      if (unknown[c]) {
        sumAP += aP[c];
        fluidCount += 1;
      }
    }
    const scale = Math.max(Math.abs(phiInlet - phiBody), 1e-12);
    this.norm = Math.max(sumAP * scale, 1e-300);

    if (fluidCount === 0) {
      this.warnings.push('流体のセルがありません。物体が領域全体を覆っています。');
      this.done = true;
    } else if (Math.abs(rho * u * raster.h) / Math.max(gamma, 1e-300) > 2) {
      this.warnings.push(
        'セルペクレ数（ρ·u·h/Γ）が 2 を超えています。ハイブリッド法は上流差分に切り替わり、数値拡散で φ が実際よりなまります。' +
          '格子を細かくするか、Γ を大きくしてください。',
      );
    }
    if (!this.done) {
      this.residual = residualL1(s, this.x) / this.norm;
      this.res0 = this.residual;
      this.history.push(0, this.residual);
      if (this.residual < TOLERANCE) this.done = true;
    }
    if (this.done) this.maxProgress = 1;
  }

  step(budgetMs: number): SolverStatus {
    if (!this.done) {
      const t0 = performance.now();
      do {
        // 5 掃引ごとに残差を評価し、時刻を確認する
        for (let k = 0; k < 5; k++) sorSweep(this.sys, this.x, this.omega);
        this.iteration += 5;
        this.residual = residualL1(this.sys, this.x) / this.norm;
        this.history.push(this.iteration, this.residual);
        this.minResidual = Math.min(this.minResidual, this.residual);
        if (!(this.residual < 50 * this.minResidual) && this.omega > 1) {
          // 過緩和が強すぎて発散しかけている: 緩和を弱めて初期値からやり直す
          this.omega = 1 + (this.omega - 1) / 2;
          if (this.omega < 1.05) this.omega = 1;
          this.x.fill(this.project.scalar.phiInlet);
          this.minResidual = Infinity;
          this.residual = this.res0;
        } else if (!Number.isFinite(this.residual)) {
          this.done = true;
          this.warnings.push('計算が発散しました。条件（流速・拡散係数）を見直してください。');
        } else if (this.residual < TOLERANCE) {
          this.done = true;
        } else if (this.iteration >= MAX_ITERATIONS) {
          this.done = true;
          this.warnings.push(
            `最大反復回数（${MAX_ITERATIONS}回）に達しましたが収束しきっていません（残差 ${this.residual.toExponential(1)}）。結果は参考値です。`,
          );
        }
      } while (!this.done && performance.now() - t0 < budgetMs);
    }
    const progress = this.done
      ? 1
      : Math.max(this.maxProgress, progressFromResidual(this.residual, this.res0, TOLERANCE));
    this.maxProgress = progress;
    return { done: this.done, progress, iteration: this.iteration, residual: this.residual };
  }

  result(): ResultSet {
    if (this.cache && this.cache.iteration === this.iteration) return this.cache.result;
    const result = this.buildResult();
    this.cache = { iteration: this.iteration, result };
    return result;
  }

  private buildResult(): ResultSet {
    const { nx, ny, h, solid } = this.raster;
    const n = nx * ny;
    const phiBody = this.project.scalar.phiBody;
    const data = new Float32Array(n);
    const mask = new Uint8Array(n);
    let phiMin = Infinity;
    let phiMax = -Infinity;
    for (let c = 0; c < n; c++) {
      if (solid[c]) {
        data[c] = phiBody; // 物体の中は表面の値で埋める（描画はマスクで除外）
        continue;
      }
      const v = this.x[c];
      data[c] = v;
      mask[c] = 1;
      if (v < phiMin) phiMin = v;
      if (v > phiMax) phiMax = v;
    }
    if (phiMin === Infinity) {
      phiMin = phiBody;
      phiMax = phiBody;
    }

    const fields: Field[] = [{ key: 'phi', label: 'φ', unit: '', data, mask }];
    return {
      analysis: 'scalar',
      nx,
      ny,
      h,
      fields,
      scalars: [
        { key: 'phiMin', label: 'φ最小', unit: '', value: phiMin },
        { key: 'phiMax', label: 'φ最大', unit: '', value: phiMax },
        { key: 'iterations', label: '反復回数', unit: '回', value: this.iteration },
      ],
      history: [{ key: 'residual', label: '残差', unit: '', t: [...this.history.t], values: [...this.history.values] }],
      warnings: [...this.warnings],
    };
  }
}

export const createScalarSolver: SolverFactory = (project, raster) => new ScalarSolver(project, raster);
