import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobBody, startTestService, TEST_TOKEN, type Started } from '../../engine/server/testing';
import { createEngineBridge, type EngineBridge } from './engine-bridge';

let s: Started;
let bridge: EngineBridge;
beforeAll(async () => {
  s = await startTestService();
  bridge = createEngineBridge({ baseUrl: s.base, token: TEST_TOKEN });
});
afterAll(async () => {
  await s.stop();
});

const json = (r: { body: ArrayBuffer }): any => JSON.parse(new TextDecoder().decode(r.body)); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('engine-bridge', () => {
  it('/status が合言葉つきで通る', async () => {
    const r = await bridge.request({ method: 'GET', path: '/status' });
    expect(r.status).toBe(200);
    const b = json(r);
    expect(b.authorized).toBe(true);
    expect(b.capabilities.length).toBeGreaterThan(0);
  });

  it('POST /jobs → GET /jobs/:id → ファイル取得', async () => {
    const posted = await bridge.request({ method: 'POST', path: '/jobs', body: jobBody('ok') });
    expect(posted.status).toBe(201);
    const { id } = json(posted) as { id: string };
    let state: { status: string } = { status: '' };
    for (let i = 0; i < 200 && state.status !== 'done' && state.status !== 'failed'; i++) {
      state = json(await bridge.request({ method: 'GET', path: `/jobs/${id}` }));
      if (state.status !== 'done') await new Promise((r) => setTimeout(r, 50));
    }
    expect(state.status).toBe('done');
    const file = await bridge.request({ method: 'GET', path: `/jobs/${id}/files/out.txt` });
    expect(file.status).toBe(200);
    expect(new TextDecoder().decode(file.body)).toBe('code=0');
    expect(file.headers['content-type']).toBeTruthy();
  });

  it('合言葉が戻り値に漏れない', async () => {
    const r = await bridge.request({ method: 'GET', path: '/status?refresh=1' });
    expect(JSON.stringify(r.headers)).not.toContain(TEST_TOKEN);
    expect(new TextDecoder().decode(r.body)).not.toContain(TEST_TOKEN);
    expect(Object.keys(r.headers).every((k) => ['content-type', 'content-disposition', 'content-length'].includes(k))).toBe(true);
  });

  it('許可外のパス・メソッドは Engine に届かず 403', async () => {
    for (const req of [
      { method: 'GET', path: '/jobs/x/files/../../etc/passwd' },
      { method: 'DELETE', path: '/jobs/abc' },
      { method: 'GET', path: '//evil.example/status' },
      { method: 'GET', path: '/nothing' },
    ]) {
      const r = await bridge.request(req);
      expect(r.status).toBe(403);
      expect(json(r).error).toBeTruthy();
    }
  });

  it('Engine に届かないときは 502 を返す（例外にしない）', async () => {
    const dead = createEngineBridge({ baseUrl: 'http://127.0.0.1:1', token: TEST_TOKEN });
    const r = await dead.request({ method: 'GET', path: '/status' });
    expect(r.status).toBe(502);
  });

  it('宛先は 127.0.0.1 だけ', () => {
    expect(() => createEngineBridge({ baseUrl: 'http://example.com', token: 'x' })).toThrow();
    expect(() => createEngineBridge({ baseUrl: 'https://127.0.0.1:1', token: 'x' })).toThrow();
  });
});
