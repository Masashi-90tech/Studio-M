// 本物の Engine の経路（HTTP → ジョブ → ctx.run → 本物の ccx / OpenFOAM）を通す結合テスト。
// STUDIO_M_ENGINE_TESTS=1 のときだけ走る（`npm run test:engines`）。入っていない解析ソフトの分は理由を出して飛ばす。
//   Mac の例: STUDIO_M_ENGINE_TESTS=1 STUDIO_M_CCX=/絶対パス/ccx_2.23 npm run test:engines
// 前半の「枠組み」は偽のアダプターで常に走る（ジョブを投げて結果を待つ部分の確認）。
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineStatus, JobRequest, JobState } from '../../src/core/engine-protocol';
import { decodeJobState } from '../../src/core/engine-wire';
import { defaultProject } from '../../src/core/project';
import type { Project, ResultSet } from '../../src/core/types';
import { steelBeam, BEAM } from '../adapters/calculix/test-projects';
import { loadAdapters } from './adapters';
import { findOpenFoamLauncher } from './openfoam-app';
import { createEngineService, type EngineService } from './service';
import { jobBody, startTestService, TEST_TOKEN } from './testing';

const TOKEN = 'e2e-token-0123456789abcdef';
const enabled = process.env.STUDIO_M_ENGINE_TESTS === '1';
const scalar = (r: ResultSet, key: string): number => {
  const v = r.scalars.find((s) => s.key === key)?.value;
  if (v === undefined) throw new Error(`結果に ${key} がありません`);
  return v;
};

/** 実際の HTTP で、ジョブを投げて終わるまで待つ。失敗は、ジョブの error とログの末尾を付けて投げる */
async function submitAndWait(o: { base: string; token: string; body: unknown; timeoutMs: number }): Promise<JobState> {
  const headers = { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' };
  const res = await fetch(`${o.base}/jobs`, { method: 'POST', headers, body: JSON.stringify(o.body) });
  const posted = (await res.json()) as { id?: string; error?: string };
  if (!res.ok || !posted.id) throw new Error(`ジョブを投げられませんでした（HTTP ${res.status}）: ${posted.error ?? '不明'}`);
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(`${o.base}/jobs/${posted.id}`, { headers });
    const job = decodeJobState(await r.json());
    if (job.status === 'done') return job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(`ジョブが ${job.status} になりました。error: ${job.error ?? '（なし）'}\nログの末尾:\n${job.log.slice(-15).join('\n')}`);
    }
    if (Date.now() - t0 > o.timeoutMs) throw new Error(`${o.timeoutMs} ms 待っても終わりませんでした（状態 ${job.status}、${job.message}）\nログの末尾:\n${job.log.slice(-15).join('\n')}`);
    await new Promise((r2) => setTimeout(r2, 300));
  }
}

