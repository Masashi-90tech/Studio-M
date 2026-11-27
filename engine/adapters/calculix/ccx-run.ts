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

/**
 * ccx に渡すスレッド数。既定は CPU の数（最大 8）。環境変数 STUDIO_M_CCX_THREADS（1〜64 の整数）で指定できる。
 * Apple Silicon のように速いコアと省電力コアが混在する PC では、全コアを使うと OpenMP の待ち合わせで
 * かえって遅くなることがあるので、計算時間を測って決めるための口（docs/ENGINE.md）。
 */
export function ccxThreads(env: Record<string, string | undefined> = process.env, cpuCount: number = cpus().length): string {
  const n = Number(env.STUDIO_M_CCX_THREADS);
  if (Number.isInteger(n) && n >= 1 && n <= 64) return String(n);
  return String(Math.max(1, Math.min(8, cpuCount)));
}

/** ccx を 1 回走らせる（実行は ctx.run。終了コードと出力を返す） */
export async function runCcx(
  ctx: AdapterContext,
  job: string,
  opts: { progressFrom: number; progressTo: number; message: string; /** true なら、すべての並列実行を 1 スレッドにする（釣り合わないときのやり直し用） */ allSingleThread?: boolean },
): Promise<{ output: string; code: number }> {
  const threads = opts.allSingleThread ? '1' : ccxThreads();
  const lines: string[] = [];
  ctx.progress(opts.progressFrom, opts.message, 'running');
  const res = await ctx.run('ccx', ['-i', job], {
    timeoutMs: CCX_TIMEOUT_MS,
    // 連立方程式を解く部分（SPOOLES、CCX_NPROC_EQUATION_SOLVER）だけは必ず 1 スレッドにする:
    // 並列に走らせると、まれに間違った答え（反力が荷重と合わない）を出すことを実験 4 で確かめた
    // （docs/EXPERIMENT-4.md。全体 4 スレッド 30 回中 2 回が誤り、解く部分だけ 1 スレッドなら 60/60 で正しく、速さも落ちない）。
    // 剛性行列の組み立て（STIFFNESS）と他の部分は、並列のままにする。RESULTS は従来どおり 1
    env: { OMP_NUM_THREADS: threads, CCX_NPROC_EQUATION_SOLVER: '1', CCX_NPROC_STIFFNESS: threads, CCX_NPROC_RESULTS: '1' },
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
