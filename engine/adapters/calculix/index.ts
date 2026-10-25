// CalculiX アダプター: Project（2D の板）を CalculiX の平面応力モデルにして解き、Lite と同じ ResultSet に戻す。
//
// 流れ: 格子化（Lite と同じ規則 + quality）→ 要素分割（mesh.ts）→ .inp（inp.ts）→ ccx → .dat を読む（dat.ts）
//       → セルの値に戻す（results.ts）→ ParaView 用の VTK（vtk.ts）。
// 塑性ありのときは、先に弾性だけの計算（降伏荷重の見積もり）をしてから、荷重を増やしながら弾塑性で解く。
// 実行は必ず ctx.run を通す。ライセンス: CalculiX は GPL-2.0 なので、別プロセスとして呼ぶだけで組み込まない。

import { promises as fs } from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import type { EngineCapability, EngineInfo, JobRequest } from '../../../src/core/engine-protocol';
import { rasterize } from '../../../src/core/raster';
import type { ResultSet } from '../../../src/core/types';
import type { AdapterContext, DetectContext, EngineAdapter, SolveOutput } from '../../types';
import { parseDat } from './dat';
import { writeInp } from './inp';
import { buildMesh, MeshError, type Mesh } from './mesh';
import { chooseGrid, parseStressOptions, STRESS_OPTION_SPECS, type StressOptions } from './options';
import { mapResults, toResultSet } from './results';
import { writeVtk } from './vtk';

const CCX_TIMEOUT_MS = 15 * 60 * 1000;
const SAFETY_CAP = 100;

const capabilities: EngineCapability[] = [
  { analysis: 'stress', engine: 'calculix', label: 'CalculiX で本計算', options: STRESS_OPTION_SPECS },
];

const INSTALL_NOTE =
  'CalculiX（ccx）が見つかりません。Ubuntu / Debian では `sudo apt install calculix-ccx` で入ります。' +
  'Windows では bConverged や CalculiX Launcher などの配布版を入れるか Docker で動かし、macOS では公式サイト（calculix.de）の案内に従って入れてください。' +
  'どの場合も `ccx` というコマンド名で呼べるようにしてください（ccx_2.21 などの名前なら、ccx という名前でも呼べるようにします）。';

/** ccx の出力から、利用者に見せる失敗の理由を作る */
export function explainFailure(output: string, ctx: { plasticity: boolean; largeDeformation: boolean; yieldLoadFactor?: number }): string {
  const errorLine = output.split(/\r?\n/).find((l) => /\*ERROR/i.test(l));
  if (/too many cutbacks|cutback|increment size smaller than|no convergence|did not converge|not converge/i.test(output)) {
    const yieldNote =
      ctx.yieldLoadFactor !== undefined && ctx.yieldLoadFactor < SAFETY_CAP
        ? `（降伏し始める荷重は、今の荷重のおよそ ${ctx.yieldLoadFactor.toFixed(2)} 倍です）`
        : '';
    if (ctx.plasticity) {
      return (
        '荷重が大きすぎて、材料が支えきれずに崩れています（降伏荷重を超えています）' +
        yieldNote +
        '。荷重を減らす（または「荷重の倍率」を下げる）、断面を大きくする、強い材料に変えるなどして、もう一度計算してください。'
      );
    }
    return (
      'CalculiX の計算が収束しませんでした。' +
      (ctx.largeDeformation ? '変形が大きすぎる可能性があります。荷重を減らすか、「大きな変形を考慮する」を切ってみてください。' : '形状や荷重を見直してください。')
    );
  }
  if (/singular|zero pivot|pivot|rigid body/i.test(output)) {
    return '剛体として動いてしまう部分があり、解けませんでした。すべての部品が「支持」で固定されているか確認してください。';
  }
  return `CalculiX が計算に失敗しました${errorLine ? `（${errorLine.replace(/\*ERROR[^:]*:?\s*/i, '').trim()}）` : ''}。ログを確認してください。`;
}

/** ccx を 1 回走らせ、.dat を読んで結果にする */
async function runCcx(
  ctx: AdapterContext,
  job: string,
  opts: { progressFrom: number; progressTo: number; message: string },
): Promise<{ output: string; code: number }> {
  const threads = String(Math.max(1, Math.min(8, cpus().length)));
  const lines: string[] = [];
  ctx.progress(opts.progressFrom, opts.message, 'running');
  const res = await ctx.run('ccx', ['-i', job], {
    timeoutMs: CCX_TIMEOUT_MS,
    env: { OMP_NUM_THREADS: threads, CCX_NPROC_EQUATION_SOLVER: threads, CCX_NPROC_STIFFNESS: threads },
    onLine: (line) => {
      lines.push(line);
      const m = /actual total time=\s*(\S+)/i.exec(line);
      if (m) {
        const t = Math.min(1, Math.max(0, Number(m[1]) || 0));
        ctx.progress(opts.progressFrom + (opts.progressTo - opts.progressFrom) * t, `${opts.message}（荷重 ${(t * 100).toFixed(0)}%）`, 'running');
      }
    },
  });
  const output = `${res.stdout}\n${res.stderr}\n${lines.join('\n')}`;
  return { output, code: res.code };
}

