// 解析ソフトの実行（ctx.run の実体）。シェルを通さず、引数は配列のまま渡す。
// PC に直接入っている（native）場合と、Docker のイメージで動かす場合の両方を、同じ呼び方で扱う。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import type { RunResult } from '../types';

/** コマンド名に使える文字（パスや引数を紛れ込ませない） */
const COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** 取っておく出力の最大バイト数（超えたら先頭を捨てる） */
const KEEP_BYTES = 2 * 1024 * 1024;
/**
 * 環境変数が足りないせいで動かない既知のソフトのための補い。「この変数が未設定で、このフォルダがあれば、この値にする」。
 * 解析ごとではなく、PC の入れ方（Debian/Ubuntu のパッケージなど）に対する補いなので、サーバーに置く。
 * 利用者が自分で設定していればそれを優先する。
 */
export const KNOWN_ENV_DEFAULTS: { name: string; value: string; whenExists: string }[] = [
  // Debian/Ubuntu の openfoam パッケージ（v1912）は、これがないとどのコマンドも動かない
  { name: 'WM_PROJECT_DIR', value: '/usr/share/openfoam', whenExists: '/usr/share/openfoam/etc' },
];

/** 子プロセスに渡す環境変数: 親の環境 + 既知の補い（未設定のものだけ）+ アダプターが指定したもの */
export function buildEnv(opts: { base?: NodeJS.ProcessEnv; extra?: Record<string, string>; exists?: (p: string) => boolean } = {}): NodeJS.ProcessEnv {
  const base = opts.base ?? process.env;
  const exists = opts.exists ?? existsSync;
  const env: NodeJS.ProcessEnv = { ...base };
  for (const d of KNOWN_ENV_DEFAULTS) {
    if (!env[d.name] && exists(d.whenExists)) env[d.name] = d.value;
  }
  return { ...env, ...opts.extra };
}

/** 止めるときに、穏やかな終了を待つ時間 [ms] */
const KILL_GRACE_MS = 2000;

export type Backend = { kind: 'native' } | { kind: 'docker'; image: string };

export interface ExecOptions {
  command: string;
  args: string[];
  /** 作業フォルダ（絶対パス） */
  workDir: string;
  /** 作業フォルダからの相対パス */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  backend: Backend;
  /** Docker のコンテナ名（中止のときに docker kill するため）。省略時は付けない */
  containerName?: string;
}

/** 実行に失敗したときの、利用者向けの説明つきエラー */
export class ExecError extends Error {
  constructor(
    message: string,
    readonly reason: 'not-found' | 'timeout' | 'aborted' | 'bad-request' | 'spawn',
  ) {
    super(message);
    this.name = reason === 'aborted' ? 'AbortError' : 'ExecError';
  }
}

export function isValidCommand(command: string): boolean {
  return COMMAND_RE.test(command);
}

/** 作業フォルダの中の相対パスだけを許す。外へ出る指定はエラー */
export function resolveInside(workDir: string, rel: string | undefined): string {
  const base = resolve(workDir);
  const target = resolve(base, rel ?? '.');
  const r = relative(base, target);
  if (r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) {
    throw new ExecError('作業フォルダの外は指定できません', 'bad-request');
  }
  return target;
}

/** docker run の引数を組み立てる（実行はしない。テストできるよう分けてある） */
export function buildDockerArgs(opts: {
  image: string;
  workDir: string;
  command: string;
  args: string[];
  /** 作業フォルダからの相対パス（/ 区切り） */
  cwd?: string;
  env?: Record<string, string>;
  containerName?: string;
  /** Linux / macOS で、作ったファイルが自分の持ち物になるように */
  user?: { uid: number; gid: number };
}): string[] {
  const rel = (opts.cwd ?? '').split(/[\\/]+/).filter((s) => s && s !== '.');
  if (rel.includes('..')) throw new ExecError('作業フォルダの外は指定できません', 'bad-request');
  const inner = rel.length > 0 ? posix.join('/work', ...rel) : '/work';
  const out = ['run', '--rm'];
  if (opts.containerName) out.push('--name', opts.containerName);
  // 計算ソフトに外へ出る通信は要らない
  out.push('--network', 'none');
  if (opts.user) out.push('--user', `${opts.user.uid}:${opts.user.gid}`);
  out.push('-v', `${opts.workDir}:/work`, '-w', inner);
  for (const [k, v] of Object.entries(opts.env ?? {})) out.push('-e', `${k}=${v}`);
  out.push(opts.image, opts.command, ...opts.args);
  return out;
}

