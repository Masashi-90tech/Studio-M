// 強度解析（2D 平面応力）を CalculiX で解く。
//
// 流れ: 格子化（Lite と同じ規則 + quality）→ 要素分割（mesh.ts）→ .inp（inp.ts）→ ccx → .dat を読む（dat.ts）
//       → セルの値に戻す（results.ts）→ ParaView 用の VTK（vtk.ts）。
// 塑性ありのときは、先に弾性だけの計算（降伏荷重の見積もり）をしてから、荷重を増やしながら弾塑性で解く。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JobRequest } from '../../../src/core/engine-protocol';
import { rasterize } from '../../../src/core/raster';
import type { ResultSet } from '../../../src/core/types';
import type { AdapterContext, SolveOutput } from '../../types';
import { checkBalance } from './balance';
import { explainFailure, listJobFiles, readDatIfAny, runCcx, SAFETY_CAP, throwIfAborted } from './ccx-run';
import { lastBlock, parseDat, type DatBlock } from './dat';
import { writeInp } from './inp';
import { buildMesh, MeshError, type Mesh } from './mesh';
import { chooseGrid, parseStressOptions, type PlaneStressElement, type StressOptions } from './options';
import { mapResults, toResultSet } from './results';
import { writeVtk } from './vtk';

export async function solveStress(req: JobRequest, ctx: AdapterContext): Promise<SolveOutput> {
  const opts: StressOptions = parseStressOptions(req.options);

  ctx.progress(0.02, '格子を作っています', 'meshing');
  const grid = chooseGrid({ project: req.project, analysis: 'stress', quality: req.quality });
  const raster = rasterize(grid.project);
  // おまかせ: 弾性は Lite と同じ CPS4、塑性は体積ロッキングを避けられる CPS8R
  const elementType: PlaneStressElement = opts.elementType === 'auto' ? (opts.plasticity ? 'CPS8R' : 'CPS4') : opts.elementType;
  const selfWeight = grid.project.stress.selfWeight;
  let mesh: Mesh;
  try {
    mesh = buildMesh({ project: grid.project, raster, elementType, selfWeight });
  } catch (e) {
    if (e instanceof MeshError) throw new Error(e.message);
    throw e;
  }
  if (mesh.appliedLoad === 0 && !selfWeight) {
    throw new Error('荷重も自重もないため、応力と変位はゼロです。荷重を置くか、自重を有効にしてください。');
  }
  throwIfAborted(ctx);
  ctx.log(`要素 ${mesh.elementCell.length}（${elementType}）、節点 ${mesh.nodeCount}、格子 ${mesh.nx}×${mesh.ny}`);

  const baseInp = { largeDeformation: opts.largeDeformation, hardeningPercent: opts.hardeningPercent };
  let yieldLoadFactor: number | undefined;

  // ----- 塑性あり: 先に弾性だけで解き、降伏し始める荷重の倍率を見積もる -----
  if (opts.plasticity) {
    await fs.writeFile(path.join(ctx.workDir, 'elastic.inp'), writeInp(mesh, { ...baseInp, plasticity: false, loadScale: 1, title: '弾性のみ（降伏荷重の見積もり）' }));
    const r = await runCcx(ctx, 'elastic', { progressFrom: 0.1, progressTo: 0.3, message: 'CalculiX で弾性の計算をしています' });
    const dat = await readDatIfAny(path.join(ctx.workDir, 'elastic.dat'));
    if (r.code === 0 && dat) {
      try {
        const m = mapResults(mesh, parseDat(dat), { plasticity: false });
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
  await fs.writeFile(path.join(ctx.workDir, `${job}.inp`), writeInp(mesh, { ...baseInp, plasticity: opts.plasticity, loadScale, title }));
  const from = opts.plasticity ? 0.35 : 0.1;
  const run = await runCcx(ctx, job, {
    progressFrom: from,
    progressTo: 0.9,
    message: opts.plasticity ? 'CalculiX で荷重を増やしながら解いています' : 'CalculiX で解いています',
  });
  throwIfAborted(ctx);
  let datText = await readDatIfAny(path.join(ctx.workDir, `${job}.dat`));
  if (run.code !== 0 || !datText) {
    throw new Error(explainFailure(run.output, { plasticity: opts.plasticity, largeDeformation: opts.largeDeformation, yieldLoadFactor }));
  }

  ctx.progress(0.92, '結果を読み取っています', 'reading');
  let blocks = parseDat(datText);
  // 力の釣り合いの検算: 合わないときは、すべて 1 スレッドで 1 回だけやり直す（実験 4。docs/EXPERIMENT-4.md）
  let balance = checkSupportBalance(mesh, blocks, loadScale);
  if (balance && !balance.ok) {
    ctx.log(`反力が荷重と釣り合っていません（差 ${balance.residual.toPrecision(4)} N、荷重 ${balance.load.toPrecision(4)} N）。すべて 1 スレッドで、もう一度計算します`);
    const retry = await runCcx(ctx, job, { progressFrom: 0.9, progressTo: 0.92, message: 'CalculiX で解き直しています', allSingleThread: true });
    throwIfAborted(ctx);
    datText = await readDatIfAny(path.join(ctx.workDir, `${job}.dat`));
    if (retry.code !== 0 || !datText) {
      throw new Error(explainFailure(retry.output, { plasticity: opts.plasticity, largeDeformation: opts.largeDeformation, yieldLoadFactor }));
    }
    blocks = parseDat(datText);
    balance = checkSupportBalance(mesh, blocks, loadScale);
    if (balance && !balance.ok) {
      throw new Error(
        '計算結果が荷重と釣り合っていません（支持の反力と荷重が合いません）。計算ソフトが間違った答えを出した可能性があります。' +
          '1 スレッドでやり直しても同じだったので、格子の細かさ（品質）を変える、形や支持・荷重の置き方を少し変えるなどして、もう一度計算してください。',
      );
    }
    ctx.log('やり直した結果は荷重と釣り合っていました');
  }
  const mapped = mapResults(mesh, blocks, { plasticity: opts.plasticity, loadScale });
  if (opts.plasticity && yieldLoadFactor !== undefined) {
    mapped.scalars.push({ key: 'yieldLoadFactor', label: '降伏し始める荷重（今の荷重の倍率）', unit: '倍', value: yieldLoadFactor });
  }

  // ----- 利用者への注意 -----
  const warnings: string[] = [`CalculiX（2D 平面応力・${elementType}）で解きました`, grid.note, ...mesh.warnings, ...mapped.notes];
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
    warnings.push('塑性は完全弾塑性（降伏後は応力が増えない）の近似です。応力集中の角では、格子を細かくするほど結果が変わります。');
  } else if (mapped.minSafety < 1) {
    warnings.push(`降伏応力を超えています（安全率 ${mapped.minSafety.toFixed(2)}）。「塑性も計算する」を入れると、降伏後の変形を見られます。`);
  } else if (mapped.minSafety < 2) {
    warnings.push(`安全率が低めです（${mapped.minSafety.toFixed(2)}）。繰り返し荷重や衝撃がある場合は余裕を持たせてください。`);
  }
  warnings.push('支持や荷重の角では応力が集中し、格子を細かくするほど最大応力が大きく出る傾向があります。');
  warnings.push('2D平面応力による近似です。3Dプリント品は積層方向（Z）の強度が低く、実際はより弱くなることがあります。');

  const result: ResultSet = toResultSet(mesh, mapped, warnings);

  // ParaView 用の VTK
  await fs.writeFile(
    path.join(ctx.workDir, `${job}.vtk`),
    writeVtk({ nx: mesh.nx, ny: mesh.ny, h: mesh.h, thickness: mesh.thickness, title: `Studio M ${req.project.name} (CalculiX)`, fields: result.fields, mask: mesh.included }),
  );

  const files = await listJobFiles(ctx.workDir, job);
  ctx.progress(1, '完了', 'reading');
  return { result, files };
}


/**
 * 支持の反力と荷重の釣り合いを確かめる。.dat に反力（NSUP の total force）がなければ null（確かめられない）。
 * 支持の節点に直接かけた荷重は拘束に吸われて RF に出ないので、数えない。
 */
function checkSupportBalance(mesh: Mesh, blocks: DatBlock[], loadScale: number): ReturnType<typeof checkBalance> | null {
  const rf = lastBlock(blocks, 'totalForce', 'NSUP');
  if (!rf || rf.values.length < 2) return null;
  const support = new Set(mesh.supportNodes);
  let ax = 0;
  let ay = 0;
  for (const [n, f] of mesh.nodalLoads) {
    if (support.has(n)) continue;
    ax += f.fx * loadScale;
    ay += f.fy * loadScale;
  }
  return checkBalance({ reaction: { x: rf.values[0], y: rf.values[1] }, applied: { x: ax, y: ay } });
}