async function readDatIfAny(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function solveStress(req: JobRequest, ctx: AdapterContext): Promise<SolveOutput> {
  const opts: StressOptions = parseStressOptions(req.options);

  ctx.progress(0.02, '格子を作っています', 'meshing');
  const grid = chooseGrid(req.project, req.quality);
  const raster = rasterize(grid.project);
  let mesh: Mesh;
  try {
    mesh = buildMesh(grid.project, raster, opts.elementType);
  } catch (e) {
    if (e instanceof MeshError) throw new Error(e.message);
    throw e;
  }
  const selfWeight = grid.project.stress.selfWeight;
  if (mesh.appliedLoad === 0 && !selfWeight) {
    throw new Error('荷重も自重もないため、応力と変位はゼロです。荷重を置くか、自重を有効にしてください。');
  }
  if (ctx.signal.aborted) throw new Error('中止しました');
  ctx.log(`要素 ${mesh.elementCell.length}（${opts.elementType}）、節点 ${mesh.nodeCount}、格子 ${mesh.nx}×${mesh.ny}`);

  const baseInp = { largeDeformation: opts.largeDeformation, selfWeight, hardeningPercent: opts.hardeningPercent };
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
    if (ctx.signal.aborted) throw new Error('中止しました');
  }

  // ----- 本計算 -----
  const job = 'job';
  const loadScale = opts.plasticity ? opts.loadFactor : 1;
  const title = `${req.project.name} / ${opts.plasticity ? '弾塑性' : '線形弾性'} / ${opts.elementType}`;
  await fs.writeFile(path.join(ctx.workDir, `${job}.inp`), writeInp(mesh, { ...baseInp, plasticity: opts.plasticity, loadScale, title }));
  const from = opts.plasticity ? 0.35 : 0.1;
  const run = await runCcx(ctx, job, {
    progressFrom: from,
    progressTo: 0.9,
    message: opts.plasticity ? 'CalculiX で荷重を増やしながら解いています' : 'CalculiX で解いています',
  });
  if (ctx.signal.aborted) throw new Error('中止しました');
  const datText = await readDatIfAny(path.join(ctx.workDir, `${job}.dat`));
  if (run.code !== 0 || !datText) {
    throw new Error(explainFailure(run.output, { plasticity: opts.plasticity, largeDeformation: opts.largeDeformation, yieldLoadFactor }));
  }

  ctx.progress(0.92, '結果を読み取っています', 'reading');
  const blocks = parseDat(datText);
  const mapped = mapResults(mesh, blocks, { plasticity: opts.plasticity });
  if (opts.plasticity && yieldLoadFactor !== undefined) {
    mapped.scalars.push({ key: 'yieldLoadFactor', label: '降伏し始める荷重（今の荷重の倍率）', unit: '倍', value: yieldLoadFactor });
  }

  // ----- 利用者への注意 -----
  const warnings: string[] = [`CalculiX（2D 平面応力・${opts.elementType}）で解きました`, grid.note, ...mesh.warnings, ...mapped.notes];
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

  const files: SolveOutput['files'] = [{ name: `${job}.inp`, description: 'CalculiX の入力' }];
  try {
    await fs.access(path.join(ctx.workDir, `${job}.frd`));
    files.push({ name: `${job}.frd`, description: 'CalculiX の結果（ParaView では ccx2paraview などで変換、CGX で直接開けます）' });
  } catch {
    /* .frd がなければ載せない */
  }
  files.push({ name: `${job}.vtk`, description: 'ParaView 用の結果' });
  ctx.progress(1, '完了', 'reading');
  return { result, files };
}

export const calculixAdapter: EngineAdapter = {
  id: 'calculix',
  // 信頼できる公開イメージを確信できないため、Docker 実行は未対応（native のみ）
  dockerImage: undefined,
  capabilities,

  async detect(ctx: DetectContext): Promise<EngineInfo> {
    const base = { id: 'calculix' as const, name: 'CalculiX', license: 'GPL-2.0' };
    let probe: { ok: boolean; output: string };
    try {
      probe = await ctx.probe('ccx', ['-v']);
    } catch {
      probe = { ok: false, output: '' };
    }
    // ccx -v は版を表示して 0 以外で終わることがあるので、出力の中身で判断する
    const m = /Version\s+([0-9][0-9.]*)/i.exec(probe.output);
    const available = m !== null || (probe.ok && /calculix/i.test(probe.output));
    if (available) return { ...base, available: true, version: m?.[1], via: 'native' };
    return { ...base, available: false, via: 'none', note: INSTALL_NOTE };
  },

  async solve(req: JobRequest, ctx: AdapterContext): Promise<SolveOutput> {
    if (req.analysis === 'stress') return solveStress(req, ctx);
    throw new Error(`CalculiX アダプターは ${req.analysis} の解析にはまだ対応していません。`);
  },
};

export default calculixAdapter;
