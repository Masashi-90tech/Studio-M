// 「片持ち梁（アルミ）」プリセットと同じ形を、計算の細かさごとに CalculiX で解いて、時間とたわみを表示する測定道具。
//   npx vite-node engine/tools/bench-beam.ts
// 環境変数: STUDIO_M_CCX（使う ccx の絶対パス。省略すると PATH の ccx）、STUDIO_M_CCX_THREADS（スレッド数）。
// 目的: PC ごとの計算時間のばらつき（例: Apple Silicon でスレッド数が多すぎて遅い）の原因を調べる。
import { arch, cpus, platform } from 'node:os';
import { solveStress } from '../adapters/calculix/stress';
import { createTestContext } from '../adapters/calculix/test-context';
import { aluminumBeamPreset } from '../adapters/calculix/test-projects';
import { ccxThreads } from '../adapters/calculix/ccx-run';

const ccx = process.env.STUDIO_M_CCX || 'ccx';
const THEORY_MM = 4.644; // 梁理論 PL³/3EI（アルミ A6061、200 mm、10 × 10 mm、100 N）

console.log(`環境: ${platform()} ${arch()}、CPU ${cpus().length} 個、ccx = ${ccx}、スレッド数 = ${ccxThreads()}`);
for (const quality of ['draft', 'standard', 'fine'] as const) {
  for (let round = 1; round <= 2; round++) {
    const ctx = await createTestContext();
    let ccxSec = 0;
    const run = ctx.run;
    ctx.run = async (cmd, args, o) => {
      const t = performance.now();
      const r = await run(cmd === 'ccx' ? ccx : cmd, args, o);
      if (cmd === 'ccx') ccxSec += (performance.now() - t) / 1000;
      return r;
    };
    const t0 = performance.now();
    try {
      const out = await solveStress({ analysis: 'stress', project: aluminumBeamPreset(), quality } as never, ctx);
      const sc = Object.fromEntries(out.result.scalars.map((x) => [x.key, x.value]));
      const disp = (sc.maxDisplacement ?? NaN) * 1000;
      console.log(
        `${quality.padEnd(8)} ${round} 回目: 全体 ${((performance.now() - t0) / 1000).toFixed(2)} 秒（ccx ${ccxSec.toFixed(2)} 秒）、たわみ ${disp.toFixed(3)} mm（理論との差 ${(((disp - THEORY_MM) / THEORY_MM) * 100).toFixed(1)}%）`,
      );
    } catch (e) {
      console.log(`${quality} ${round} 回目: 失敗 — ${(e as Error).message}`);
    } finally {
      await ctx.cleanup();
    }
  }
}
