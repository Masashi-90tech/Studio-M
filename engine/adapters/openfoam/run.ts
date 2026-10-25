// OpenFOAM の実行: case の書き出し → メッシュ作成 → 計算 → 結果の読み取り。
// 外部コマンドは必ず ctx.run を通す（PC に直接入っていても Docker でも同じ書き方で動く）。

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobRequest } from '../../../src/core/engine-protocol';
import type { AdapterContext, SolveOutput } from '../../types';
import { blockMeshDict, controlDict, fvSchemes, fvSolution, topoSetDict, transportProperties, turbulenceProperties } from './dicts';
import { fieldCellId, fieldK, fieldNut, fieldOmega, fieldP, fieldU, makeObstacleWall } from './fields';
import { parseInternalField, parseSolverLog, parseTimeLine, scalarListLiteral, vectorListLiteral } from './foamio';
import { type ForceSeries, bodyForce, collectBodyFaces } from './forces';
import { initialVelocity, mapCellsFromIds, mapCellsSorted } from './mesh';
import { planJob, type Plan } from './plan';
import { buildFlowResult } from './results';

const SHORT_MS = 5 * 60 * 1000;
const SOLVER_MS = 6 * 3600 * 1000;

function cancelled(): Error {
  const e = new Error('計算が取り消されました。');
  e.name = 'AbortError';
  return e;
}

/** OpenFOAM のコマンドを実行し、ログを log.<name> に保存する。失敗したら利用者向けの説明つきで例外にする */
async function step(
  ctx: AdapterContext,
  cmd: string,
  args: string[],
  opts: { logName?: string; timeoutMs?: number; onLine?: (line: string) => void; tolerate?: boolean } = {},
): Promise<{ ok: boolean; stdout: string }> {
  if (ctx.signal.aborted) throw cancelled();
  const res = await ctx.run(cmd, args, {
    timeoutMs: opts.timeoutMs ?? SHORT_MS,
    onLine: opts.onLine ? (line, stream) => stream === 'stdout' && opts.onLine!(line) : undefined,
  });
  await writeFile(join(ctx.workDir, `log.${opts.logName ?? cmd}`), res.stdout + (res.stderr ? `\n--- stderr ---\n${res.stderr}` : ''));
  if (ctx.signal.aborted) throw cancelled();
  if (res.code === 0) return { ok: true, stdout: res.stdout };
  if (opts.tolerate) return { ok: false, stdout: res.stdout };
  const text = `${res.stdout}\n${res.stderr}`;
  if (/Could not find mandatory etc entry|did not locate installation path|libOpenFOAM/.test(text)) {
    throw new Error(
      `OpenFOAM の環境が読み込まれていません（${cmd}）。OpenFOAM の bashrc を読み込んだ状態で Studio M Engine を起動するか、` +
        'Debian/Ubuntu のパッケージでは環境変数 WM_PROJECT_DIR=/usr/share/openfoam を設定してください。Docker 版なら設定は不要です。',
    );
  }
  const sum = parseSolverLog(text);
  if (sum.diverged) {
    throw new Error(
      `計算が発散しました（${cmd}、t = ${sum.lastTime ?? '?'}）。流入速度を下げる、格子を細かくする（品質を上げる）、` +
        '物体の鋭い角を丸める、のいずれかを試してください。',
    );
  }
  throw new Error(`OpenFOAM の ${cmd} が失敗しました（終了コード ${res.code}）。${sum.fatal ? `原因: ${sum.fatal}。` : ''}詳しくは log.${opts.logName ?? cmd} を見てください。`);
}

async function put(dir: string, rel: string, text: string): Promise<void> {
  const full = join(dir, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, text);
}

/** 時刻のフォルダ名（0 を除く数字の名前）を時刻の昇順で返す */
async function timeDirs(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => /^[0-9.eE+-]+$/.test(n) && Number.isFinite(Number(n)) && Number(n) > 0);
  return names.sort((a, b) => Number(a) - Number(b));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** メッシュを作る: blockMesh → topoSet → subsetMesh。OpenFOAM のセル → ラスターの対応表を返す */
