// PC のエンジンとのやり取りの流れ（接続の確認・本計算の開始・進み具合の取得・中止・ファイル保存）。
// 画面の部品（engine-panel / engine-view）はこの Session を読み書きするだけで、通信の細部を知らない。
import type { EngineCapability, EngineId, JobFile, JobQuality, JobState } from '../core/engine-protocol';
import type { EngineStatusResponse } from '../core/engine-wire';
import type { AnalysisKind } from '../core/types';
import { downloadBlob, toast } from './dom';
import { createEngineClient, EngineClientError, type EngineClient } from './engine-client';
import { loadEngineConfig, saveEngineConfig, type EngineConfig } from './engine-config';
import { engineName } from './engine-logic';
import type { Runner } from './runner';

const POLL_MS = 600;
/** 続けてこの回数だけ通信に失敗したら、エンジンとの接続が切れたとみなす */
const LOST_AFTER = 6;

export type ConnState =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'ok'; status: EngineStatusResponse }
  | { kind: 'error'; reason: EngineClientError['kind'] | 'no-token'; message: string };

export type OptionValue = number | string | boolean;

/** 1 つの解析についての、本計算の実行 */
export interface RemoteRun {
  kind: AnalysisKind;
  engine: EngineId;
  /** 画面に出すエンジン名（例: CalculiX） */
  engineName: string;
  /** 計算を始めたときのプロジェクトの revision */
  rev: number;
  phase: 'submitting' | 'active' | 'done' | 'failed' | 'cancelled';
  jobId?: string;
  job?: JobState;
  files: JobFile[];
  error?: string;
  /** 中止を押してから止まるまで */
  cancelling: boolean;
}

export class EngineSession {
  config: EngineConfig;
  conn: ConnState = { kind: 'none' };
  quality: JobQuality = 'standard';
  /** key = `${analysis}:${engine}` → 選んだオプション */
  optionValues = new Map<string, Record<string, OptionValue>>();
  /** 画面が変化を見つけるための番号（変わるたびに増える） */
  version = 0;

  private client: EngineClient | null = null;
  private runs = new Map<AnalysisKind, RemoteRun>();
  private listeners = new Set<() => void>();
  private pollTimers = new Map<AnalysisKind, number>();

