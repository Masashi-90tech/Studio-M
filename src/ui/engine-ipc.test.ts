import { describe, expect, it, vi } from 'vitest';
import { createEngineClient, EngineClientError } from './engine-client';
import { createIpcFetch, getProBridge, getProFiles, type ProBridge, type ProEngineRequest, type ProEngineResponse } from './engine-ipc';

const enc = (v: unknown): ArrayBuffer => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v)).buffer as ArrayBuffer;
const resp = (status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): ProEngineResponse => ({ status, headers, body: enc(body) });
const okStatus = { server: 'studio-m-engine', protocol: 1, version: '0.5.0', engines: [], capabilities: [], maxConcurrentJobs: 1, authorized: true };

function setup(handler: (r: ProEngineRequest) => Promise<ProEngineResponse>) {
  const request = vi.fn(handler);
  const bridge: ProBridge = { request };
  const client = createEngineClient({ baseUrl: 'http://127.0.0.1', token: '', fetch: createIpcFetch(bridge) });
  return { request, client };
}

async function kind(p: Promise<unknown>): Promise<EngineClientError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(EngineClientError);
    return e as EngineClientError;
  }
  throw new Error('失敗するはずが成功した');
}

describe('engine-ipc', () => {
  it('getProBridge / getProFiles は window.studioMPro があるときだけ返す', () => {
    expect(getProBridge({})).toBeNull();
    expect(getProBridge({ studioMPro: {} })).toBeNull();
    expect(getProBridge({ studioMPro: { engine: { request: async () => resp(200, {}) } } })).not.toBeNull();
    expect(getProFiles({})).toBeNull();
    expect(getProFiles({ studioMPro: { file: { open: async () => null, save: async () => null } } })).not.toBeNull();
  });

  it('GET /status の JSON が読める（パスと method だけを渡す）', async () => {
    const { request, client } = setup(async () => resp(200, okStatus));
    const s = await client.status({ refresh: true });
    expect(s.authorized).toBe(true);
    expect(request).toHaveBeenCalledWith({ method: 'GET', path: '/status?refresh=1' });
  });

  it('POST /jobs の本文は JSON として渡る', async () => {
    const { request, client } = setup(async () => resp(201, { id: 'abc' }));
    const out = await client.submit({ analysis: 'stress', engine: 'calculix', project: { name: 'x' } as never, quality: 'draft' });
    expect(out).toEqual({ id: 'abc' });
    const r = request.mock.calls[0][0];
    expect(r.method).toBe('POST');
    expect(r.path).toBe('/jobs');
    expect((r.body as { engine: string }).engine).toBe('calculix');
  });

  it('403・502 のエラー本文は engine-client が分類する', async () => {
    const a = setup(async () => resp(403, { error: '許可されていません' }));
    const e1 = await kind(a.client.status());
    expect(e1.kind).toBe('forbidden');
    expect(e1.message).toBe('許可されていません');
    const b = setup(async () => resp(502, { error: 'エンジンに届きませんでした' }));
    expect((await kind(b.client.job('x'))).kind).toBe('server');
  });

  it('ファイル（バイナリ）が Blob で取れる', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const { client } = setup(async () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: bytes.buffer as ArrayBuffer }));
    const blob = await client.file({ id: 'a', name: 'out/x.frd' });
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3, 250]);
  });

  it('204 でも Response を作れる', async () => {
    const f = createIpcFetch({ request: async () => ({ status: 204, headers: {}, body: new ArrayBuffer(0) }) });
    expect((await f('http://127.0.0.1/x')).status).toBe(204);
  });

  it('abort されたら AbortError で拒否する', async () => {
    const f = createIpcFetch({ request: () => new Promise<ProEngineResponse>(() => undefined) });
    const ac = new AbortController();
    const p = f('http://127.0.0.1/status', { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await expect(f('http://127.0.0.1/status', { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('IPC が例外を投げたら network として分類される', async () => {
    const { client } = setup(async () => {
      throw new Error('ipc 失敗');
    });
    expect((await kind(client.status())).kind).toBe('network');
  });

  it('時間切れは timeout になる', async () => {
    const request = vi.fn(() => new Promise<ProEngineResponse>(() => undefined));
    const client = createEngineClient({ baseUrl: 'http://127.0.0.1', token: '', fetch: createIpcFetch({ request }), timeouts: { status: 20 } });
    expect((await kind(client.status())).kind).toBe('timeout');
  });
});
