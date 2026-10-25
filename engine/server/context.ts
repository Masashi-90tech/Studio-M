// アダプターに渡す AdapterContext を作る。ctx.run はここで native / docker を選ぶ。
import type { EngineAdapter, AdapterContext, RunOptions, RunResult } from '../types';
import type { EngineInfo } from '../../src/core/engine-protocol';
import { ExecError, runCommand, type Backend } from './exec';

/** 検出の結果と Docker の有無から、実行の仕方を選ぶ */
export function decideBackend(opts: { via: EngineInfo['via'] | undefined; dockerImage?: string; dockerAvailable: boolean }): Backend {
  if (opts.via === 'docker' && opts.dockerImage && opts.dockerAvailable) return { kind: 'docker', image: opts.dockerImage };
  return { kind: 'native' };
}

export interface ContextOptions {
  jobId: string;
  workDir: string;
  signal: AbortSignal;
  adapter: EngineAdapter;
  /** 検出済みのエンジンの情報 */
  info: EngineInfo | undefined;
  dockerAvailable: boolean;
  /** 1 回のコマンドの時間切れ [ms]（アダプターが timeoutMs を指定すればそちらが優先） */
  commandTimeoutMs: number;
  log(line: string): void;
  progress: AdapterContext['progress'];
}

export function createAdapterContext(o: ContextOptions): AdapterContext {
  let seq = 0;
  const primary = decideBackend({ via: o.info?.via, dockerImage: o.adapter.dockerImage, dockerAvailable: o.dockerAvailable });
  const dockerFallback: Backend | null = o.adapter.dockerImage && o.dockerAvailable ? { kind: 'docker', image: o.adapter.dockerImage } : null;

  const run = async (command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    const exec = (backend: Backend): Promise<RunResult> =>
      runCommand({
        command,
        args,
        workDir: o.workDir,
        cwd: opts.cwd,
        env: opts.env,
        timeoutMs: opts.timeoutMs ?? o.commandTimeoutMs,
        signal: o.signal,
        onLine: (line, stream) => {
          o.log(line);
          opts.onLine?.(line, stream);
        },
        backend,
        containerName: backend.kind === 'docker' ? `studio-m-${o.jobId}-${++seq}` : undefined,
      });
    try {
      return await exec(primary);
    } catch (e) {
      // 直接入れたはずのコマンドが見つからないときは、Docker が使えるなら Docker で 1 回だけやり直す
      if (e instanceof ExecError && e.reason === 'not-found' && primary.kind === 'native' && dockerFallback) {
        o.log(`「${command}」が見つからないので、Docker（${dockerFallback.kind === 'docker' ? dockerFallback.image : ''}）で実行します`);
        return exec(dockerFallback);
      }
      throw e;
    }
  };

  return { workDir: o.workDir, signal: o.signal, log: o.log, progress: o.progress, run };
}