/** 出力を行に分けて渡す（行の途中で切れた分は次に回す） */
export function createLineSplitter(emit: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let rest = '';
  return {
    push(chunk) {
      rest += chunk;
      const parts = rest.split(/\r\n|\n|\r/);
      rest = parts.pop() ?? '';
      for (const p of parts) emit(p);
    },
    flush() {
      if (rest) emit(rest);
      rest = '';
    },
  };
}

function tail(text: string): string {
  return text.length > KEEP_BYTES ? text.slice(text.length - KEEP_BYTES) : text;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
    } else {
      process.kill(-pid, signal); // detached で起動しているので、グループごと止まる
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // すでに終わっている
    }
  }
}

function dockerKill(name: string): void {
  spawn('docker', ['kill', name], { shell: false, windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
}

/** コマンドを 1 回実行する。終了コードが 0 でなくても例外にはしない（アダプターが判断する） */
export function runCommand(o: ExecOptions): Promise<RunResult> {
  return new Promise<RunResult>((resolvePromise, reject) => {
    if (!isValidCommand(o.command)) {
      reject(new ExecError(`コマンド名「${o.command}」は使えません（英数字と . _ + - だけ）`, 'bad-request'));
      return;
    }
    if (o.signal?.aborted) {
      reject(new ExecError('中止されました', 'aborted'));
      return;
    }
    let file = o.command;
    let args = o.args;
    let cwd: string;
    try {
      cwd = resolveInside(o.workDir, o.cwd);
      if (o.backend.kind === 'docker') {
        file = 'docker';
        args = buildDockerArgs({
          image: o.backend.image,
          workDir: o.workDir,
          command: o.command,
          args: o.args,
          cwd: o.cwd,
          env: o.env,
          containerName: o.containerName,
          user: typeof process.getuid === 'function' ? { uid: process.getuid(), gid: process.getgid?.() ?? 0 } : undefined,
        });
      }
    } catch (e) {
      reject(e);
      return;
    }
    const child = spawn(file, args, {
      cwd: o.backend.kind === 'docker' ? undefined : cwd,
      env: o.backend.kind === 'docker' ? process.env : buildEnv({ extra: o.env }),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const out = createLineSplitter((l) => o.onLine?.(l, 'stdout'));
    const err = createLineSplitter((l) => o.onLine?.(l, 'stderr'));

    const stop = (): void => {
      killTree(child, 'SIGTERM');
      if (o.backend.kind === 'docker' && o.containerName) dockerKill(o.containerName);
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer = o.timeoutMs && o.timeoutMs > 0 ? setTimeout(() => ((timedOut = true), stop()), o.timeoutMs) : undefined;
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      o.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      stdout = tail(stdout + c);
      out.push(c);
    });
    child.stderr?.on('data', (c: string) => {
      stderr = tail(stderr + c);
      err.push(c);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      finish(() => {
        if (e.code === 'ENOENT') {
          const what = o.backend.kind === 'docker' ? 'Docker（docker コマンド）' : `「${o.command}」`;
          reject(new ExecError(`${what}が見つかりません。インストールするか、docs/ENGINE.md の手順で Docker を使ってください`, 'not-found'));
        } else {
          reject(new ExecError(`「${o.command}」を起動できませんでした（${e.message}）`, 'spawn'));
        }
      });
    });
    child.on('close', (code) => {
      out.flush();
      err.flush();
      finish(() => {
        if (aborted) reject(new ExecError('中止されました', 'aborted'));
        else if (timedOut) reject(new ExecError(`「${o.command}」が時間内（${Math.round((o.timeoutMs ?? 0) / 1000)} 秒）に終わらなかったので止めました。計算の細かさを下げて、もう一度試してください`, 'timeout'));
        else resolvePromise({ code: code ?? -1, stdout, stderr });
      });
    });
  });
}
