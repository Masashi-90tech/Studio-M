import { describe, expect, it } from 'vitest';
import { defaultProject } from '../../src/core/project';
import { collectAdapters, isAdapter } from './adapters';
import { parseArgs } from './args';
import { extractBearer, generateToken, tokenMatches } from './auth';
import { isAllowedHost, isAllowedOrigin } from './cors';
import { cleanStaleWorkDirs, checkResult, isFlatFileName } from './jobs';
import { fakeAdapter, fakeCapability, fakeResult } from './testing';
import { checkJobRequest, checkOptions, checkProject } from './validate';
import { mkdtemp, mkdir, utimes, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('checkProject', () => {
  it('標準のプロジェクトは通る', () => {
    expect(checkProject(defaultProject()).ok).toBe(true);
  });
  it('構造の壊れたものは理由つきで断る', () => {
    const p = defaultProject();
    const bad = (patch: Record<string, unknown>): string => {
      const r = checkProject({ ...p, ...patch });
      return r.ok ? '' : r.error;
    };
    expect(bad({ version: 2 })).toContain('version');
    expect(bad({ domain: { width: 1, height: 1, nx: 1e9 } })).toContain('nx');
    expect(bad({ thickness: -1 })).toContain('thickness');
    expect(bad({ shapes: [{ id: 'a', materialId: 'x', role: 'rm -rf', geom: { kind: 'rect', x: 0, y: 0, w: 1, h: 1 } }] })).toContain('役割');
    expect(bad({ shapes: [{ id: 'a', materialId: 'x', role: 'solid', geom: { kind: 'rect', x: 0, y: 0, w: NaN, h: 1 } }] })).toContain('長方形');
    expect(bad({ heat: null })).toContain('heat');
    expect(checkProject('x').ok).toBe(false);
  });
});

describe('checkOptions / checkJobRequest', () => {
  it('省略した options は既定値で埋まる', () => {
    expect(checkOptions(fakeCapability, undefined)).toEqual({ ok: true, value: { mode: 'ok' } });
  });
  it('型の違う値・知らない key は断る', () => {
    expect(checkOptions(fakeCapability, { mode: 1 }).ok).toBe(false);
    expect(checkOptions(fakeCapability, { zzz: 1 }).ok).toBe(false);
    expect(checkOptions(fakeCapability, []).ok).toBe(false);
    const cap = { ...fakeCapability, options: [{ key: 'n', label: 'N', kind: 'number' as const, default: 1 }, { key: 'b', label: 'B', kind: 'boolean' as const, default: false }] };
    expect(checkOptions(cap, { n: NaN }).ok).toBe(false);
    expect(checkOptions(cap, { b: 'true' }).ok).toBe(false);
    expect(checkOptions(cap, { n: 2, b: true })).toEqual({ ok: true, value: { n: 2, b: true } });
  });
  it('解析とエンジンの組み合わせが capabilities にないものは断る', () => {
    const body = { analysis: 'flow', engine: 'calculix', project: defaultProject() };
    expect(checkJobRequest(body, [fakeCapability]).ok).toBe(false);
    expect(checkJobRequest({ ...body, analysis: 'stress' }, [fakeCapability])).toMatchObject({ ok: true });
  });
});

describe('合言葉・接続元', () => {
  it('トークンは毎回違い、Bearer の取り出しと比較ができる', () => {
    const a = generateToken();
    expect(a).not.toBe(generateToken());
    expect(a.length).toBeGreaterThanOrEqual(30);
    expect(extractBearer(`Bearer ${a}`)).toBe(a);
    expect(extractBearer('bearer   x ')).toBe('x');
    expect(extractBearer('Basic x')).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
    expect(tokenMatches(a, a)).toBe(true);
    expect(tokenMatches(`${a}x`, a)).toBe(false);
    expect(tokenMatches(null, a)).toBe(false);
  });
  it('Origin と Host の許可', () => {
    expect(isAllowedOrigin('null')).toBe(true);
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedOrigin('http://[::1]:8080')).toBe(true);
    expect(isAllowedOrigin('https://localhost:3000')).toBe(false);
    expect(isAllowedOrigin('https://claude.ai')).toBe(false);
    expect(isAllowedOrigin('http://localhost:3000.evil.com')).toBe(false);
    expect(isAllowedHost('127.0.0.1:47800', 47800)).toBe(true);
    expect(isAllowedHost('LOCALHOST:47800', 47800)).toBe(true);
    expect(isAllowedHost('evil.com:47800', 47800)).toBe(false);
    expect(isAllowedHost('127.0.0.1:1', 47800)).toBe(false);
    expect(isAllowedHost(undefined, 47800)).toBe(false);
  });
});

describe('コマンドライン・アダプター登録・後片づけ', () => {
  it('引数の読み取り', () => {
    expect(parseArgs([])).toMatchObject({ port: 47800, keep: false, maxJobs: 1, errors: [] });
    expect(parseArgs(['--port', '5000', '--keep', '--max-jobs=2'])).toMatchObject({ port: 5000, keep: true, maxJobs: 2, errors: [] });
    expect(parseArgs(['--port', 'abc']).errors).toHaveLength(1);
    expect(parseArgs(['--port', '99999']).errors).toHaveLength(1);
    expect(parseArgs(['--token', 'x']).errors[0]).toContain('知らない');
    expect(parseArgs(['--help']).help).toBe(true);
  });
  it('アダプターの形の判定と収集（空でもよい）', () => {
    expect(isAdapter(fakeAdapter)).toBe(true);
    expect(isAdapter({ id: 'x' })).toBe(false);
    expect(collectAdapters({})).toEqual([]);
    expect(collectAdapters({ '../adapters/a/index.ts': { fakeAdapter, other: 1, dup: fakeAdapter } })).toEqual([fakeAdapter]);
  });
  it('配るファイル名は平らなものだけ', () => {
    for (const ok of ['out.txt', 'case.foam', 'result_1.vtk', '日本語.csv']) expect(isFlatFileName(ok)).toBe(true);
    for (const ng of ['a/b.txt', '../x', 'a\\b', '..', '.hidden', '', 'x\0y', 'a..b']) expect(isFlatFileName(ng)).toBe(false);
  });
  it('結果の形の検査', () => {
    expect(checkResult(fakeResult())).toBeNull();
    const r = fakeResult();
    r.fields[0].data = new Float32Array(3);
    expect(checkResult(r)).toContain('セル数');
    expect(checkResult(undefined)).toContain('返しませんでした');
  });
  it('古い作業フォルダだけを消す', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-m-clean-'));
    await mkdir(join(root, '0123456789abcdef'));
    await mkdir(join(root, 'fedcba9876543210'));
    await mkdir(join(root, 'not-ours'));
    const old = new Date(Date.now() - 48 * 3600_000);
    await utimes(join(root, '0123456789abcdef'), old, old);
    const n = await cleanStaleWorkDirs({ root, olderThanMs: 24 * 3600_000 });
    expect(n).toBe(1);
    expect((await readdir(root)).sort()).toEqual(['fedcba9876543210', 'not-ours']);
    await rm(root, { recursive: true, force: true });
  });
});
