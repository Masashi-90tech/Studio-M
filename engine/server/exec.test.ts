import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineInfo } from '../../src/core/engine-protocol';
import type { EngineAdapter } from '../types';
import { createAdapterContext, decideBackend } from './context';
import { detectEngines, probeCommand } from './detect';
import { buildDockerArgs, createLineSplitter, ExecError, isValidCommand, resolveInside, runCommand } from './exec';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-m-exec-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const native = { kind: 'native' } as const;

describe('ctx.run（node -e で確かめる）', () => {
  it('標準出力・標準エラー・終了コードと、行ごとの通知', async () => {
    const lines: string[] = [];
    const r = await runCommand({
      command: 'node',
      args: ['-e', "console.log('a'); console.error('b'); process.stdout.write('c'); process.exit(3)"],
      workDir: dir,
      backend: native,
      onLine: (l, s) => lines.push(`${s}:${l}`),
    });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('a\nc');
    expect(r.stderr).toBe('b\n');
    expect(lines).toEqual(expect.arrayContaining(['stdout:a', 'stderr:b', 'stdout:c']));
  });

  it('cwd（作業フォルダからの相対）と env が効き、作業フォルダの外は断る', async () => {
    await mkdir(join(dir, 'sub'), { recursive: true });
    const r = await runCommand({ command: 'node', args: ['-e', 'console.log(process.cwd() + "|" + process.env.FOO)'], workDir: dir, cwd: 'sub', env: { FOO: 'bar' }, backend: native });
    expect(r.stdout.trim().endsWith('sub|bar')).toBe(true);
    await expect(runCommand({ command: 'node', args: ['-v'], workDir: dir, cwd: '../..', backend: native })).rejects.toMatchObject({ reason: 'bad-request' });
  });

  it('シェルを通さない（; や $() はただの引数）', async () => {
    const r = await runCommand({ command: 'node', args: ['-e', 'console.log(process.argv[1])', '$(echo x); echo y'], workDir: dir, backend: native });
    expect(r.stdout.trim()).toBe('$(echo x); echo y');
  });

  it('見つからないコマンドは not-found、パスや記号の入ったコマンド名は bad-request', async () => {
    await expect(runCommand({ command: 'studio-m-no-such-command', args: [], workDir: dir, backend: native })).rejects.toMatchObject({ reason: 'not-found' });
    for (const bad of ['/bin/sh', '../x', 'a b', 'a;b', '-rf', '']) {
      await expect(runCommand({ command: bad, args: [], workDir: dir, backend: native })).rejects.toBeInstanceOf(ExecError);
    }
  });

  it('時間切れで止める', async () => {
    const t = Date.now();
    await expect(runCommand({ command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], workDir: dir, backend: native, timeoutMs: 300 })).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('中止（AbortSignal）で子プロセスごと止める', async () => {
    const ac = new AbortController();
    const p = runCommand({ command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], workDir: dir, backend: native, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toMatchObject({ reason: 'aborted', name: 'AbortError' });
  });
});

describe('Docker', () => {
  it('docker run の引数を組み立てる', () => {
    const args = buildDockerArgs({
      image: 'opencfd/openfoam-default:2406',
      workDir: '/tmp/studio-m-engine/abc',
      command: 'blockMesh',
      args: ['-case', 'case1'],
      cwd: 'run',
      env: { A: '1' },
      containerName: 'studio-m-abc-1',
      user: { uid: 1000, gid: 1000 },
    });
    expect(args).toEqual([
      'run', '--rm', '--name', 'studio-m-abc-1', '--network', 'none', '--user', '1000:1000',
      '-v', '/tmp/studio-m-engine/abc:/work', '-w', '/work/run', '-e', 'A=1',
      'opencfd/openfoam-default:2406', 'blockMesh', '-case', 'case1',
    ]);
  });

  it('cwd がなければ /work、外へ出る cwd は断る', () => {
    const base = { image: 'img', workDir: '/w', command: 'ccx', args: ['job'] };
    expect(buildDockerArgs(base)).toContain('/work');
    expect(() => buildDockerArgs({ ...base, cwd: '../x' })).toThrow(ExecError);
  });

  it('native が見つからないときだけ Docker を選ぶ', () => {
    expect(decideBackend({ via: 'docker', dockerImage: 'img', dockerAvailable: true })).toEqual({ kind: 'docker', image: 'img' });
    expect(decideBackend({ via: 'docker', dockerImage: 'img', dockerAvailable: false })).toEqual({ kind: 'native' });
    expect(decideBackend({ via: 'docker', dockerAvailable: true })).toEqual({ kind: 'native' });
    expect(decideBackend({ via: 'native', dockerImage: 'img', dockerAvailable: true })).toEqual({ kind: 'native' });
  });

  it('ctx.run は native で見つからず Docker が使えるなら、Docker でやり直す', async () => {
    const lines: string[] = [];
    const adapter = { id: 'calculix', dockerImage: 'img:1', capabilities: [], detect: async () => ({}) as EngineInfo, solve: async () => ({}) as never } as EngineAdapter;
    const ctx = createAdapterContext({
      jobId: 'j1', workDir: dir, signal: new AbortController().signal, adapter, info: undefined, dockerAvailable: true, commandTimeoutMs: 5000,
      log: (l) => lines.push(l), progress: () => undefined,
    });
    await ctx.run('studio-m-no-such-command', []).catch(() => undefined); // docker の有無で結果は変わる。やり直したことだけ確かめる
    expect(lines.some((l) => l.includes('Docker'))).toBe(true);
  });
});

describe('補助', () => {
  it('コマンド名と作業フォルダ内の判定', () => {
    expect(isValidCommand('ccx')).toBe(true);
    expect(isValidCommand('foamToVTK')).toBe(true);
    expect(isValidCommand('ccx; rm')).toBe(false);
    expect(resolveInside('/a/b', 'c/d')).toBe('/a/b/c/d');
    expect(() => resolveInside('/a/b', '../c')).toThrow();
    expect(() => resolveInside('/a/b', '/etc')).toThrow();
  });

  it('行の分割: 途中で切れた行は次の塊とつなぐ', () => {
    const out: string[] = [];
    const sp = createLineSplitter((l) => out.push(l));
    sp.push('ab');
    sp.push('c\nde');
    sp.push('f\r\ng');
    sp.flush();
    expect(out).toEqual(['abc', 'def', 'g']);
  });
});

describe('検出', () => {
  it('probe: 終了コード 0 なら ok、0 以外でも出力は返す、見つからなければ ok: false', async () => {
    expect(await probeCommand('node', ['-e', 'console.log("v1")'])).toEqual({ ok: true, output: 'v1' });
    expect(await probeCommand('node', ['-e', 'console.log("Version 2.21"); process.exit(201)'])).toMatchObject({ ok: false, output: expect.stringContaining('Version 2.21') });
    expect(await probeCommand('studio-m-no-such-command', [])).toEqual({ ok: false, output: '' });
  });

  const adapter = (over: Partial<EngineAdapter> = {}): EngineAdapter => ({
    id: 'openfoam',
    capabilities: [{ analysis: 'flow', engine: 'openfoam', label: 'x' }],
    detect: async (ctx) => {
      const p = await ctx.probe('studio-m-no-such-command', ['-v']);
      return { id: 'openfoam', name: 'OpenFOAM', available: p.ok, via: p.ok ? 'native' : 'none', license: 'GPL-3.0', note: 'apt install openfoam' };
    },
    solve: async () => {
      throw new Error('使わない');
    },
    ...over,
  });

  it('見つからないエンジンは available: false で note つき。未対応のエンジンも並ぶ', async () => {
    const d = await detectEngines({ adapters: [adapter()], run: async (o) => (o.command === 'docker' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }) });
    expect(d.engines.find((e) => e.id === 'openfoam')).toMatchObject({ available: false, note: 'apt install openfoam' });
    expect(d.engines.map((e) => e.id)).toEqual(expect.arrayContaining(['gmsh', 'elmer', 'openems']));
    expect(d.dockerAvailable).toBe(false);
  });

  it('直接は見つからなくても、Docker のイメージが手元にあれば docker 経由で使える', async () => {
    const d = await detectEngines({ adapters: [adapter({ dockerImage: 'opencfd/openfoam-default:2406' })], run: async () => ({ code: 0, stdout: '27.0', stderr: '' }) });
    expect(d.engines.find((e) => e.id === 'openfoam')).toMatchObject({ available: true, via: 'docker' });
  });

  it('detect が例外を投げても、そのエンジンが使えないだけ', async () => {
    const d = await detectEngines({ adapters: [adapter({ detect: async () => { throw new Error('boom'); } })], run: async () => ({ code: 1, stdout: '', stderr: '' }) });
    expect(d.engines.find((e) => e.id === 'openfoam')).toMatchObject({ available: false });
  });
});
