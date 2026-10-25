// Studio M Engine への問い合わせ（fetch だけ。DOM には触れない）。
// 失敗はすべて EngineClientError にして、利用者向けの日本語の説明を持たせる。
import { ENGINE_PROTOCOL_VERSION, type JobRequest, type JobState } from '../core/engine-protocol';
import { decodeJobState, type EngineStatusResponse } from '../core/engine-wire';

export type EngineErrorKind = 'network' | 'timeout' | 'unauthorized' | 'forbidden' | 'not-found' | 'rejected' | 'busy' | 'protocol' | 'server';

export class EngineClientError extends Error {
  constructor(
    message: string,
    readonly kind: EngineErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EngineClientError';
  }
}

type Op = 'status' | 'job' | 'submit' | 'cancel' | 'file';
const DEFAULT_TIMEOUTS: Record<Op, number> = { status: 5000, job: 10_000, submit: 60_000, cancel: 10_000, file: 120_000 };

export interface EngineClientOptions {
  /** 例: http://127.0.0.1:47800 */
  baseUrl: string;
  token: string;
  /** テスト用に差し替える */
  fetch?: typeof fetch;
  /** 操作ごとの時間切れ [ms] */
  timeouts?: Partial<Record<Op, number>>;
}

export interface EngineClient {
  status(opts?: { refresh?: boolean }): Promise<EngineStatusResponse>;
  submit(req: JobRequest): Promise<{ id: string }>;
  job(id: string): Promise<JobState>;
  cancel(id: string): Promise<JobState>;
  file(opts: { id: string; name: string }): Promise<Blob>;
}

const NETWORK_HELP = 'エンジンに接続できません。エンジンが起動しているか（npm run engine）、URL が正しいかを確かめてください。claude.ai 上の公開ページからは接続できないので、ダウンロードした HTML か開発版で開いてください。';

export function createEngineClient(opts: EngineClientOptions): EngineClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };

  async function request(op: Op, path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeouts[op]);
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const res = await doFetch(`${base}${path}`, { method: init.method ?? 'GET', headers, body: init.body, signal: ac.signal, cache: 'no-store', credentials: 'omit' });
      if (!res.ok) throw await failure(res);
      return res;
    } catch (e) {
      if (e instanceof EngineClientError) throw e;
      if (timedOut) throw new EngineClientError(`エンジンから ${Math.round(timeouts[op] / 1000)} 秒以内に返事がありませんでした。エンジンが止まっていないか確かめてください。`, 'timeout');
      throw new EngineClientError(NETWORK_HELP, 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  async function json(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new EngineClientError('エンジンの返事が読めません。これは Studio M Engine ではないか、版が合っていない可能性があります。', 'protocol');
    }
  }

  return {
    async status(o = {}) {
      const body = (await json(await request('status', `/status${o.refresh ? '?refresh=1' : ''}`))) as Partial<EngineStatusResponse> | null;
      if (!body || body.server !== 'studio-m-engine') throw new EngineClientError('この URL は Studio M Engine ではないようです。URL とポートを確かめてください。', 'protocol');
      if (body.protocol !== ENGINE_PROTOCOL_VERSION) {
        throw new EngineClientError(`エンジンの通信の版（${String(body.protocol)}）が Studio M（${ENGINE_PROTOCOL_VERSION}）と合っていません。どちらかを更新してください。`, 'protocol');
      }
      return { ...(body as EngineStatusResponse), authorized: body.authorized === true, engines: body.engines ?? [], capabilities: body.capabilities ?? [] };
    },
    async submit(req) {
      const body = (await json(await request('submit', '/jobs', { method: 'POST', body: JSON.stringify(req) }))) as { id?: unknown } | null;
      if (!body || typeof body.id !== 'string') throw new EngineClientError('エンジンの返事に計算の番号がありません。', 'protocol');
      return { id: body.id };
    },
    async job(id) {
      const raw = await json(await request('job', `/jobs/${encodeURIComponent(id)}`));
      return parseJob(raw);
    },
    async cancel(id) {
      const raw = await json(await request('cancel', `/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }));
      return parseJob(raw);
    },
    async file({ id, name }) {
      const res = await request('file', `/jobs/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`);
      return res.blob();
    },
  };
}

function parseJob(raw: unknown): JobState {
  try {
    return decodeJobState(raw);
  } catch (e) {
    throw new EngineClientError(e instanceof Error ? e.message : 'エンジンの返事が読めません。', 'protocol');
  }
}

/** HTTP のエラー応答 → 説明つきのエラー。エンジンが返した日本語の error をそのまま使う */
async function failure(res: Response): Promise<EngineClientError> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') detail = body.error;
  } catch {
    // 本文が JSON でなくても、状態コードで説明する
  }
  switch (res.status) {
    case 401:
      return new EngineClientError(detail || '合言葉が正しくありません。エンジンを起動したときに表示された合言葉を貼り付けてください。', 'unauthorized', 401);
    case 403:
      return new EngineClientError(detail || 'このページからの接続は許可されていません。', 'forbidden', 403);
    case 404:
      return new EngineClientError(detail || '見つかりません。', 'not-found', 404);
    case 429:
      return new EngineClientError(detail || 'いまエンジンが混み合っています。しばらくしてから試してください。', 'busy', 429);
    case 400:
    case 409:
    case 413:
    case 415:
      return new EngineClientError(detail || '送った内容をエンジンが受け付けませんでした。', 'rejected', res.status);
    default:
      return new EngineClientError(detail || `エンジンでエラーが起きました（${res.status}）。エンジンの画面のログを確認してください。`, 'server', res.status);
  }
}
