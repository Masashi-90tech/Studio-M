// Studio M Engine の OpenFOAM アダプター（流れ解析 'flow' の本計算）。
//
// Studio M の格子（ラスター）から 1 セル厚の擬似 2D メッシュを blockMesh で作り、物体のセルを
// subsetMesh で抜いて階段状の障害物にする。非圧縮流れを pimpleFoam（層流・LES）または
// simpleFoam（RANS）で解き、速度・圧力・力を Lite と同じ ResultSet に戻す。
//
// 辞書の書き方は Debian/Ubuntu の openfoam（v1912）と Docker の opencfd/openfoam-default:2406 の
// 両方で読める範囲に限る（dicts.ts の冒頭を参照）。

import type { EngineCapability, EngineInfo, JobRequest } from '../../../src/core/engine-protocol';
import type { AdapterContext, DetectContext, EngineAdapter, SolveOutput } from '../../types';
import { solveFlow } from './run';

const CAPABILITIES: EngineCapability[] = [
  {
    analysis: 'flow',
    engine: 'openfoam',
    label: 'OpenFOAM で本計算',
    options: [
      {
        key: 'model',
        label: '流れのモデル',
        kind: 'select',
        default: 'auto',
        choices: [
          { value: 'auto', label: '自動（Re で選ぶ）' },
          { value: 'laminar', label: '層流（Re 1000 未満向け）' },
          { value: 'les', label: 'LES（Smagorinsky。2D では定性的）' },
          { value: 'rans', label: 'RANS（定常・k-ω SST。高 Re 向け）' },
        ],
        hint: '自動のときは Re < 1000 で層流、2 万未満で LES、それ以上で RANS',
      },
      {
        key: 'flowThroughs',
        label: '流れが領域を通り抜ける回数',
        kind: 'number',
        default: 4,
        hint: '層流・LES の計算時間 = 回数 × 領域の幅 / 流入速度。渦放出を見るなら 8 以上。RANS では反復回数の目安（回数 × nx × 1.5）',
      },
      {
        key: 'turbulenceIntensity',
        label: '流入の乱流強度',
        kind: 'number',
        default: 1,
        unit: '%',
        hint: 'RANS の流入の乱れ（1〜5% が目安）。層流・LES では使いません',
      },
    ],
  },
];

/** `blockMesh -help` などの出力から版を取り出す（例: "Using: OpenFOAM- (1912) …" → "v1912"、"OpenFOAM-v2406" → "v2406"） */
export function parseOpenFoamVersion(output: string): string | undefined {
  const m = /OpenFOAM-?\s*\(?(v?\d{4})\)?/.exec(output) ?? /OPENFOAM=(\d{4})/.exec(output);
  if (!m) return undefined;
  return m[1].startsWith('v') ? m[1] : `v${m[1]}`;
}

const INSTALL_NOTE =
  'OpenFOAM（openfoam.com 版）が見つかりません。入れ方: Docker があれば opencfd/openfoam-default イメージを使えます（推奨。Windows は WSL2 上の Docker、macOS は Docker Desktop）。' +
  'Ubuntu なら openfoam.com の apt リポジトリのパッケージ、または `apt install openfoam`（版が古く v1912）でも動きます。' +
  'Debian/Ubuntu のパッケージでは環境変数 WM_PROJECT_DIR=/usr/share/openfoam が必要な場合があります。';

export const openfoamAdapter: EngineAdapter = {
  id: 'openfoam',
  // 辞書の書き方は v1912（Debian/Ubuntu の apt）と v2406（このイメージ）の両方で読めるものに保つこと
  dockerImage: 'opencfd/openfoam-default:2406',
  capabilities: CAPABILITIES,

  async detect(ctx: DetectContext): Promise<EngineInfo> {
    const base = { id: 'openfoam' as const, name: 'OpenFOAM', license: 'GPL-3.0' };
    const probe = await ctx.probe('blockMesh', ['-help']);
    const version = parseOpenFoamVersion(probe.output);
    if (probe.ok && version) return { ...base, available: true, version, via: 'native' };
    if (!probe.ok && /Could not find mandatory etc entry|did not locate installation path/.test(probe.output)) {
      // コマンドはあるが環境が読み込まれていない
      return {
        ...base,
        available: false,
        via: ctx.dockerAvailable ? 'docker' : 'none',
        note: 'OpenFOAM は入っていますが環境が読み込まれていません。OpenFOAM の bashrc を読み込んだ状態でエンジンを起動するか、WM_PROJECT_DIR=/usr/share/openfoam を設定してください。',
      };
    }
    if (ctx.dockerAvailable) {
      return {
        ...base,
        available: true,
        via: 'docker',
        note: 'Docker のイメージ opencfd/openfoam-default:2406 で動かします（初回はイメージの取得に時間がかかります）。',
      };
    }
    return { ...base, available: false, via: 'none', note: INSTALL_NOTE };
  },

  async solve(req: JobRequest, ctx: AdapterContext): Promise<SolveOutput> {
    if (req.analysis !== 'flow') throw new Error(`OpenFOAM アダプターは流れ解析（flow）だけに対応しています（${req.analysis}）。`);
    return solveFlow(req, ctx);
  },
};