  constructor(
    private opts: {
      runner: Runner;
      /** テスト用に通信部品を差し替える */
      clientFactory?: (config: EngineConfig) => EngineClient;
    },
  ) {
    this.config = loadEngineConfig();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private makeClient(): EngineClient {
    this.client ??= (this.opts.clientFactory ?? ((c) => createEngineClient({ baseUrl: c.url, token: c.token })))(this.config);
    return this.client;
  }

  /** URL と合言葉を変える（保存もする）。接続の確認は connect で行う */
  setConfig(config: EngineConfig): void {
    this.config = { url: config.url, token: config.token.trim() };
    saveEngineConfig(this.config);
    this.client = null;
    this.conn = { kind: 'none' };
    this.changed();
  }

  /** エンジンに接続して、使えるエンジンの一覧を取る */
  async connect(o: { refresh?: boolean } = {}): Promise<boolean> {
    this.conn = { kind: 'checking' };
    this.changed();
    try {
      const status = await this.makeClient().status({ refresh: o.refresh });
      if (!status.authorized) {
        const noToken = this.config.token === '';
        this.conn = {
          kind: 'error',
          reason: noToken ? 'no-token' : 'unauthorized',
          message: noToken ? 'エンジンは見つかりましたが、合言葉が入力されていません。エンジンを起動したときに表示された合言葉を貼り付けてください。' : '合言葉が違います。エンジンを起動したときに表示された合言葉を、もう一度貼り付けてください。',
        };
        this.changed();
        return false;
      }
      this.conn = { kind: 'ok', status };
      this.changed();
      return true;
    } catch (e) {
      this.conn = e instanceof EngineClientError ? { kind: 'error', reason: e.kind, message: e.message } : { kind: 'error', reason: 'network', message: String(e) };
      this.changed();
      return false;
    }
  }

  get status(): EngineStatusResponse | null {
    return this.conn.kind === 'ok' ? this.conn.status : null;
  }

  runFor(kind: AnalysisKind): RemoteRun | undefined {
    return this.runs.get(kind);
  }

  options(cap: EngineCapability): Record<string, OptionValue> {
    const key = `${cap.analysis}:${cap.engine}`;
    let v = this.optionValues.get(key);
    if (!v) {
      v = Object.fromEntries((cap.options ?? []).map((o) => [o.key, o.default]));
      this.optionValues.set(key, v);
    }
    return v;
  }

  /** いま画面に出ている解析を、この能力（エンジン）で本計算する */
  async start(cap: EngineCapability): Promise<void> {
    const runner = this.opts.runner;
    const project = runner.resolved;
    if (!project || runner.analysis !== cap.analysis) {
      toast('形の準備ができていません。少し待ってからもう一度押してください', 'error');
      return;
    }
    const prev = this.runs.get(cap.analysis);
    if (prev && (prev.phase === 'submitting' || prev.phase === 'active')) return;
    const run: RemoteRun = { kind: cap.analysis, engine: cap.engine, engineName: engineName(this.status, cap.engine), rev: runner.revision, phase: 'submitting', files: [], cancelling: false };
    this.runs.set(cap.analysis, run);
    this.changed();
    try {
      const { id } = await this.makeClient().submit({ analysis: cap.analysis, engine: cap.engine, project, quality: this.quality, options: { ...this.options(cap) } });
      run.jobId = id;
      run.phase = 'active';
      this.changed();
      this.schedulePoll(run, 0);
    } catch (e) {
      this.fail(run, e);
    }
  }

  async cancel(kind: AnalysisKind): Promise<void> {
    const run = this.runs.get(kind);
    if (!run?.jobId || run.phase !== 'active' || run.cancelling) return;
    run.cancelling = true;
    this.changed();
    try {
      run.job = await this.makeClient().cancel(run.jobId);
      this.applyJob(run, run.job);
    } catch (e) {
      run.cancelling = false;
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
    this.changed();
  }

  /** 計算の記録を消す（結果の表示は Runner 側に残る） */
  dismiss(kind: AnalysisKind): void {
    const run = this.runs.get(kind);
    if (run && (run.phase === 'submitting' || run.phase === 'active')) return;
    this.runs.delete(kind);
    this.changed();
  }

  /** 計算に使った入力・出力ファイルを保存させる */
  async downloadFile(kind: AnalysisKind, name: string): Promise<void> {
    const run = this.runs.get(kind);
    if (!run?.jobId) return;
    try {
      const blob = await this.makeClient().file({ id: run.jobId, name });
      downloadBlob(blob, name.split('/').pop() ?? name);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  // ---------- 内部 ----------

  private schedulePoll(run: RemoteRun, failures: number): void {
    window.clearTimeout(this.pollTimers.get(run.kind));
    this.pollTimers.set(run.kind, window.setTimeout(() => void this.poll(run, failures), POLL_MS));
  }

  private async poll(run: RemoteRun, failures: number): Promise<void> {
    if (run.phase !== 'active' || !run.jobId || this.runs.get(run.kind) !== run) return;
    try {
      const job = await this.makeClient().job(run.jobId);
      run.job = job;
      this.applyJob(run, job);
      this.changed();
      if (run.phase === 'active') this.schedulePoll(run, 0);
    } catch (e) {
      const lost = e instanceof EngineClientError && (e.kind === 'network' || e.kind === 'timeout') && failures + 1 < LOST_AFTER;
      if (lost) {
        this.schedulePoll(run, failures + 1);
        return;
      }
      this.fail(run, e instanceof EngineClientError && (e.kind === 'network' || e.kind === 'timeout') ? new EngineClientError('エンジンとの接続が切れました。エンジンが動いているか確かめて、もう一度本計算してください。', 'network') : e);
    }
  }

  private applyJob(run: RemoteRun, job: JobState): void {
    run.files = job.files ?? run.files;
    if (job.status === 'done' && job.result) {
      run.phase = 'done';
      this.opts.runner.setRemote({ kind: run.kind, result: job.result, label: `${run.engineName} 本計算`, rev: run.rev, show: true });
      if (run.rev !== this.opts.runner.revision) toast('計算中に形や条件が変わったため、この結果は使えません。もう一度本計算してください', 'error');
      else toast(`${run.engineName} の計算が終わりました`);
    } else if (job.status === 'failed') {
      run.phase = 'failed';
      run.error = job.error ?? '計算に失敗しました。ログを確認してください。';
    } else if (job.status === 'cancelled') {
      run.phase = 'cancelled';
    }
  }

  private fail(run: RemoteRun, e: unknown): void {
    run.phase = 'failed';
    run.error = e instanceof Error ? e.message : String(e);
    this.changed();
  }
}
