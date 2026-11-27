// Studio M Engine の経路（HTTP → ジョブ → ccx → 結果の取得）を、画面なしでそっくり測る道具。
//   npx vite-node engine/tools/bench-engine.ts
// 環境変数: STUDIO_M_CCX（使う ccx の絶対パス。省略すると PATH の ccx）。
// bench-beam.ts（アダプターだけ）との差が、ジョブ管理・HTTP・結果の受け渡しにかかる時間。
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { JobRequest } from '../../src/core/engine-protocol';
import { decodeJobState } from '../../src/core/engine-wire';
import { aluminumBeamPreset } from '../adapters/calculix/test-projects';
import { loadAdapters } from '../server/adapters';
import { createEngineService } from '../server/service';

const TOKEN = 'bench-token-0123456789abcdef';
const ccx = process.env.STUDIO_M_CCX;
const workRoot = await mkdtemp(join(tmpdir(), 'studio-m-bench-'));
const service = createEngineService({
  adapters: loadAdapters(),
  token: TOKEN,
  port: 0,
  workRoot,
  commandPaths: ccx && isAbsolute(ccx) && existsSync(ccx) ? { ccx } : undefined,
});
const base = `http://127.0.0.1:${await service.listen()}`;
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
console.log(`環境: ${platform()} ${arch()}、CPU ${cpus().length} 個、ccx = ${ccx ?? 'PATH の ccx'}`);

try {
  for (const quality of ['standard', 'fine'] as const) {
    for (let round = 1; round <= 2; round++) {
      const body: JobRequest = { analysis: 'stress', engine: 'calculix', project: aluminumBeamPreset(), quality };
      const t0 = performance.now();
      const posted = (await (await fetch(`${base}/jobs`, { method: 'POST', headers, body: JSON.stringify(body) })).json()) as { id: string };
      const tPosted = performance.now();
      let polls = 0;
      let bytes = 0;
      let job;
      for (;;) {
        const text = await (await fetch(`${base}/jobs/${posted.id}`, { headers })).text();
        polls++;
        bytes = text.length;
        job = decodeJobState(JSON.parse(text));
        if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') break;
        await new Promise((r) => setTimeout(r, 300));
      }
      const tDone = performance.now();
      let fileSec = 0;
      for (const f of job.files ?? []) {
        const t = performance.now();
        await (await fetch(`${base}/jobs/${posted.id}/files/${encodeURIComponent(f.name)}`, { headers })).arrayBuffer();
        fileSec += (performance.now() - t) / 1000;
      }
      console.log(
        `${quality.padEnd(8)} ${round} 回目: ${job.status}、投げてから完了まで ${((tDone - t0) / 1000).toFixed(2)} 秒（受付 ${((tPosted - t0) / 1000).toFixed(2)} 秒、確認 ${polls} 回、最後の応答 ${(bytes / 1024).toFixed(0)} KB）、ファイル ${job.files?.length ?? 0} 個の取得 ${fileSec.toFixed(2)} 秒` +
          (job.status === 'failed' ? `、error: ${job.error}` : ''),
      );
    }
  }
} finally {
  await service.close();
  await rm(workRoot, { recursive: true, force: true });
}
