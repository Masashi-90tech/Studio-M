// 強度解析（2D 平面応力）を CalculiX で解く。
//
// 流れ: 格子化（Lite と同じ規則 + quality）→ 要素分割（mesh.ts）→ .inp（inp.ts）→ ccx → .dat を読む（dat.ts）
//       → セルの値に戻す（results.ts）→ ParaView 用の VTK（vtk.ts）。
// 塑性ありのときは、先に弾性だけの計算（降伏荷重の見積もり）をしてから、荷重を増やしながら弾塑性で解く。
// メッシュの作り方は 2 通り（オプション mesher）: 格子（上の流れ・既定）と、gmsh の形に沿った三角形（stress-gmsh.ts）。
// どちらも PreparedMesh（prepared.ts）にして返し、解く流れはその違いを知らない。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JobRequest } from '../../../src/core/engine-protocol';
import { rasterize } from '../../../src/core/raster';
import type { ResultSet } from '../../../src/core/types';
import type { AdapterContext, SolveOutput } from '../../types';
import { explainFailure, listJobFiles, readDatIfAny, runCcx, SAFETY_CAP, throwIfAborted } from './ccx-run';
import { parseDat } from './dat';
import { writeInp } from './inp';
import { buildMesh, MeshError } from './mesh';
import { chooseGrid, parseStressOptions, type PlaneStressElement, type StressOptions } from './options';
import type { PreparedMesh } from './prepared';
import { mapResults, toResultSet } from './results';
import { prepareShaped } from './stress-gmsh';
import { writeVtk } from './vtk';

/** 格子（Lite と同じ正方格子）でメッシュを作る */
function prepareGrid(args: { req: JobRequest; opts: StressOptions }): PreparedMesh {
  const { req, opts } = args;
  const grid = chooseGrid({ project: req.project, analysis: 'stress', quality: req.quality });
  const raster = rasterize(grid.project);
  // おまかせ: 弾性は Lite と同じ CPS4、塑性は体積ロッキングを避けられる CPS8R
  const elementType: PlaneStressElement = opts.elementType === 'auto' ? (opts.plasticity ? 'CPS8R' : 'CPS4') : opts.elementType;
  const selfWeight = grid.project.stress.selfWeight;
  const mesh = buildMesh({ project: grid.project, raster, elementType, selfWeight });
  return {
    inpMesh: mesh,
    elementLabel: elementType,
    meshWord: '格子',
    elementCount: mesh.elementCell.length,
    appliedLoad: mesh.appliedLoad,
    selfWeight,
    integrationPointCoords: false,
    logLine: `要素 ${mesh.elementCell.length}（${elementType}）、節点 ${mesh.nodeCount}、格子 ${mesh.nx}×${mesh.ny}`,
    intro: [grid.note],
    meshWarnings: mesh.warnings,
    grid: { nx: mesh.nx, ny: mesh.ny, h: mesh.h, thickness: mesh.thickness, mask: mesh.included },
    extraFiles: [],
    map: (datText, o) => mapResults(mesh, parseDat(datText), o),
    toResultSet: (mapped, warnings) => toResultSet(mesh, mapped, warnings),
  };
}

