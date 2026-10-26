// gmsh アダプター: 形に沿った 2D メッシュを作る道具。単独の解析は持たない（capabilities は空）。
//
// CalculiX の強度解析が、オプション「メッシュ」で gmsh を選んだときに、このフォルダの mesh2d.ts の
// generateShapedMesh を呼んで使う。ここは「gmsh が PC に入っているか」を検出して画面に見せる役。
// ライセンス: gmsh は GPL-2.0-or-later なので、別プロセスとして呼ぶだけで組み込まない（docs/oss-ledger.json）。

import type { EngineInfo, JobRequest } from '../../../src/core/engine-protocol';
import type { AdapterContext, DetectContext, EngineAdapter, SolveOutput } from '../../types';
import { GMSH_INSTALL_NOTE } from './mesh2d';

export { generateShapedMesh, GMSH_INSTALL_NOTE } from './mesh2d';

export const gmshAdapter: EngineAdapter = {
  id: 'gmsh',
  dockerImage: undefined,
  // メッシュを作る道具で、単独では何も解かない
  capabilities: [],

  async detect(ctx: DetectContext): Promise<EngineInfo> {
    const base = { id: 'gmsh' as const, name: 'gmsh', license: 'GPL-2.0-or-later' };
    let probe: { ok: boolean; output: string };
    try {
      probe = await ctx.probe('gmsh', ['--version']);
    } catch {
      probe = { ok: false, output: '' };
    }
    // `gmsh --version` は「4.15.2」のように版だけを出す
    const m = /(?:^|\s)(\d+\.\d+(?:\.\d+)?)(?:\s|$)/.exec(probe.output);
    if (probe.ok && m) {
      return { ...base, available: true, version: m[1], via: 'native', note: 'CalculiX の強度解析で、形に沿ったメッシュ（オプション「メッシュ」）に使います' };
    }
    return { ...base, available: false, via: 'none', note: GMSH_INSTALL_NOTE };
  },

  async solve(_req: JobRequest, _ctx: AdapterContext): Promise<SolveOutput> {
    throw new Error('gmsh は単独では解析しません。CalculiX の強度解析のオプション「メッシュ」で「形に沿ったメッシュ（gmsh）」を選ぶと、メッシュ作りに使われます。');
  },
};
