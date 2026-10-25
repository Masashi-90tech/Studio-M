// エンジンの検出。アダプターの detect() を probe つきで呼び、EngineStatus の engines / capabilities を作る。
import { tmpdir } from 'node:os';
import type { EngineCapability, EngineId, EngineInfo } from '../../src/core/engine-protocol';
import type { DetectContext, EngineAdapter } from '../types';
import { runCommand } from './exec';

const PROBE_TIMEOUT_MS = 10_000;
/** 画面に「まだ対応していません」と出すエンジン（アダプターがまだないもの） */
const PLANNED: { id: EngineId; name: string; license: string }[] = [
  { id: 'gmsh', name: 'gmsh', license: 'GPL-2.0-or-later' },
  { id: 'elmer', name: 'Elmer', license: 'GPL-2.0-or-later / LGPL' },
  { id: 'openems', name: 'openEMS', license: 'GPL-3.0-or-later' },
];

export type ProbeFn = (command: string, args: string[]) => Promise<{ ok: boolean; output: string }>;

/**
 * command が起動できれば ok: true（終了コードは見ない。ccx -v のように、版を出して 0 以外で終わるものがあるため）。
 * 見つからない・時間切れなら false。output は標準出力と標準エラーをつなげたもの。
 */
export const probeCommand: ProbeFn = async (command, args) => {
  try {
    const r = await runCommand({ command, args, workDir: tmpdir(), timeoutMs: PROBE_TIMEOUT_MS, backend: { kind: 'native' } });
    return { ok: true, output: `${r.stdout}\n${r.stderr}`.trim() };
  } catch {
    return { ok: false, output: '' };
  }
};

/** Docker のサーバーに届くか（docker version が成功するか） */
export async function detectDocker(run: typeof runCommand = runCommand): Promise<boolean> {
  try {
    const r = await run({ command: 'docker', args: ['version', '--format', '{{.Server.Version}}'], workDir: tmpdir(), timeoutMs: PROBE_TIMEOUT_MS, backend: { kind: 'native' } });
    return r.code === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function dockerImageExists(image: string, run: typeof runCommand): Promise<boolean> {
  try {
    const r = await run({ command: 'docker', args: ['image', 'inspect', '--format', '{{.Id}}', image], workDir: tmpdir(), timeoutMs: PROBE_TIMEOUT_MS, backend: { kind: 'native' } });
    return r.code === 0;
  } catch {
    return false;
  }
}

export interface Detection {
  engines: EngineInfo[];
  capabilities: EngineCapability[];
  dockerAvailable: boolean;
  /** アダプターごとの検出結果（実行の仕方を選ぶのに使う） */
  infoById: Map<EngineId, EngineInfo>;
}

export async function detectEngines(opts: { adapters: EngineAdapter[]; probe?: ProbeFn; run?: typeof runCommand }): Promise<Detection> {
  const probe = opts.probe ?? probeCommand;
  const run = opts.run ?? runCommand;
  const dockerAvailable = await detectDocker(run);
  const ctx: DetectContext = { probe, dockerAvailable };
  const infoById = new Map<EngineId, EngineInfo>();
  const engines: EngineInfo[] = [];
  const capabilities: EngineCapability[] = [];

  for (const adapter of opts.adapters) {
    let info: EngineInfo;
    try {
      info = await adapter.detect(ctx);
    } catch (e) {
      info = { id: adapter.id, name: adapter.id, available: false, via: 'none', license: '不明', note: `検出に失敗しました（${e instanceof Error ? e.message : String(e)}）` };
    }
    // 直接は見つからないが、Docker のイメージが手元にあれば Docker で動かせる
    if (!info.available && adapter.dockerImage && dockerAvailable && (await dockerImageExists(adapter.dockerImage, run))) {
      info = { ...info, available: true, via: 'docker', note: `Docker のイメージ（${adapter.dockerImage}）で動かします` };
    }
    infoById.set(adapter.id, info);
    engines.push(info);
    capabilities.push(...adapter.capabilities);
  }
  for (const p of PLANNED) {
    if (infoById.has(p.id)) continue;
    engines.push({ id: p.id, name: p.name, available: false, via: 'none', license: p.license, note: 'まだ対応していません（今後の版で対応予定）' });
  }
  return { engines, capabilities, dockerAvailable, infoById };
}
