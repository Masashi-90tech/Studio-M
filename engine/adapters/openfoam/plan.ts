// ジョブ（JobRequest）→ 計算の計画（格子・モデル・時間の刻み）を決める。ファイルや実行には触れない。

import { resolveProject } from '../../../src/core/auto';
import { getMaterial } from '../../../src/core/materials';
import { rasterize } from '../../../src/core/raster';
import type { JobQuality, JobRequest } from '../../../src/core/engine-protocol';
import type { Project, Raster } from '../../../src/core/types';
import type { CaseSpec, FlowModel } from './dicts';
import { prepareDomain, type FluidDomain } from './mesh';

/** 全セル数の上限（1 コアの OpenFOAM で現実的な時間に収める） */
export const CELLS_MAX = 300_000;
/** 途中経過の書き出しの回数の範囲と、書き出す場の合計セル数（回数 × セル数）の上限 */
const SNAPSHOTS_MIN = 20;
const SNAPSHOTS_MAX = 400;
const SNAPSHOT_CELLS_MAX = 6_000_000;

/** 力の時間変化を取るための書き出し回数。多いほど渦放出の周期が細かく分かるが、ディスクを使う */
export function snapshotCount(flowThroughs: number, fluidCells: number): number {
  const want = Math.round(flowThroughs * 40);
  const byDisk = Math.floor(SNAPSHOT_CELLS_MAX / Math.max(1, fluidCells));
  return Math.max(SNAPSHOTS_MIN, Math.min(SNAPSHOTS_MAX, want, Math.max(SNAPSHOTS_MIN, byDisk)));
}

/** 品質ごとの格子の細かさ（draft = Lite と同じ格子） */
const QUALITY_SCALE: Record<JobQuality, number> = { draft: 1, standard: 1.5, fine: 2 };
/** モデルの自動選択のしきい値（Re） */
export const RE_LAMINAR_MAX = 1000;
export const RE_LES_MAX = 20_000;

export interface FoamOptions {
  model: 'auto' | FlowModel;
  flowThroughs: number;
  /** 流入の乱流強度 [%] */
  turbulenceIntensity: number;
}

export interface Plan {
  project: Project;
  raster: Raster;
  domain: FluidDomain;
  spec: CaseSpec;
  options: FoamOptions;
  /** 使うソルバー */
  solver: 'pimpleFoam' | 'simpleFoam';
  /** ResultSet.warnings に足す、格子や条件についての注意 */
  notes: string[];
  rho: number;
  nu: number;
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function readOptions(raw: JobRequest['options']): FoamOptions {
  const model = raw?.model;
  return {
    model: model === 'laminar' || model === 'les' || model === 'rans' ? model : 'auto',
    flowThroughs: Math.min(100, Math.max(0.5, num(raw?.flowThroughs, 2))),
    turbulenceIntensity: Math.min(20, Math.max(0.05, num(raw?.turbulenceIntensity, 1))),
  };
}

/** Re からモデルを選ぶ（自動のとき） */
export function pickModel(re: number): FlowModel {
  if (re < RE_LAMINAR_MAX) return 'laminar';
  if (re < RE_LES_MAX) return 'les';
  return 'rans';
}

/** 品質に応じて nx を増やし、全セル数が上限を超えないよう減らす */
export function scaleNx(project: Project, nx: number, quality: JobQuality): { nx: number; capped: boolean } {
  let v = Math.max(8, Math.round(nx * QUALITY_SCALE[quality]));
  const rows = (k: number): number => Math.max(1, Math.round(project.domain.height / (project.domain.width / k)));
  let capped = false;
  while (v > 8 && v * rows(v) > CELLS_MAX) {
    v--;
    capped = true;
  }
  return { nx: v, capped };
}

export function planJob(req: JobRequest): Plan {
  const options = readOptions(req.options);
  const quality = req.quality ?? 'draft';
  const resolved = resolveProject(req.project, 'flow');
  const { nx, capped } = scaleNx(resolved.project, resolved.project.domain.nx, quality);
  const project: Project = { ...resolved.project, domain: { ...resolved.project.domain, nx } };
  const raster = rasterize(project);
  const domain = prepareDomain(raster);

  const notes: string[] = [];
  if (capped) notes.push(`格子が多すぎるため、全セル数の上限（${CELLS_MAX.toLocaleString('ja-JP')}）に収まるよう粗くしました。`);
  if (quality !== 'draft' || raster.nx !== resolved.grid.nx) {
    notes.push(`格子は Lite（${resolved.grid.nx} × ${resolved.grid.ny}）から変えて ${raster.nx} × ${raster.ny} にしています。結果の格子もこの大きさです。`);
  }
  if (domain.pocketCells > 0) {
    notes.push(`物体に囲まれて出入口とつながらない空洞（${domain.pocketCells} セル）は、固体として扱いました。`);
  }

  const fluid = getMaterial(project.flow.fluidId);
  const nu = fluid.viscosity ?? 1.5e-5;
  const rho = fluid.rho;
  const uInf = Math.abs(project.flow.inletVelocity);
  if (!(uInf > 1e-9)) {
    throw new Error('流入速度が 0 です。OpenFOAM では流れのない状態は解けないため、流入速度を 0 より大きくしてください。');
  }
  if (project.flow.inletVelocity < 0) notes.push('流入速度が負です。流れは常に +x 方向（左から右）として、大きさだけを使います。');

  const re = (uInf * domain.length) / nu;
  const model: FlowModel = options.model === 'auto' ? pickModel(re) : options.model;
  if (options.model === 'laminar' && re > 5000) {
    notes.push(`Re=${Math.round(re)} を層流モデルで解いています。実際の流れは乱流なので、結果は参考程度にしてください。`);
  }
  if (model === 'les' && domain.length / domain.h < 20) {
    notes.push('物体の高さが格子 20 個分に満たないため、LES の渦の解像度が足りません。品質を上げてください。');
  }

  const width = raster.nx * raster.h;
  const flowThrough = width / uInf;
  const steady = model === 'rans';
  const endTime = steady
    ? Math.min(5000, Math.max(300, Math.round(options.flowThroughs * raster.nx)))
    : options.flowThroughs * flowThrough;

  const spec: CaseSpec = {
    model,
    uInf,
    nu,
    rho,
    walls: project.flow.walls,
    length: domain.length,
    endTime,
    deltaT: steady ? 1 : (0.2 * raster.h) / uInf,
    maxDeltaT: (1.0 * raster.h) / uInf, // 自由流でクーラン数 1 を超えない
    maxCo: 0.7,
    intensity: options.turbulenceIntensity / 100,
    snapshots: snapshotCount(options.flowThroughs, domain.fluidCells),
    residualControl: true,
  };
  return { project, raster, domain, spec, options, solver: steady ? 'simpleFoam' : 'pimpleFoam', notes, rho, nu };
}
