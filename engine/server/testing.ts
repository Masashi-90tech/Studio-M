// テスト用の部品: 本物の解析ソフトがなくても動く偽のアダプターと、サービスの起動補助。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineCapability } from '../../src/core/engine-protocol';
import { defaultProject } from '../../src/core/project';
import type { Field, ResultSet } from '../../src/core/types';
import type { EngineAdapter } from '../types';
import { createEngineService, type EngineService } from './service';

export const TEST_TOKEN = 'test-token-0123456789abcdef';

export const fakeCapability: EngineCapability = {
  analysis: 'stress',
  engine: 'calculix',
  label: 'テスト用の本計算',
  options: [{ key: 'mode', label: '動き', kind: 'select', default: 'ok', choices: [{ value: 'ok', label: 'ok' }, { value: 'fail', label: 'fail' }, { value: 'slow', label: 'slow' }] }],
};

export function fakeResult(nx = 4, ny = 3): ResultSet {
  const field: Field = { key: 'vonMises', label: 'ミーゼス応力', unit: 'Pa', data: Float32Array.from({ length: nx * ny }, (_, i) => i), mask: new Uint8Array(nx * ny).fill(1) };
  return { analysis: 'stress', nx, ny, h: 0.01, fields: [field], scalars: [{ key: 'maxStress', label: '最大応力', unit: 'Pa', value: 11 }], history: [], warnings: [] };
}

/** mode: ok = 実コマンドを 1 つ走らせて結果を返す / fail = 失敗する / slow = 中止されるまで待つ */
export const fakeAdapter: EngineAdapter = {
  id: 'calculix',
  capabilities: [fakeCapability],
  detect: async () => ({ id: 'calculix', name: 'CalculiX', available: true, version: '9.9', via: 'native', license: 'GPL-2.0' }),
  async solve(req, ctx) {
    const mode = req.options?.mode;
    ctx.progress(0.1, '入力を作っています', 'meshing');
    if (mode === 'fail') throw new Error('入力が正しくありません。形を確かめてください');
    if (mode === 'slow') {
      await ctx.run('node', ['-e', 'setInterval(() => {}, 1000)']);
      throw new Error('ここには来ない');
    }
    const r = await ctx.run('node', ['-e', "console.log('line-one'); console.log('line-two')"]);
    ctx.progress(0.8, '結果を読んでいます', 'reading');
    await writeFile(join(ctx.workDir, 'out.txt'), `code=${r.code}`);
    await writeFile(join(ctx.workDir, 'secret.txt'), 'listed ではない');
    return { result: fakeResult(), files: [{ name: 'out.txt', description: 'テスト出力' }, { name: 'missing.txt', description: 'ない' }] };
  },
};

export interface Started {
  service: EngineService;
  base: string;
  port: number;
  dir: string;
  stop(): Promise<void>;
}

export async function startTestService(opts: { adapters?: EngineAdapter[]; maxBodyBytes?: number; maxConcurrentJobs?: number } = {}): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), 'studio-m-engine-test-'));
  const service = createEngineService({
    adapters: opts.adapters ?? [fakeAdapter],
    token: TEST_TOKEN,
    port: 0,
    workRoot: dir,
    maxBodyBytes: opts.maxBodyBytes,
    maxConcurrentJobs: opts.maxConcurrentJobs,
    commandTimeoutMs: 20_000,
  });
  const port = await service.listen();
  return {
    service,
    port,
    dir,
    base: `http://127.0.0.1:${port}`,
    async stop() {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function jobBody(mode = 'ok'): Record<string, unknown> {
  const project = defaultProject();
  return { analysis: 'stress', engine: 'calculix', project, quality: 'draft', options: { mode } };
}

export const auth = { Authorization: `Bearer ${TEST_TOKEN}` };
