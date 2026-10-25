import { describe, expect, it, vi } from 'vitest';
import { defaultProject } from '../core/project';
import { encodeJobState } from '../core/engine-wire';
import type { JobState } from '../core/engine-protocol';
import { createEngineClient, EngineClientError } from './engine-client';

const okStatus = { server: 'studio-m-engine', protocol: 1, version: '0.5.0', engines: [{ id: 'calculix', name: 'CalculiX', available: true, via: 'native', license: 'GPL-2.0' }], capabilities: [], maxConcurrentJobs: 1, authorized: true };

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function client(fetchImpl: typeof fetch, extra: { token?: string; timeouts?: Record<string, number> } = {}) {
  return createEngineClient({ baseUrl: 'http://127.0.0.1:47800/', token: extra.token ?? 'tok', fetch: fetchImpl, timeouts: extra.timeouts });
}

async function reason(p: Promise<unknown>): Promise<EngineClientError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(EngineClientError);
    return e as EngineClientError;
  }
  throw new Error('失敗するはずが成功した');
}

describe('engine-client', () => {
  it('Authorization ヘッダーと URL（末尾の / は除く）を付ける', async () => {
    const f = vi.fn(async () => reply(200, okStatus));
    const s = await client(f as unknown as typeof fetch).status({ refresh: true });
    expect(s.authorized).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:47800/status?refresh=1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.credentials).toBe('omit');
  });

  it('合言葉が空なら Authorization を付けない', async () => {
    const f = vi.fn(async () => reply(200, { ...okStatus, authorized: false }));
    await client(f as unknown as typeof fetch, { token: '' }).status();
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('POST /jobs は JSON を送り、id を返す', async () => {
    const f = vi.fn(async () => reply(201, { id: 'abc' }));
    const out = await client(f as unknown as typeof fetch).submit({ analysis: 'stress', engine: 'calculix', project: defaultProject(), quality: 'draft' });
    expect(out).toEqual({ id: 'abc' });
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string).engine).toBe('calculix');
  });

  it('ジョブの結果は型つき配列に戻る', async () => {
    const job: JobState = {
      id: 'abc', analysis: 'stress', engine: 'calculix', status: 'done', progress: 1, message: '', log: [], startedAt: 1,
      result: { analysis: 'stress', nx: 2, ny: 1, h: 1, fields: [{ key: 'a', label: 'A', unit: '', data: Float32Array.from([1, 2]) }], scalars: [], history: [], warnings: [] },
    };
    const f = vi.fn(async () => reply(200, encodeJobState(job)));
    const got = await client(f as unknown as typeof fetch).job('abc');
    expect(got.result?.fields[0].data).toBeInstanceOf(Float32Array);
  });

  it('401 / 403 / 400 / 413 / 429 / 500 は種類ごとに、エンジンの説明をそのまま使う', async () => {
    const cases: [number, string][] = [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not-found'], [400, 'rejected'], [409, 'rejected'], [413, 'rejected'], [429, 'busy'], [500, 'server']];
    for (const [status, kind] of cases) {
      const e = await reason(client((async () => reply(status, { error: `説明${status}` })) as typeof fetch).job('x'));
      expect(e.kind).toBe(kind);
      expect(e.message).toBe(`説明${status}`);
      expect(e.status).toBe(status);
    }
  });

  it('説明のない失敗にも日本語の既定の説明を付ける', async () => {
    const e = await reason(client((async () => new Response('oops', { status: 401 })) as typeof fetch).status());
    expect(e.message).toContain('合言葉');
    const e2 = await reason(client((async () => new Response('', { status: 502 })) as typeof fetch).status());
    expect(e2.message).toContain('502');
  });

  it('つながらないときは、起動と URL の確認と Artifact の注意を含む説明', async () => {
    const e = await reason(client((async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch).status());
    expect(e.kind).toBe('network');
    expect(e.message).toContain('npm run engine');
    expect(e.message).toContain('claude.ai');
  });

  it('時間切れは timeout（AbortSignal で fetch を止める）', async () => {
    const f = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const e = await reason(client(f, { timeouts: { status: 30 } }).status());
    expect(e.kind).toBe('timeout');
    expect(e.message).toContain('返事がありません');
  });

  it('Studio M Engine ではない・版が違う・JSON でない返事は protocol エラー', async () => {
    expect((await reason(client((async () => reply(200, { hello: 1 })) as typeof fetch).status())).kind).toBe('protocol');
    const old = await reason(client((async () => reply(200, { ...okStatus, protocol: 99 })) as typeof fetch).status());
    expect(old.kind).toBe('protocol');
    expect(old.message).toContain('99');
    expect((await reason(client((async () => new Response('<html>', { status: 200 })) as typeof fetch).status())).kind).toBe('protocol');
    expect((await reason(client((async () => reply(200, { nope: 1 })) as typeof fetch).job('x'))).kind).toBe('protocol');
  });

  it('ファイルは Blob で受け取り、名前は URL エンコードする', async () => {
    const f = vi.fn(async () => new Response('hello', { status: 200 }));
    const blob = await client(f as unknown as typeof fetch).file({ id: 'abc', name: 'a b/日本.vtk' });
    expect(await blob.text()).toBe('hello');
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('http://127.0.0.1:47800/jobs/abc/files/a%20b%2F%E6%97%A5%E6%9C%AC.vtk');
  });
});
