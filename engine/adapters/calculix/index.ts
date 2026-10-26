// CalculiX アダプター: Project（2D の板）を CalculiX のモデルにして解き、Lite と同じ ResultSet に戻す。
//
// - 強度（stress）: 2D 平面応力の線形弾性。オプションで塑性（完全弾塑性）・大変形（stress.ts）
// - 熱（heat）:     厚さ 1 要素の 3D の板で、定常熱伝導（表裏の放熱も入れる。heat.ts）
// 実行は必ず ctx.run を通す。ライセンス: CalculiX は GPL-2.0 なので、別プロセスとして呼ぶだけで組み込まない。

import type { EngineCapability, EngineInfo, JobRequest } from '../../../src/core/engine-protocol';
import type { AdapterContext, DetectContext, EngineAdapter, SolveOutput } from '../../types';
import { solveHeat } from './heat';
import { STRESS_OPTION_SPECS } from './options';
import { solveStress } from './stress';

export { explainFailure } from './ccx-run';

const capabilities: EngineCapability[] = [
  { analysis: 'stress', engine: 'calculix', label: 'CalculiX で本計算', options: STRESS_OPTION_SPECS },
  { analysis: 'heat', engine: 'calculix', label: 'CalculiX で本計算（定常熱伝導）' },
];

const INSTALL_NOTE =
  'CalculiX（ccx）が見つかりません。Ubuntu / Debian では `sudo apt install calculix-ccx` で入ります（Windows は WSL2 の Ubuntu の中で同じ手順）。' +
  'macOS や、Windows に直接入れる場合は、公式サイト（calculix.de）の案内に従って入れてください。' +
  'どの場合も `ccx` というコマンド名で呼べるようにしてください（`ccx_2.21` などの名前なら、ccx という名前でも呼べるようにします）。';

export const calculixAdapter: EngineAdapter = {
  id: 'calculix',
  // 信頼できる公開イメージを確信できないため、Docker 実行は未対応（native のみ）
  dockerImage: undefined,
  capabilities,

  async detect(ctx: DetectContext): Promise<EngineInfo> {
    const base = { id: 'calculix' as const, name: 'CalculiX', license: 'GPL-2.0' };
    let probe: { ok: boolean; output: string };
    try {
      probe = await ctx.probe('ccx', ['-v']);
    } catch {
      probe = { ok: false, output: '' };
    }
    // ccx -v は版を表示して 0 以外で終わることがあるので、出力の中身で判断する
    const m = /Version\s+([0-9][0-9.]*)/i.exec(probe.output);
    const available = m !== null || (probe.ok && /calculix/i.test(probe.output));
    if (available) return { ...base, available: true, version: m?.[1], via: 'native' };
    return { ...base, available: false, via: 'none', note: INSTALL_NOTE };
  },

  async solve(req: JobRequest, ctx: AdapterContext): Promise<SolveOutput> {
    if (req.analysis === 'stress') return solveStress(req, ctx);
    if (req.analysis === 'heat') return solveHeat(req, ctx);
    throw new Error(`CalculiX アダプターは ${req.analysis} の解析にはまだ対応していません。`);
  },
};

export default calculixAdapter;