async function getStatus(base: string, token: string): Promise<EngineStatus & { authorized: boolean }> {
  const res = await fetch(`${base}/status?refresh=1`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as EngineStatus & { authorized: boolean };
}

// ---------- 枠組み（偽のアダプター。常に走る） ----------

describe('結合テストの枠組み（偽のアダプター）', () => {
  it('HTTP で /status を見て、ジョブを投げて、完了まで待てる', async () => {
    const s = await startTestService();
    try {
      const status = await getStatus(s.base, TEST_TOKEN);
      expect(status.authorized).toBe(true);
      expect(status.engines.find((e) => e.id === 'calculix')?.available).toBe(true);
      const job = await submitAndWait({ base: s.base, token: TEST_TOKEN, body: jobBody('ok'), timeoutMs: 20_000 });
      expect(job.status).toBe('done');
      expect(scalar(job.result!, 'maxStress')).toBe(11);
    } finally {
      await s.stop();
    }
  });

  it('失敗したジョブは、error を含むメッセージで投げ直される', async () => {
    const s = await startTestService();
    try {
      await expect(submitAndWait({ base: s.base, token: TEST_TOKEN, body: jobBody('fail'), timeoutMs: 20_000 })).rejects.toThrow('入力が正しくありません');
    } finally {
      await s.stop();
    }
  });
});

// ---------- 本物（STUDIO_M_ENGINE_TESTS=1 のときだけ） ----------

/** 円柱まわりの短い流れ（openfoam.integration.test.ts の「上下が壁 + LES の短い計算」と同じ入力） */
function shortCylinder(): Project {
  const p = defaultProject();
  const d = 0.1;
  p.domain = { width: 1, height: 0.5, nx: 80, autoGrid: false };
  p.flow = { fluidId: 'air', inletVelocity: (2000 * 1.516e-5) / d, walls: 'noslip' };
  p.shapes = [{ id: 'c', name: '円柱', role: 'solid', materialId: 'al6061', geom: { kind: 'circle', cx: 0.25, cy: 0.2515, r: d / 2 } }];
  return p;
}

function realSuite(label: string, parentName: string): void {
  describe.skipIf(!enabled)(`本物の Engine（${label}）`, { timeout: 300_000 }, () => {
    let parent = '';
    let service: EngineService;
    let base = '';
    let status: EngineStatus & { authorized: boolean };

    beforeAll(async () => {
      parent = await mkdtemp(join(tmpdir(), 'studio-m-e2e-'));
      const workRoot = join(parent, parentName);
      await mkdir(workRoot, { recursive: true });
      const commandPaths: Record<string, string> = {};
      const ccx = process.env.STUDIO_M_CCX;
      if (ccx && isAbsolute(ccx) && existsSync(ccx) && statSync(ccx).isFile()) commandPaths.ccx = ccx;
      service = createEngineService({
        adapters: loadAdapters(),
        token: TOKEN,
        port: 0,
        workRoot,
        commandPaths: Object.keys(commandPaths).length > 0 ? commandPaths : undefined,
        commandLaunchers: findOpenFoamLauncher(),
        commandTimeoutMs: 280_000,
      });
      base = `http://127.0.0.1:${await service.listen()}`;
      status = await getStatus(base, TOKEN);
      for (const e of status.engines) console.log(`[e2e ${label}] ${e.name}: ${e.available ? `使える ${e.version ?? ''}（${e.via}）` : `使えない — ${e.note ?? ''}`}`);
    }, 120_000);

    afterAll(async () => {
      await service?.close();
      if (parent) await rm(parent, { recursive: true, force: true });
    });

    it('/status が認可つきで返り、calculix と openfoam の項目がある', () => {
      expect(status.authorized).toBe(true);
      expect(status.engines.map((e) => e.id)).toEqual(expect.arrayContaining(['calculix', 'openfoam']));
    });

    it('CalculiX: 片持ち梁のたわみが梁理論の 10% 以内', async (ctx) => {
      if (!status.engines.find((e) => e.id === 'calculix')?.available) return ctx.skip();
      const P = 100;
      const body: JobRequest = { analysis: 'stress', engine: 'calculix', project: steelBeam({ P }), quality: 'draft' };
      const job = await submitAndWait({ base, token: TOKEN, body, timeoutMs: 120_000 });
      const I = (BEAM.T * BEAM.H ** 3) / 12;
      const euler = (P * (0.995 - 0.01) ** 3) / (3 * BEAM.E * I);
      const tip = scalar(job.result!, 'maxDisplacement');
      expect(Math.abs(tip - euler) / euler, `たわみ ${tip}、理論値 ${euler}。ログ:\n${job.log.slice(-10).join('\n')}`).toBeLessThan(0.1);
      expect(scalar(job.result!, 'reaction')).toBeCloseTo(P, 3);
    });

    it('OpenFOAM: 円柱まわりの短い流れが最後まで解け、速度が有限で抗力が正', async (ctx) => {
      if (!status.engines.find((e) => e.id === 'openfoam')?.available) return ctx.skip();
      const body: JobRequest = { analysis: 'flow', engine: 'openfoam', project: shortCylinder(), quality: 'draft', options: { model: 'auto', flowThroughs: 0.6 } };
      const job = await submitAndWait({ base, token: TOKEN, body, timeoutMs: 280_000 });
      const speed = job.result!.fields.find((f) => f.key === 'speed')!;
      let finite = 0;
      let nonzero = 0;
      for (let c = 0; c < speed.data.length; c++) {
        if (!speed.mask![c]) continue;
        if (Number.isFinite(speed.data[c])) finite++;
        if (speed.data[c] !== 0) nonzero++;
      }
      const fluid = speed.mask!.reduce((a, m) => a + (m ? 1 : 0), 0);
      expect(finite, `有限でない速度があります。ログ:\n${job.log.slice(-10).join('\n')}`).toBe(fluid);
      expect(nonzero).toBeGreaterThan(fluid / 2);
      expect(scalar(job.result!, 'drag')).toBeGreaterThan(0);
    });
  });
}

realSuite('普通のパス', 'work');
// 日本語・空白を含む workRoot を渡しても、Engine が安全な場所に逃がして最後まで解ける
realSuite('日本語と空白を含むパス（安全な場所に逃がす）', 'Studio M テスト');
