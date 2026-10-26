// テスト用の AdapterContext / DetectContext。node:child_process の spawn で実行する。
// エンジンのサーバーも、同じ形（シェルを通さず、引数は配列、作業フォルダの中で実行）で ctx.run を作る。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdapterContext, DetectContext, RunOptions, RunResult } from '../../types';

/** ccx が使えるか（同期で調べる。describe.skipIf に渡す用） */
export function hasCommand(command: string, args: string[] = ['-v']): boolean {
  try {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
    if (r.error) return false;
    return /Version\s+\d/i.test(`${r.stdout}${r.stderr}`) || r.status === 0;
  } catch {
    return false;
  }
}

/** 実際に ccx を動かす結合テストは STUDIO_M_ENGINE_TESTS=1 のときだけ（npm run test:engines）。普段の npm run check を軽く保つため */
export const hasCcx = process.env.STUDIO_M_ENGINE_TESTS === '1' && hasCommand('ccx', ['-v']);

/** gmsh が使えるか（同じく STUDIO_M_ENGINE_TESTS=1 のときだけ）。形に沿ったメッシュの結合テスト用 */
export const hasGmsh = process.env.STUDIO_M_ENGINE_TESTS === '1' && hasCommand('gmsh', ['--version']);

export interface TestContext extends AdapterContext {
  /** 記録したログ・進み具合 */
  logs: string[];
  progresses: { fraction: number; message: string; status?: string }[];
  abort(): void;
  cleanup(): Promise<void>;
}

/** 一時フォルダを作業フォルダにした AdapterContext。終わったら cleanup() で消す */
export async function createTestContext(opts: { keepDir?: boolean } = {}): Promise<TestContext> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'studio-m-engine-'));
  const controller = new AbortController();
  const logs: string[] = [];
  const progresses: TestContext['progresses'] = [];

  const run = (command: string, args: string[], runOpts: RunOptions = {}): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: runOpts.cwd ? path.resolve(workDir, runOpts.cwd) : workDir,
        env: { ...process.env, ...runOpts.env },
        shell: false,
        signal: controller.signal,
      });
      let stdout = '';
      let stderr = '';
      const feed = (stream: 'stdout' | 'stderr') => {
        let rest = '';
        return (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (stream === 'stdout') stdout += text;
          else stderr += text;
          if (!runOpts.onLine) return;
          const parts = (rest + text).split(/\r?\n/);
          rest = parts.pop() ?? '';
          for (const l of parts) runOpts.onLine(l, stream);
        };
      };
      child.stdout.on('data', feed('stdout'));
      child.stderr.on('data', feed('stderr'));
      const timer = runOpts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), runOpts.timeoutMs) : undefined;
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });

  return {
    workDir,
    signal: controller.signal,
    logs,
    progresses,
    log: (line) => logs.push(line),
    progress: (fraction, message, status) => progresses.push({ fraction, message, status }),
    run,
    abort: () => controller.abort(),
    cleanup: async () => {
      if (!opts.keepDir) await rm(workDir, { recursive: true, force: true });
    },
  };
}

/** 'command -args' を実行して版の文字列を調べる DetectContext */
export function createDetectContext(opts: { dockerAvailable?: boolean } = {}): DetectContext {
  return {
    dockerAvailable: opts.dockerAvailable ?? false,
    probe: (command, args) =>
      new Promise((resolve) => {
        const child = spawn(command, args, { shell: false });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
        child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
        child.on('error', () => resolve({ ok: false, output: '' }));
        child.on('close', (code) => resolve({ ok: code === 0, output: out }));
      }),
  };
}
