// ccx の実行まわりの共通部品（強度・熱で共有）: 走らせる、出力から失敗の理由を作る、書き出したファイルの一覧。

import { promises as fs } from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import type { AdapterContext, SolveOutput } from '../../types';

const CCX_TIMEOUT_MS = 15 * 60 * 1000;
export const SAFETY_CAP = 100;

/** ccx の出力から、利用者に見せる失敗の理由を作る */
export function explainFailure(output: string, ctx: { plasticity: boolean; largeDeformation: boolean; yieldLoadFactor?: number; analysis?: 'stress' | 'heat' }): string {
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
    if (ctx.analysis === 'heat') return 'CalculiX の熱計算が収束しませんでした。熱伝達率や固定温度の条件を見直してください。';
    return (
      'CalculiX の計算が収束しませんでした。' +
      (ctx.largeDeformation ? '変形が大きすぎる可能性があります。荷重を減らすか、「大きな変形を考慮する」を切ってみてください。' : '形状や荷重を見直してください。')
    );
  }
  if (ctx.analysis === 'heat' && /singular|zero pivot|pivot/i.test(output)) {
    return '温度が定まらない部分があり、解けませんでした。物体に、周囲への熱伝達（表面熱伝達率）や固定温度など、熱の逃げ道があるか確認してください。';
  }
  if (/singular|zero pivot|pivot|rigid body/i.test(output)) {
    return '剛体として動いてしまう部分があり、解けませんでした。すべての部品が「支持」で固定されているか確認してください。';
  }
  return `CalculiX が計算に失敗しました${errorLine ? `（${errorLine.replace(/\*ERROR[^:]*:?\s*/i, '').trim()}）` : ''}。ログを確認してください。`;
}

/** ccx を 1 回走らせる（実行は ctx.run。終了コードと出力を返す） */
export async function runCcx(
  ctx: AdapterContext,
  job: string,
  opts: { progressFrom: number; progressTo: number; message: string },
): Promise<{ output: string; code: number }> {
  const threads = String(Math.max(1, Math.min(8, cpus().length)));
  const lines: string[] = [];
  ctx.progress(opts.progressFrom, opts.message, 'running');
  const res = await ctx.run('ccx', ['-i', job], {
    timeoutMs: CCX_TIMEOUT_MS,
    // 応力の計算（RESULTS）だけは 1 スレッドにする: CalculiX 2.21 は応力の計算を複数スレッドで走らせると、
    // CPU が混み合ったときに、まれに応力が壊れた値になる（変位は正しい）ことを確認したため
    env: { OMP_NUM_THREADS: threads, CCX_NPROC_EQUATION_SOLVER: threads, CCX_NPROC_STIFFNESS: threads, CCX_NPROC_RESULTS: '1' },
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

export async function readDatIfAny(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}


export function throwIfAborted(ctx: AdapterContext): void {
  if (ctx.signal.aborted) throw new Error('中止しました');
}

/** 利用者に渡すファイルの一覧（.inp は必ず、.frd と .vtk はあれば） */
export async function listJobFiles(workDir: string, job: string): Promise<SolveOutput['files']> {
  const files: SolveOutput['files'] = [{ name: `${job}.inp`, description: 'CalculiX の入力' }];
  try {
    await fs.access(path.join(workDir, `${job}.frd`));
    files.push({ name: `${job}.frd`, description: 'CalculiX の結果（ParaView では ccx2paraview などで変換、CGX で直接開けます）' });
  } catch {
    /* .frd がなければ載せない */
  }
  files.push({ name: `${job}.vtk`, description: 'ParaView 用の結果' });
  return files;
}
