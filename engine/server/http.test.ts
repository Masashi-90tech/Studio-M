import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJobState } from '../../src/core/engine-wire';
import type { JobState } from '../../src/core/engine-protocol';
import { auth, jobBody, startTestService, TEST_TOKEN, type Started } from './testing';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (r: Response): Promise<any> => r.json();

let s: Started;
beforeAll(async () => {
  s = await startTestService();
});
afterAll(async () => {
  await s.stop();
});

const get = (path: string, headers: Record<string, string> = {}): Promise<Response> => fetch(`${s.base}${path}`, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = auth): Promise<Response> =>
  fetch(`${s.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function waitDone(id: string): Promise<JobState> {
  for (let i = 0; i < 200; i++) {
    const r = await get(`/jobs/${id}`, auth);
    const st = decodeJobState(await j(r));
    if (st.status === 'done' || st.status === 'failed' || st.status === 'cancelled') return st;
    await new Promise((r2) => setTimeout(r2, 50));
  }
  throw new Error('終わらなかった');
}

describe('合言葉', () => {
  it('/status は合言葉なしでも返るが、中身は最小限', async () => {
    const r = await get('/status');
    expect(r.status).toBe(200);
    const body = await j(r);
    expect(body).toMatchObject({ server: 'studio-m-engine', protocol: 1, authorized: false, engines: [], capabilities: [] });
  });

  it('/status に間違った合言葉を付けても、authorized: false で最小限', async () => {
    const r = await get('/status', { Authorization: 'Bearer wrong' });
    expect((await j(r)).authorized).toBe(false);
  });

  it('/status に正しい合言葉を付けるとエンジン一覧が返る（未対応のエンジンも載る）', async () => {
    const body = await j(await get('/status', auth));
    expect(body.authorized).toBe(true);
    const calculix = body.engines.find((e: { id: string }) => e.id === 'calculix');
    expect(calculix).toMatchObject({ available: true, version: '9.9', via: 'native' });
    expect(body.engines.find((e: { id: string }) => e.id === 'elmer')).toMatchObject({ available: false, via: 'none' });
    expect(body.capabilities).toHaveLength(1);
  });

  it('合言葉がない・違う要求は 401（日本語の説明つき）', async () => {
    for (const headers of [{} as Record<string, string>, { Authorization: 'Bearer wrong' }, { Authorization: `Basic ${TEST_TOKEN}` }, { Authorization: TEST_TOKEN }]) {
      const r = await post('/jobs', jobBody(), headers);
      expect(r.status).toBe(401);
      expect((await j(r)).error).toContain('合言葉');
    }
    expect((await get('/jobs/0123456789abcdef')).status).toBe(401);
    expect((await post('/jobs/0123456789abcdef/cancel', {}, {})).status).toBe(401);
    expect((await get('/jobs/0123456789abcdef/files/out.txt')).status).toBe(401);
  });
});

describe('CORS と Host', () => {
  it('許す接続元には Access-Control-Allow-Origin を返す', async () => {
    for (const origin of ['null', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost']) {
      const r = await get('/status', { Origin: origin });
      expect(r.status).toBe(200);
      expect(r.headers.get('access-control-allow-origin')).toBe(origin);
    }
  });

  it('他の接続元は 403 で、CORS ヘッダーも付けない', async () => {
    for (const origin of ['https://claude.ai', 'https://evil.example', 'http://localhost.evil.com', 'http://127.0.0.1.evil.com:80', 'file://']) {
      const r = await get('/status', { Origin: origin, ...auth });
      expect(r.status).toBe(403);
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('事前確認（OPTIONS）は合言葉なしで 204、許可した接続元だけ', async () => {
    const ok = await fetch(`${s.base}/jobs`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type', 'Access-Control-Request-Private-Network': 'true' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(ok.headers.get('access-control-allow-private-network')).toBe('true');
    const ng = await fetch(`${s.base}/jobs`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(ng.status).toBe(403);
  });

  it('Host が違う要求（DNS リバインディング）は 403', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: s.port, path: '/status', headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('401 のような失敗でも、許可した接続元には CORS ヘッダーが付く（画面が理由を読めるように）', async () => {
    const r = await post('/jobs', jobBody(), { Origin: 'null' });
    expect(r.status).toBe(401);
    expect(r.headers.get('access-control-allow-origin')).toBe('null');
  });
});

describe('本文の検査', () => {
  it('JSON でない・Content-Type が違う・必須項目がない・知らない値は 400 / 415', async () => {
    expect((await post('/jobs', 'これは json ではない')).status).toBe(400);
    expect((await fetch(`${s.base}/jobs`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    const bad = async (patch: Record<string, unknown>): Promise<string> => {
      const r = await post('/jobs', { ...jobBody(), ...patch });
      expect(r.status).toBe(400);
      return (await j(r)).error as string;
    };
    expect(await bad({ analysis: 'nope' })).toContain('analysis');
    expect(await bad({ engine: 'rm -rf' })).toContain('engine');
    expect(await bad({ engine: 'openfoam' })).toContain('対応していません');
    expect(await bad({ quality: 'ultra' })).toContain('quality');
    expect(await bad({ project: { version: 2 } })).toContain('project');
    expect(await bad({ options: { mode: 'zzz' } })).toContain('選択肢');
    expect(await bad({ options: { path: '/etc/passwd' } })).toContain('知らない項目');
  });

  it('大きすぎる本文は 413', async () => {
    const small = await startTestService({ maxBodyBytes: 200 });
    try {
      const r = await fetch(`${small.base}/jobs`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(jobBody()) });
      expect(r.status).toBe(413);
    } finally {
      await small.stop();
    }
  });

  it('存在しない・形の違うジョブ id は 404', async () => {
    expect((await get('/jobs/0123456789abcdef', auth)).status).toBe(404);
    expect((await get('/jobs/..%2F..%2Fetc', auth)).status).toBe(404);
    expect((await get('/nothing', auth)).status).toBe(404);
  });
});

describe('ジョブの流れ', () => {
  it('queued → running → done。結果は型つき配列で届き、ログと一覧にあるファイルだけ取れる', async () => {
    const r = await post('/jobs', jobBody());
    expect(r.status).toBe(201);
    const { id } = (await j(r)) as { id: string };
    expect(id).toMatch(/^[0-9a-f]{16}$/);

    const st = await waitDone(id);
    expect(st.status).toBe('done');
    expect(st.progress).toBe(1);
    expect(st.log).toEqual(expect.arrayContaining(['line-one', 'line-two']));
    expect(st.result?.fields[0].data).toBeInstanceOf(Float32Array);
    expect(st.result?.fields[0].data[5]).toBe(5);
    expect(st.result?.fields[0].mask).toBeInstanceOf(Uint8Array);
    expect(st.files).toEqual([{ name: 'out.txt', size: 6, description: 'テスト出力' }]); // 存在しない missing.txt は外れる

    const file = await get(`/jobs/${id}/files/out.txt`, auth);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('code=0');
    expect(file.headers.get('content-disposition')).toContain('out.txt');
    // 一覧にないファイル、作業フォルダの外は取れない
    expect((await get(`/jobs/${id}/files/secret.txt`, auth)).status).toBe(404);
    expect((await get(`/jobs/${id}/files/..%2F..%2Fetc%2Fpasswd`, auth)).status).toBe(404);
    expect((await get(`/jobs/${id}/files/missing.txt`, auth)).status).toBe(404);
  });

  it('アダプターが失敗すると failed と、利用者向けの説明', async () => {
    const { id } = (await j(await post('/jobs', jobBody('fail')))) as { id: string };
    const st = await waitDone(id);
    expect(st.status).toBe('failed');
    expect(st.error).toBe('入力が正しくありません。形を確かめてください');
    expect(st.result).toBeUndefined();
  });

  it('中止すると走っているコマンドが止まり cancelled になる', async () => {
    const { id } = (await j(await post('/jobs', jobBody('slow')))) as { id: string };
    // 走り始めるまで待つ
    for (let i = 0; i < 100; i++) {
      const st = decodeJobState(await j(await get(`/jobs/${id}`, auth)));
      if (st.status === 'meshing' || st.status === 'running') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 300));
    const c = await post(`/jobs/${id}/cancel`, {});
    expect(c.status).toBe(200);
    const st = await waitDone(id);
    expect(st.status).toBe('cancelled');
    expect(st.finishedAt).toBeDefined();
  });

  it('待ち行列: 同時 1 件なので 2 件目は queued で待ち、1 件目の後に走る。待っている間に中止もできる', async () => {
    const a = (await j(await post('/jobs', jobBody('slow')))) as { id: string };
    const b = (await j(await post('/jobs', jobBody('ok')))) as { id: string };
    const c = (await j(await post('/jobs', jobBody('ok')))) as { id: string };
    await new Promise((r) => setTimeout(r, 300));
    expect(decodeJobState(await j(await get(`/jobs/${b.id}`, auth))).status).toBe('queued');
    // c を待ち行列のまま中止
    await post(`/jobs/${c.id}/cancel`, {});
    expect(decodeJobState(await j(await get(`/jobs/${c.id}`, auth))).status).toBe('cancelled');
    await post(`/jobs/${a.id}/cancel`, {});
    expect((await waitDone(a.id)).status).toBe('cancelled');
    expect((await waitDone(b.id)).status).toBe('done');
  });
});
