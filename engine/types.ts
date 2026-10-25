// エンジンの中で、解析ソフトごとの「変換役（アダプター）」が守る約束。
// アダプターは Project を解析ソフトの入力ファイルに変え、実行し、結果を ResultSet に戻す。
// 実行は必ず ctx.run を通す（PC に直接入っていても Docker でも、同じ書き方で動くようにするため）。

import type { EngineCapability, EngineId, EngineInfo, JobRequest } from '../src/core/engine-protocol';
import type { ResultSet } from '../src/core/types';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** 作業フォルダからの相対パス（省略時は作業フォルダ） */
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** 1 行ずつ受け取る（進み具合の読み取りに使う） */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface AdapterContext {
  /** この計算専用の作業フォルダ（絶対パス）。ファイルはここにだけ書く */
  workDir: string;
  signal: AbortSignal;
  log(line: string): void;
  /** 0〜1 と、今していること（日本語） */
  progress(fraction: number, message: string, status?: 'meshing' | 'running' | 'reading'): void;
  /**
   * 解析ソフトを実行する。command は 'ccx' や 'blockMesh' のような名前だけを渡す
   * （シェルを通さない。引数は配列で渡す）。Docker で動かす場合も同じ呼び方でよい
   */
  run(command: string, args: string[], opts?: RunOptions): Promise<RunResult>;
}

export interface DetectContext {
  /** command が使えるかを確かめ、使えれば版の文字列を返す */
  probe(command: string, args: string[]): Promise<{ ok: boolean; output: string }>;
  dockerAvailable: boolean;
}

export interface SolveOutput {
  result: ResultSet;
  /** 作業フォルダ内で、利用者に渡すファイル（入力・ParaView 用の結果など） */
  files: { name: string; description: string }[];
}

export interface EngineAdapter {
  id: EngineId;
  /** Docker で動かすときのイメージ（例: 'opencfd/openfoam-default:2406'）。なければ Docker 不可 */
  dockerImage?: string;
  capabilities: EngineCapability[];
  detect(ctx: DetectContext): Promise<EngineInfo>;
  solve(req: JobRequest, ctx: AdapterContext): Promise<SolveOutput>;
}
