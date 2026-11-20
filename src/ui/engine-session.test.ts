import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultProject } from '../core/project';
import { encodeJobState } from '../core/engine-wire';
import type { JobState } from '../core/engine-protocol';
import type { ProEngineRequest, ProEngineResponse } from './engine-ipc';
import { EngineSession } from './engine-session';
import type { Runner } from './runner';

const enc = (v: unknown): ArrayBuffer => new TextEncoder().encode(JSON.stringify(v)).buffer as ArrayBuffer;
const json = (status: number, body: unknown): ProEngineResponse => ({ status, headers: { 'content-type': 'application/json' }, body: enc(body) });
const okStatus = {
  server: 'studio-m-engine', protocol: 1, version: '0.5.0', authorized: true, maxConcurrentJobs: 1,
  engines: [{ id: 'calculix', name: 'CalculiX', available: true, via: 'native', license: 'GPL-2.0' }],
  capabilities: [{ analysis: 'stress', engine: 'calculix', label: 'CalculiX' }],
};
const doneJob: JobState = {
  id: 'j1', analysis: 'stress', engine: 'calculix', status: 'done', progress: 1, message: '', log: [], startedAt: 1,
  result: { analysis: 'stress', nx: 2, ny: 1, h: 1, fields: [{ key: 'a', label: 'A', unit: '', data: Float32Array.from([1, 2]) }], scalars: [], history: [], warnings: [] },
};

function fakeRunner() {
  const setRemote = vi.fn();
  const runner = { resolved: defaultProject(), analysis: 'stress', revision: 1, setRemote } as unknown as Runner;
  return { runner, setRemote };
}

beforeEach(() => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.stubGlobal('document', { getElementById: () => null });
});
afterEach(() => vi.unstubAllGlobals());

describe('EngineSession（Pro）', () => {
  it('合言葉なしで接続でき、本計算が完了まで進む', async () => {
    const seen: ProEngineRequest[] = [];
    const bridge = {
      request: async (r: ProEngineRequest): Promise<ProEngineResponse> => {
        seen.push(r);
        if (r.path.startsWith('/status')) return json(200, okStatus);
        if (r.method === 'POST' && r.path === '/jobs') return json(201, { id: 'j1' });
        if (r.path === '/jobs/j1') return json(200, encodeJobState(doneJob));
        return json(404, { error: 'ない' });
      },
    };
    const { runner, setRemote } = fakeRunner();
    const session = new EngineSession({ runner, bridge });
    expect(session.mode).toBe('pro');
    expect(await session.connect({ refresh: true })).toBe(true);
    expect(session.status?.engines[0].name).toBe('CalculiX');
    await session.start(okStatus.capabilities[0] as never);
    await vi.waitFor(() => expect(session.runFor('stress')?.phase).toBe('done'));
    expect(setRemote).toHaveBeenCalledOnce();
    expect(seen.some((r) => r.path === '/status?refresh=1')).toBe(true);
  });

  it('接続できないときは、Pro 向けの説明（アプリの再起動）を出す', async () => {
    const bridge = {
      request: async (): Promise<ProEngineResponse> => {
        throw new Error('ipc 失敗');
      },
    };
    const session = new EngineSession({ runner: fakeRunner().runner, bridge });
    expect(await session.connect()).toBe(false);
    expect(session.conn.kind === 'error' && session.conn.message).toContain('アプリを再起動');
    expect(session.conn.kind === 'error' && session.conn.message).not.toContain('npm run engine');
  });

  it('setConfig は何も保存せず、接続の状態も変えない', () => {
    const session = new EngineSession({ runner: fakeRunner().runner, bridge: { request: async () => json(200, okStatus) } });
    session.setConfig({ url: 'http://example.com', token: 'x' });
    expect(session.config.token).toBe('');
    expect(session.conn.kind).toBe('none');
  });
});

describe('EngineSession（Lite）', () => {
  it('bridge がなければ mode は lite', () => {
    const session = new EngineSession({ runner: fakeRunner().runner, bridge: null });
    expect(session.mode).toBe('lite');
  });
});
