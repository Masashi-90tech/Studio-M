// ジョブの管理: 待ち行列、実行、進み具合、中止、結果とファイル、後片づけ。
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import type { EngineId, EngineInfo, JobFile, JobRequest, JobState } from '../../src/core/engine-protocol';
import { encodeJobState } from '../../src/core/engine-wire';
import type { ResultSet } from '../../src/core/types';
import type { EngineAdapter } from '../types';
import { createAdapterContext } from './context';
import { ExecError } from './exec';

const LOG_LIMIT = 200;
/** 中止の指示から、アダプターが返ってこなくても「中止済み」にするまでの時間 [ms] */
const CANCEL_GRACE_MS = 10_000;
const ID_RE = /^[0-9a-f]{16}$/;

export const WORK_ROOT = join(tmpdir(), 'studio-m-engine');

export interface JobManagerOptions {
  adapters: EngineAdapter[];
  /** 検出済みのエンジンの情報 */
  getInfo(id: EngineId): EngineInfo | undefined;
  dockerAvailable(): boolean;
  maxConcurrentJobs?: number;
  /** 待ち行列の上限 */
  maxQueued?: number;
  /** 作業フォルダを置く場所 */
  workRoot?: string;
  /** true なら、終わった作業フォルダを消さない */
  keep?: boolean;
  /** 終わったジョブを覚えておく時間 [ms] */
  ttlMs?: number;
  commandTimeoutMs?: number;
}

interface Job {
  state: JobState;
  req: JobRequest;
  adapter: EngineAdapter;
  workDir: string;
  abort: AbortController;
  cancelRequested: boolean;
  /** アダプターが返したファイル名（これ以外は配らない） */
  fileNames: Set<string>;
  /** 終わったときに作る、JSON 文字列（結果が大きいので 1 回だけ作る） */
  wire?: string;
  done: Promise<void>;
  finish: () => void;
}

export class QueueFullError extends Error {}

export function isJobId(id: string): boolean {
  return ID_RE.test(id);
}

const isFinal = (s: JobState['status']): boolean => s === 'done' || s === 'failed' || s === 'cancelled';

export class JobManager {
  readonly maxConcurrentJobs: number;
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private running = 0;
  private readonly workRoot: string;
  private readonly opts: JobManagerOptions;

  constructor(opts: JobManagerOptions) {
    this.opts = opts;
    this.maxConcurrentJobs = Math.max(1, Math.floor(opts.maxConcurrentJobs ?? 1));
    this.workRoot = opts.workRoot ?? WORK_ROOT;
  }

