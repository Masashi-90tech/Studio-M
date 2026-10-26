// テスト用の AdapterContext / DetectContext（node:child_process の spawn で直接実行する）。
// 本物はエンジンのサーバー側が用意する。ここは OpenFOAM アダプターのテストだけで使う。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterContext, DetectContext, RunOptions, RunResult } from '../../types';

/** Debian/Ubuntu のパッケージで OpenFOAM を直接使うための環境変数（なければ何も足さない） */
export function foamEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!process.env.WM_PROJECT_DIR && existsSync('/usr/share/openfoam/etc')) env.WM_PROJECT_DIR = '/usr/share/openfoam';
  return env;
}

/** OpenFOAM が使えるか（blockMesh -help が成功するか） */
/** 実際に OpenFOAM を動かす結合テストは STUDIO_M_ENGINE_TESTS=1 のときだけ（npm run test:engines）。普段の npm run check を軽く保つため */
export function hasOpenFoam(): boolean {
  if (process.env.STUDIO_M_ENGINE_TESTS !== '1') return false;
  try {
    const r = spawnSync('blockMesh', ['-help'], { env: { ...process.env, ...foamEnv() }, timeout: 20_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function runCommand(workDir: string, command: string, args: string[], opts: RunOptions = {}, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd ? join(workDir, opts.cwd) : workDir,
      env: { ...process.env, ...foamEnv(), ...(opts.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    const pending = { stdout: '', stderr: '' };
    const feed = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (!opts.onLine) return;
      const parts = (pending[stream] + chunk).split('\n');
      pending[stream] = parts.pop() ?? '';
      for (const line of parts) opts.onLine(line, stream);
    };
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      feed('stdout', d);
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      feed('stderr', d);
    });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export interface TestContext {
  ctx: AdapterContext;
  logs: string[];
  progress: { fraction: number; message: string; status?: string }[];
  controller: AbortController;
}

export async function createTestContext(opts: { workDir?: string; controller?: AbortController } = {}): Promise<TestContext> {
  const workDir = opts.workDir ?? (await mkdtemp(join(tmpdir(), 'studio-m-foam-')));
  const controller = opts.controller ?? new AbortController();
  const logs: string[] = [];
  const progress: TestContext['progress'] = [];
  const ctx: AdapterContext = {
    workDir,
    signal: controller.signal,
    log: (line) => logs.push(line),
    progress: (fraction, message, status) => progress.push({ fraction, message, status }),
    run: (command, args, o) => runCommand(workDir, command, args, o, controller.signal),
  };
  return { ctx, logs, progress, controller };
}

export function createDetectContext(dockerAvailable = false): DetectContext {
  return {
    dockerAvailable,
    probe: async (command, args) => {
      try {
        const r = await runCommand(process.cwd(), command, args, { timeoutMs: 20_000 });
        return { ok: r.code === 0, output: `${r.stdout}\n${r.stderr}` };
      } catch (e) {
        return { ok: false, output: (e as Error).message };
      }
    },
  };
}
