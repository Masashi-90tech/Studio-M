import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProbe, detectEngines } from './detect';
import { ExecError, runCommand } from './exec';
import { createWrapperLauncher, joinShellCommand } from './launcher';
import { findOpenFoamApp } from './openfoam-app';
import { createAdapterContext } from './context';
import type { EngineAdapter } from '../types';

let dir: string;
let wrapper: string;
beforeAll(async () => {
  // 空白と日本語を含むフォルダーに置いた偽のラッパー（-c の文字列を sh -c で実行する）
  dir = await mkdtemp(join(tmpdir(), 'studio-m 起動 test-'));
  wrapper = join(dir, 'openfoam');
  await writeFile(wrapper, '#!/bin/sh\n[ "$1" = "-c" ] || exit 9\nexec sh -c "$2"\n');
  await chmod(wrapper, 0o755);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const native = { kind: 'native' } as const;

describe('joinShellCommand', () => {
  it('コマンド名と引数を、各引数をシングルクォートで包んで連結する', () => {
    expect(joinShellCommand('subsetMesh', ['-overwrite', 'fluidCells', '-patch', 'obstacle'])).toBe("subsetMesh '-overwrite' 'fluidCells' '-patch' 'obstacle'");
    expect(joinShellCommand('blockMesh', [])).toBe('blockMesh');
    expect(joinShellCommand('foamToVTK', ['-latestTime', 'a=1.5,b:c/d@e%f+g'])).toContain("'a=1.5,b:c/d@e%f+g'");
  });

  it.each(['; rm -rf /', '$(id)', 'a\nb', 'a b', '日本語', '`id`', "a'b", '"a"', 'a|b', 'a&b', '', 'a\\b', '*'])('安全でない引数「%s」は bad-request', (bad) => {
    expect(() => joinShellCommand('blockMesh', [bad])).toThrow(ExecError);
    try {
      joinShellCommand('blockMesh', [bad]);
    } catch (e) {
      expect((e as ExecError).reason).toBe('bad-request');
    }
  });

  it('不正なコマンド名も断る', () => {
    expect(() => joinShellCommand('blockMesh; ls', [])).toThrow(ExecError);
    expect(() => joinShellCommand('../x', [])).toThrow(ExecError);
  });
});

describe('commandLaunchers 経由の実行', () => {
  const launcher = (): ReturnType<typeof createWrapperLauncher> => createWrapperLauncher({ commands: ['echo', 'sh'], file: wrapper });

  it('対象のコマンドはラッパー経由で起動し、出力と終了コードが返る', async () => {
    const r = await runCommand({ command: 'echo', args: ['hello', 'a=1'], workDir: dir, backend: native, commandLaunchers: launcher() });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('hello a=1');
    // 空白を含むもの（ラッパーのパス）でも起動できている。引数に空白があれば断る
    await expect(runCommand({ command: 'sh', args: ['a b'], workDir: dir, backend: native, commandLaunchers: launcher() })).rejects.toMatchObject({ reason: 'bad-request' });
    const r3 = await runCommand({ command: 'sh', args: ['/nonexistent-file'], workDir: dir, backend: native, commandLaunchers: launcher() });
    expect(r3.code).not.toBe(0);
  });

  it('危険な引数は起動する前に bad-request', async () => {
    await expect(runCommand({ command: 'echo', args: ['; touch pwned'], workDir: dir, backend: native, commandLaunchers: launcher() })).rejects.toMatchObject({ reason: 'bad-request' });
  });

  it('対象外のコマンド・未指定のときは今までどおり直接起動する', async () => {
    const a = await runCommand({ command: 'node', args: ['-e', 'console.log("a b")'], workDir: dir, backend: native, commandLaunchers: launcher() });
    expect(a.stdout.trim()).toBe('a b');
    const b = await runCommand({ command: 'node', args: ['-e', 'console.log("x y")'], workDir: dir, backend: native });
    expect(b.stdout.trim()).toBe('x y');
  });

  it('probe でも使われる', async () => {
    const probe = createProbe({ commandLaunchers: launcher() });
    expect(await probe('echo', ['ok'])).toEqual({ ok: true, output: 'ok' });
  });

  it('ctx.run でも使われる', async () => {
    const adapter = { id: 'openfoam' } as EngineAdapter;
    const ctx = createAdapterContext({
      jobId: 'j',
      workDir: dir,
      signal: new AbortController().signal,
      adapter,
      info: undefined,
      dockerAvailable: false,
      commandTimeoutMs: 10_000,
      commandLaunchers: launcher(),
      log: () => undefined,
      progress: () => undefined,
    });
    const r = await ctx.run('echo', ['via-ctx']);
    expect(r.stdout.trim()).toBe('via-ctx');
  });

  it('detect の launcherLabel に名前が渡る', async () => {
    let seen: string | undefined;
    const adapter = {
      id: 'openfoam',
      capabilities: [],
      detect: async (c) => {
        seen = c.launcherLabel?.('blockMesh');
        return { id: 'openfoam', name: 'x', available: false, via: 'none', license: 'x' };
      },
      solve: async () => {
        throw new Error('x');
      },
    } as EngineAdapter;
    await detectEngines({ adapters: [adapter], probe: async () => ({ ok: false, output: '' }), run: async () => ({ code: 1, stdout: '', stderr: '' }), commandLaunchers: createWrapperLauncher({ commands: ['blockMesh'], file: wrapper, label: 'OpenFOAM.app（v2606）' }) });
    expect(seen).toBe('OpenFOAM.app（v2606）');
  });
});

describe('findOpenFoamApp', () => {
  const tree: Record<string, string[]> = { '/Applications': ['Safari.app', 'OpenFOAM-v2406.app', 'OpenFOAM-v2606.app', 'OpenFOAM-vXXXX.app'], '/home/u/Applications': ['OpenFOAM-v2512.app'] };
  const wr = (root: string, n: string): string => join(root, n, 'Contents/Resources/etc/openfoam');
  const exists = (p: string): boolean => [wr('/Applications', 'OpenFOAM-v2406.app'), wr('/Applications', 'OpenFOAM-v2606.app'), wr('/home/u/Applications', 'OpenFOAM-v2512.app')].includes(p);
  const base = { platform: 'darwin' as const, override: '', listDir: (d: string) => tree[d] ?? [], exists };

  it('新しい版を優先する', () => {
    expect(findOpenFoamApp({ ...base, roots: ['/Applications', '/home/u/Applications'] })).toEqual({ wrapper: wr('/Applications', 'OpenFOAM-v2606.app'), version: 'v2606' });
    expect(findOpenFoamApp({ ...base, roots: ['/home/u/Applications'] })?.version).toBe('v2512');
  });
  it('ラッパーがない・フォルダーがない・darwin 以外は null', () => {
    expect(findOpenFoamApp({ ...base, roots: ['/Applications'], exists: () => false })).toBeNull();
    expect(findOpenFoamApp({ ...base, roots: ['/nowhere'] })).toBeNull();
    expect(findOpenFoamApp({ ...base, roots: ['/Applications'], platform: 'linux' })).toBeNull();
  });
  it('STUDIO_M_OPENFOAM_APP で .app でも wrapper でも指定できる', () => {
    const app = '/Applications/OpenFOAM-v2406.app';
    expect(findOpenFoamApp({ ...base, roots: [], override: app })).toEqual({ wrapper: wr('/Applications', 'OpenFOAM-v2406.app'), version: 'v2406' });
    expect(findOpenFoamApp({ ...base, roots: [], override: wr('/Applications', 'OpenFOAM-v2406.app') })?.version).toBe('v2406');
  });
});