  /** ジョブを待ち行列に入れて id を返す */
  submit(req: JobRequest): string {
    const adapter = this.opts.adapters.find((a) => a.id === req.engine);
    if (!adapter) throw new Error(`エンジン「${req.engine}」は組み込まれていません`);
    if (this.queue.length >= (this.opts.maxQueued ?? 20)) throw new QueueFullError('待っている計算が多すぎます。いまの計算が終わってからもう一度試してください');
    const id = randomBytes(8).toString('hex');
    let finish = (): void => undefined;
    const done = new Promise<void>((r) => (finish = r));
    const job: Job = {
      state: { id, analysis: req.analysis, engine: req.engine, status: 'queued', progress: 0, message: '順番を待っています…', log: [], startedAt: Date.now() },
      req,
      adapter,
      workDir: join(this.workRoot, id),
      abort: new AbortController(),
      cancelRequested: false,
      fileNames: new Set(),
      done,
      finish,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    queueMicrotask(() => this.pump());
    return id;
  }

  /** 画面に返す状態（ログは末尾だけ） */
  get(id: string): JobState | undefined {
    return this.jobs.get(id)?.state;
  }

  /** 通信用の JSON 文字列。終わったジョブは作ったものを使い回す */
  wire(id: string): string | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.state.status === 'done') return (job.wire ??= JSON.stringify(encodeJobState(job.state)));
    return JSON.stringify(job.state);
  }

  /** 終わるまで待つ（テスト・終了処理用） */
  async waitFor(id: string): Promise<void> {
    await this.jobs.get(id)?.done;
  }

  cancel(id: string): JobState | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const s = job.state;
    if (isFinal(s.status) || job.cancelRequested) return s;
    job.cancelRequested = true;
    if (s.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
      this.settle(job, { status: 'cancelled', message: '中止しました' });
      return job.state;
    }
    s.message = '中止しています…';
    job.abort.abort();
    // アダプターが止まらなくても、一定時間で「中止済み」にする
    setTimeout(() => {
      if (!isFinal(job.state.status)) this.settle(job, { status: 'cancelled', message: '中止しました' });
    }, CANCEL_GRACE_MS).unref();
    return s;
  }

  /** 配ってよいファイルの実体。アダプターが挙げた名前で、作業フォルダの中にあるものだけ */
  async resolveFile(id: string, name: string): Promise<{ path: string; size: number; name: string } | null> {
    const job = this.jobs.get(id);
    if (!job || !job.fileNames.has(name)) return null;
    try {
      const path = await insideRealpath(job.workDir, name);
      if (!path) return null;
      const st = await stat(path);
      return st.isFile() ? { path, size: st.size, name } : null;
    } catch {
      return null;
    }
  }

  /** 古いジョブと作業フォルダを片づける */
  async sweep(now = Date.now()): Promise<void> {
    const ttl = this.opts.ttlMs ?? 24 * 3600_000;
    for (const [id, job] of this.jobs) {
      const f = job.state.finishedAt;
      if (f !== undefined && now - f > ttl) {
        this.jobs.delete(id);
        if (!this.opts.keep) await rm(job.workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /** 終了処理: 走っている計算を止め、作業フォルダを消す（keep なら残す） */
  async shutdown(): Promise<void> {
    this.queue = [];
    for (const job of this.jobs.values()) {
      if (!isFinal(job.state.status)) {
        job.cancelRequested = true;
        job.abort.abort();
      }
    }
    await Promise.race([Promise.all([...this.jobs.values()].map((j) => j.done)), new Promise((r) => setTimeout(r, 5000).unref())]);
    if (!this.opts.keep) for (const job of this.jobs.values()) await rm(job.workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  // ---------- 内部 ----------

  private pump(): void {
    while (this.running < this.maxConcurrentJobs && this.queue.length > 0) {
      const id = this.queue.shift();
      const job = id ? this.jobs.get(id) : undefined;
      if (!job || isFinal(job.state.status)) continue;
      this.running++;
      void this.execute(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private settle(job: Job, patch: Partial<JobState> & { status: JobState['status'] }): void {
    if (isFinal(job.state.status)) return;
    Object.assign(job.state, patch);
    job.state.finishedAt = Date.now();
    if (patch.status === 'done') job.state.progress = 1;
    job.finish();
  }

  private pushLog(job: Job, line: string): void {
    const log = job.state.log;
    log.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  }

  private async execute(job: Job): Promise<void> {
    const s = job.state;
    try {
      await mkdir(job.workDir, { recursive: true });
      s.status = 'running';
      s.message = '準備しています…';
      const ctx = createAdapterContext({
        jobId: s.id,
        workDir: job.workDir,
        signal: job.abort.signal,
        adapter: job.adapter,
        info: this.opts.getInfo(job.req.engine),
        dockerAvailable: this.opts.dockerAvailable(),
        commandTimeoutMs: this.opts.commandTimeoutMs ?? 3600_000,
        log: (line) => this.pushLog(job, line),
        progress: (fraction, message, status) => {
          if (job.cancelRequested || isFinal(s.status)) return;
          s.progress = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
          s.message = message;
          s.status = status ?? 'running';
        },
      });
      const out = await job.adapter.solve(job.req, ctx);
      if (job.cancelRequested) {
        this.settle(job, { status: 'cancelled', message: '中止しました' });
        return;
      }
      const problem = checkResult(out.result);
      if (problem) throw new Error(`${problem}。エンジンの版が Studio M と合っていない可能性があります`);
      const result: ResultSet = { ...out.result, analysis: job.req.analysis };
      const files = await this.collectFiles(job, out.files);
      this.settle(job, { status: 'done', message: '計算が終わりました', result, files });
    } catch (e) {
      if (job.cancelRequested || (e instanceof ExecError && e.reason === 'aborted')) {
        this.settle(job, { status: 'cancelled', message: '中止しました' });
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        this.pushLog(job, `エラー: ${msg}`);
        this.settle(job, { status: 'failed', message: '計算に失敗しました', error: userMessage(msg) });
      }
    }
  }

  private async collectFiles(job: Job, listed: { name: string; description: string }[]): Promise<JobFile[]> {
    const files: JobFile[] = [];
    for (const f of listed) {
      try {
        const p = await insideRealpath(job.workDir, f.name);
        const st = p ? await stat(p) : null;
        if (!st?.isFile()) throw new Error('not a file');
        job.fileNames.add(f.name);
        files.push({ name: f.name, size: st.size, description: f.description });
      } catch {
        this.pushLog(job, `ファイル「${f.name}」が見つからないので、一覧から外しました`);
      }
    }
    return files;
  }
}

/** 日本語のメッセージはそのまま、そうでない内部エラーは説明を添えて利用者に見せる */
export function userMessage(msg: string): string {
  return /[\u3040-\u30ff\u4e00-\u9fff]/.test(msg) ? msg : `計算中にエラーが起きました（${msg}）。ログを確認して、解決しなければ報告してください`;
}

/** 結果の形の最低限の検査。問題があれば説明、なければ null */
export function checkResult(r: ResultSet | undefined): string | null {
  if (!r || typeof r !== 'object') return 'エンジンが結果を返しませんでした';
  if (!Number.isInteger(r.nx) || !Number.isInteger(r.ny) || r.nx < 1 || r.ny < 1) return '結果の格子の大きさが正しくありません';
  if (!Array.isArray(r.fields) || !Array.isArray(r.scalars)) return '結果に場や代表値がありません';
  for (const f of r.fields) {
    if (!(f.data instanceof Float32Array) || f.data.length !== r.nx * r.ny) return `結果「${f.key}」のセル数が格子と合いません`;
    if (f.mask && f.mask.length !== r.nx * r.ny) return `結果「${f.key}」の mask の長さが格子と合いません`;
  }
  return null;
}

/** 作業フォルダの中のファイルの実パス（シンボリックリンクで外へ出るものは null） */
async function insideRealpath(workDir: string, name: string): Promise<string | null> {
  if (!name || name.includes('\0') || isAbsolute(name)) return null;
  const base = await realpath(workDir);
  const target = await realpath(resolve(base, name));
  const rel = relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return target;
}

/** 起動時に、前回の作業フォルダのうち古いものを片づける */
export async function cleanStaleWorkDirs(opts: { root?: string; olderThanMs: number; now?: number }): Promise<number> {
  const root = opts.root ?? WORK_ROOT;
  const now = opts.now ?? Date.now();
  let removed = 0;
  try {
    for (const name of await readdir(root)) {
      if (!ID_RE.test(name)) continue;
      const dir = join(root, name);
      const st = await stat(dir).catch(() => null);
      if (st && now - st.mtimeMs > opts.olderThanMs) {
        await rm(dir, { recursive: true, force: true });
        removed++;
      }
    }
  } catch {
    // フォルダがなければ何もしない
  }
  return removed;
}