async function buildMesh(plan: Plan, ctx: AdapterContext): Promise<Int32Array> {
  const { raster, domain, spec } = plan;
  const dir = ctx.workDir;
  await put(dir, 'system/controlDict', controlDict(spec));
  await put(dir, 'system/fvSchemes', fvSchemes(spec));
  await put(dir, 'system/fvSolution', fvSolution(spec));
  await put(dir, 'system/blockMeshDict', blockMeshDict({ nx: raster.nx, ny: raster.ny, h: raster.h, walls: spec.walls }));
  await put(dir, 'system/topoSetDict', topoSetDict(domain.solidLabels));
  await put(dir, 'constant/transportProperties', transportProperties(spec));
  await put(dir, 'constant/turbulenceProperties', turbulenceProperties(spec));

  ctx.progress(0.02, 'blockMesh で格子を作っています', 'meshing');
  await step(ctx, 'blockMesh', []);
  ctx.progress(0.04, 'topoSet で物体のセルを選んでいます', 'meshing');
  await step(ctx, 'topoSet', []);
  ctx.progress(0.06, 'subsetMesh で物体のセルを取り除いています', 'meshing');
  // 元のセル番号（= ラスターの番号）を場として持たせてから部分メッシュにする
  await put(dir, '0/cellId', fieldCellId(spec, scalarListLiteral(Array.from({ length: raster.nx * raster.ny }, (_, c) => c))));
  await step(ctx, 'subsetMesh', ['-overwrite', 'fluidCells', '-patch', 'obstacle']);

  const bpath = join(dir, 'constant/polyMesh/boundary');
  await writeFile(bpath, makeObstacleWall(await readFile(bpath, 'utf8')));

  // subsetMesh が運んだ cellId の場から、OpenFOAM のセル → ラスターのセルの対応を得る
  let cellToRaster: Int32Array;
  try {
    const ids = parseInternalField(await readFile(join(dir, '0/cellId'), 'utf8'), domain.fluidCells);
    cellToRaster = mapCellsFromIds(ids.data, domain);
    ctx.log(`セル対応: subsetMesh が運んだ元の番号から ${cellToRaster.length} セルを対応づけました`);
  } catch (e) {
    ctx.log(`セル番号の場を読めませんでした（${(e as Error).message}）。元の番号の昇順とみなして対応づけます`);
    cellToRaster = mapCellsSorted(domain);
  }
  await rm(join(dir, '0/cellId'), { force: true });
  if (cellToRaster.length !== domain.fluidCells) throw new Error(`メッシュのセル数（${cellToRaster.length}）が想定（${domain.fluidCells}）と違います`);
  return cellToRaster;
}

/** 0/ の初期条件を書く（subsetMesh のあと。セル中心から初期の揺らぎを作る） */
async function writeFields(plan: Plan, ctx: AdapterContext, cellToRaster: Int32Array): Promise<void> {
  const { raster, domain, spec } = plan;
  const dir = ctx.workDir;
  const cx = new Float64Array(cellToRaster.length);
  const cy = new Float64Array(cellToRaster.length);
  for (let c = 0; c < cellToRaster.length; c++) {
    const r = cellToRaster[c];
    cx[c] = ((r % raster.nx) + 0.5) * raster.h;
    cy[c] = (Math.floor(r / raster.nx) + 0.5) * raster.h;
  }
  const { ux, uy } = initialVelocity(cx, cy, { uInf: spec.uInf, bbox: domain.bbox, length: domain.length });
  await put(dir, '0/U', fieldU(spec, vectorListLiteral(ux, uy)));
  await put(dir, '0/p', fieldP(spec));
  if (spec.model !== 'laminar') await put(dir, '0/nut', fieldNut(spec));
  if (spec.model === 'rans') {
    await put(dir, '0/k', fieldK(spec));
    await put(dir, '0/omega', fieldOmega(spec));
  }
}

