// 熱解析（定常熱伝導）を CalculiX で解く。
//
// 流れ: 格子化（Lite と同じ規則 + quality）→ 厚さ 1 要素の板に分割（heat-mesh.ts）→ .inp（heat-inp.ts）→ ccx
//       → .dat を読む（dat.ts）→ セルの値に戻す（heat-results.ts）→ ParaView 用の VTK（vtk.ts）。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JobRequest } from '../../../src/core/engine-protocol';
import { rasterize } from '../../../src/core/raster';
import type { AdapterContext, SolveOutput } from '../../types';
import { explainFailure, listJobFiles, readDatIfAny, runCcx, throwIfAborted } from './ccx-run';
import { parseDat } from './dat';
import { buildHeatMesh } from './heat-mesh';
import { writeHeatInp } from './heat-inp';
import { mapHeatResults, toHeatResultSet } from './heat-results';
import { chooseGrid } from './options';
import { writeVtk } from './vtk';

/** 熱は 3D の板（1 要素厚）なので、強度（平面）より少なめにする */
const MAX_HEAT_CELLS = 150_000;
/** 放熱量と発熱量の差がこれを超えたら注意を出す */
const BALANCE_WARN = 0.02;

export async function solveHeat(req: JobRequest, ctx: AdapterContext): Promise<SolveOutput> {
  ctx.progress(0.02, '格子を作っています', 'meshing');
  const grid = chooseGrid({ project: req.project, analysis: 'heat', quality: req.quality, maxCells: MAX_HEAT_CELLS });
  const raster = rasterize(grid.project);
  const mesh = buildHeatMesh({ project: grid.project, raster });
  throwIfAborted(ctx);
  ctx.log(`要素 ${mesh.elementCell.length}（DC3D8）、節点 ${mesh.nodeCount}、格子 ${mesh.nx}×${mesh.ny}`);

  const job = 'job';
  await fs.writeFile(path.join(ctx.workDir, `${job}.inp`), writeHeatInp(mesh, { title: `${req.project.name} / 定常熱伝導` }));
  const run = await runCcx(ctx, job, { progressFrom: 0.1, progressTo: 0.9, message: 'CalculiX で熱伝導を解いています' });
  throwIfAborted(ctx);
  const datText = await readDatIfAny(path.join(ctx.workDir, `${job}.dat`));
  if (run.code !== 0 || !datText) {
    throw new Error(explainFailure(run.output, { plasticity: false, largeDeformation: false, analysis: 'heat' }));
  }

  ctx.progress(0.92, '結果を読み取っています', 'reading');
  const mapped = mapHeatResults({ project: grid.project, raster, mesh, blocks: parseDat(datText) });

  const warnings: string[] = ['CalculiX（熱伝導・厚さ 1 要素の 3D の板 DC3D8）で解きました', grid.note, ...mesh.warnings, ...mapped.notes];
  if (mapped.totalHeat > 0 && Math.abs(mapped.heatOut - mapped.totalHeat) / mapped.totalHeat > BALANCE_WARN) {
    warnings.push(
      `放熱量（${mapped.heatOut.toFixed(3)} W）が発熱量（${mapped.totalHeat.toFixed(3)} W）と ${(BALANCE_WARN * 100).toFixed(0)}% 以上ずれています。計算が収束していない可能性があります。`,
    );
  }
  warnings.push('板の表裏の放熱は、厚さ方向に 1 要素で表しています（薄い板では温度は厚さ方向にほぼ一様です）。');

  const result = toHeatResultSet(mesh, mapped, warnings);
  await fs.writeFile(
    path.join(ctx.workDir, `${job}.vtk`),
    writeVtk({ nx: mesh.nx, ny: mesh.ny, h: mesh.h, thickness: mesh.thickness, title: `Studio M ${req.project.name} (CalculiX heat)`, fields: result.fields, mask: mesh.included }),
  );
  const files = await listJobFiles(ctx.workDir, job);
  ctx.progress(1, '完了', 'reading');
  return { result, files };
}