export async function solveStress(req: JobRequest, ctx: AdapterContext): Promise<SolveOutput> {
  const opts: StressOptions = parseStressOptions(req.options);

  let prepared: PreparedMesh;
  try {
    if (opts.mesher === 'gmsh') {
      ctx.progress(0.02, 'メッシュを作っています', 'meshing');
      const grid = chooseGrid({ project: req.project, analysis: 'stress', quality: req.quality });
      prepared = await prepareShaped({ project: grid.project, ctx, selfWeight: grid.project.stress.selfWeight });
    } else {
      ctx.progress(0.02, '格子を作っています', 'meshing');
      prepared = prepareGrid({ req, opts });
    }
  } catch (e) {
    if (e instanceof MeshError) throw new Error(e.message);
    throw e;
  }
  const elementType = prepared.elementLabel;
  if (prepared.appliedLoad === 0 && !prepared.selfWeight) {
    throw new Error('荷重も自重もないため、応力と変位はゼロです。荷重を置くか、自重を有効にしてください。');
  }
  throwIfAborted(ctx);
  ctx.log(prepared.logLine);

  const baseInp = {
    largeDeformation: opts.largeDeformation,
    hardeningPercent: opts.hardeningPercent,
    integrationPointCoords: prepared.integrationPointCoords,
  };
  let yieldLoadFactor: number | undefined;

  // ----- 塑性あり: 先に弾性だけで解き、降伏し始める荷重の倍率を見積もる -----
  if (opts.plasticity) {
    await fs.writeFile(path.join(ctx.workDir, 'elastic.inp'), writeInp(prepared.inpMesh, { ...baseInp, plasticity: false, loadScale: 1, title: '弾性のみ（降伏荷重の見積もり）' }));
    const r = await runCcx(ctx, 'elastic', { progressFrom: 0.1, progressTo: 0.3, message: 'CalculiX で弾性の計算をしています' });
    const dat = await readDatIfAny(path.join(ctx.workDir, 'elastic.dat'));
    if (r.code === 0 && dat) {
      try {
        const m = prepared.map(dat, { plasticity: false });
        if (m.minSafety < SAFETY_CAP) yieldLoadFactor = m.minSafety;
      } catch {
        /* 見積もれなくても本計算は続ける */
      }
    }
    throwIfAborted(ctx);
  }

  // ----- 本計算 -----
  const job = 'job';
  const loadScale = opts.plasticity ? opts.loadFactor : 1;
  const title = `${req.project.name} / ${opts.plasticity ? '弾塑性' : '線形弾性'} / ${elementType}`;
  await fs.writeFile(path.join(ctx.workDir, `${job}.inp`), writeInp(prepared.inpMesh, { ...baseInp, plasticity: opts.plasticity, loadScale, title }));
  const from = opts.plasticity ? 0.35 : 0.1;
  const run = await runCcx(ctx, job, {
    progressFrom: from,
    progressTo: 0.9,
    message: opts.plasticity ? 'CalculiX で荷重を増やしながら解いています' : 'CalculiX で解いています',
  });
  throwIfAborted(ctx);
  const datText = await readDatIfAny(path.join(ctx.workDir, `${job}.dat`));
  if (run.code !== 0 || !datText) {
    throw new Error(explainFailure(run.output, { plasticity: opts.plasticity, largeDeformation: opts.largeDeformation, yieldLoadFactor }));
  }

  ctx.progress(0.92, '結果を読み取っています', 'reading');
  const mapped = prepared.map(datText, { plasticity: opts.plasticity, loadScale });
  if (opts.plasticity && yieldLoadFactor !== undefined) {
    mapped.scalars.push({ key: 'yieldLoadFactor', label: '降伏し始める荷重（今の荷重の倍率）', unit: '倍', value: yieldLoadFactor });
  }

  // ----- 利用者への注意 -----
  const warnings: string[] = [`CalculiX（2D 平面応力・${elementType}）で解きました`, ...prepared.intro, ...prepared.meshWarnings, ...mapped.notes];
  if (opts.largeDeformation) warnings.push('大きな変形（幾何学的非線形）を考慮しています。');
  if (opts.plasticity) {
    const factorText = loadScale === 1 ? '' : `荷重を ${loadScale} 倍まで増やして`;
    if (mapped.yieldedArea > 0) {
      warnings.push(
        `${factorText}降伏した部分があります（物体の ${(mapped.yieldedArea * 100).toFixed(1)}% が塑性変形）。` +
          (yieldLoadFactor !== undefined ? `降伏し始める荷重は、今の荷重のおよそ ${yieldLoadFactor.toFixed(2)} 倍です。` : ''),
      );
    } else {
      warnings.push(
        `${factorText}降伏した部分はありません。` +
          (yieldLoadFactor !== undefined ? `降伏し始める荷重は、今の荷重のおよそ ${yieldLoadFactor.toFixed(2)} 倍です。「荷重の倍率」を上げると降伏の様子が見られます。` : ''),
      );
    }
    warnings.push('塑性は完全弾塑性（降伏後は応力が増えない）の近似です。応力集中の角では、' + prepared.meshWord + 'を細かくするほど結果が変わります。');
  } else if (mapped.minSafety < 1) {
    warnings.push(`降伏応力を超えています（安全率 ${mapped.minSafety.toFixed(2)}）。「塑性も計算する」を入れると、降伏後の変形を見られます。`);
  } else if (mapped.minSafety < 2) {
    warnings.push(`安全率が低めです（${mapped.minSafety.toFixed(2)}）。繰り返し荷重や衝撃がある場合は余裕を持たせてください。`);
  }
  warnings.push(`支持や荷重の角では応力が集中し、${prepared.meshWord}を細かくするほど最大応力が大きく出る傾向があります。`);
  warnings.push('2D平面応力による近似です。3Dプリント品は積層方向（Z）の強度が低く、実際はより弱くなることがあります。');

  const result: ResultSet = prepared.toResultSet(mapped, warnings);

  // ParaView 用の VTK（Lite と同じ格子の結果）
  await fs.writeFile(
    path.join(ctx.workDir, `${job}.vtk`),
    writeVtk({
      nx: prepared.grid.nx,
      ny: prepared.grid.ny,
      h: prepared.grid.h,
      thickness: prepared.grid.thickness,
      title: `Studio M ${req.project.name} (CalculiX)`,
      fields: result.fields,
      mask: prepared.grid.mask,
    }),
  );

  const files = [...(await listJobFiles(ctx.workDir, job)), ...prepared.extraFiles];
  ctx.progress(1, '完了', 'reading');
  return { result, files };
}