export async function solveFlow(req: JobRequest, ctx: AdapterContext): Promise<SolveOutput> {
  const plan = planJob(req);
  const { spec, raster, solver } = plan;
  const dir = ctx.workDir;
  ctx.log(`OpenFOAM: ${raster.nx} × ${raster.ny} 格子、${solver}（${spec.model}）、流体セル ${plan.domain.fluidCells}`);

  const cellToRaster = await buildMesh(plan, ctx);
  await writeFields(plan, ctx, cellToRaster);

  // ---- 計算 ----
  const endTime = spec.endTime;
  let lastReported = -1;
  const running = (fraction: number, t: number): void => {
    const what = spec.model === 'rans' ? `反復 ${Math.round(t)} / ${Math.round(endTime)}` : `t = ${Number(t.toPrecision(3))} s`;
    ctx.progress(0.1 + 0.8 * Math.min(1, fraction), `${solver} で計算中（${what}）`, 'running');
  };
  running(0, 0);
  const run = await step(ctx, solver, [], {
    timeoutMs: SOLVER_MS,
    onLine: (line) => {
      const t = parseTimeLine(line);
      if (t === null) return;
      const f = t / endTime;
      if (f - lastReported >= 0.005) {
        lastReported = f;
        running(f, t);
        ctx.log(line.trim());
      }
    },
  });
  const log = parseSolverLog(run.stdout);

  // ---- 結果の読み取り ----
  ctx.progress(0.92, '結果を読んでいます', 'reading');
  const times = await timeDirs(dir);
  if (times.length === 0) throw new Error(`計算結果の時刻フォルダが見つかりません。log.${solver} を見てください。`);
  const n = cellToRaster.length;
  const faces = collectBodyFaces({ cellToRaster, solid: plan.domain.solid, nx: raster.nx, ny: raster.ny });
  const useNut = spec.model !== 'laminar';
  const forces: ForceSeries = { t: [], fx: [], fy: [] };
  let U = parseInternalField(await readFile(join(dir, times[times.length - 1], 'U'), 'utf8'), n);
  let p = U;
  for (const [k, name] of times.entries()) {
    if (ctx.signal.aborted) throw cancelled();
    const Uk = k === times.length - 1 ? U : parseInternalField(await readFile(join(dir, name, 'U'), 'utf8'), n);
    p = parseInternalField(await readFile(join(dir, name, 'p'), 'utf8'), n);
    const nut = useNut ? parseInternalField(await readFile(join(dir, name, 'nut'), 'utf8'), n) : undefined;
    const f = bodyForce({ faces, h: raster.h, rho: plan.rho, nu: plan.nu, U: Uk, p, nut });
    forces.t.push(Number(name));
    forces.fx.push(f.fx);
    forces.fy.push(f.fy);
    U = Uk;
  }
  const finalDir = times[times.length - 1];

  const warnings = [...plan.notes];
  if (spec.model === 'rans') {
    warnings.push(log.convergedAt !== null ? `定常計算は ${log.convergedAt} 反復で収束しました。` : `定常計算は ${Math.round(endTime)} 反復では収束判定に届きませんでした（結果は最後の反復の値です）。`);
  }
  const result = buildFlowResult({
    nx: raster.nx,
    ny: raster.ny,
    h: raster.h,
    cellToRaster,
    U,
    p,
    rho: plan.rho,
    nu: plan.nu,
    uInf: spec.uInf,
    length: spec.length,
    thickness: plan.project.thickness,
    meshDepth: raster.h,
    forces,
    model: spec.model,
    endTime: Number(finalDir),
    warnings,
    solver,
  });

  // ---- 利用者に渡すファイル（名前は階層なし） ----
  const files: SolveOutput['files'] = [];
  const addFile = async (name: string, description: string): Promise<void> => {
    files.push({ name, description });
  };
  const addCopy = async (from: string, name: string, description: string): Promise<void> => {
    if (!(await exists(join(dir, from)))) return;
    if (from !== name) await copyFile(join(dir, from), join(dir, name));
    await addFile(name, description);
  };
  await addCopy('system/controlDict', 'controlDict', 'OpenFOAM の controlDict（時間・出力の設定）');
  await addCopy(`log.${solver}`, `log.${solver}`, `${solver} の計算ログ`);
  const k = plan.project.thickness / raster.h;
  const csv = ['time,drag_N,lift_N', ...forces.t.map((t, q) => `${t},${forces.fx[q] * k},${forces.fy[q] * k}`)].join('\n');
  await writeFile(join(dir, 'forces.csv'), csv + '\n');
  await addFile('forces.csv', '物体にかかる力の時間変化（抗力・揚力 [N]、厚さ込み）');

  ctx.progress(0.96, 'ParaView 用の結果（VTK）を書き出しています', 'reading');
  // 途中の時刻は力を求めたら不要。最後の時刻だけ残して VTK にする
  for (const name of times.slice(0, -1)) await rm(join(dir, name), { recursive: true, force: true });
  const vtk = await step(ctx, 'foamToVTK', ['-latestTime'], { tolerate: true });
  let hasVtk = false;
  if (vtk.ok && (await exists(join(dir, 'VTK')))) {
    for (const d of await readdir(join(dir, 'VTK'))) {
      await addCopy(`VTK/${d}/internal.vtu`, 'result.vtu', 'ParaView 用の結果（流体セル全体）');
      await addCopy(`VTK/${d}/boundary/obstacle.vtp`, 'result_obstacle.vtp', 'ParaView 用の結果（物体表面）');
      hasVtk = files.some((f) => f.name === 'result.vtu');
      if (hasVtk) break;
    }
  }
  if (!hasVtk) ctx.log('foamToVTK が使えなかったため、ParaView 用の結果は出していません');
  return { result, files };
}
