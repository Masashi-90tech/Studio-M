// Studio M と「PC 上の計算エンジン（Studio M Engine）」のあいだのやり取りの型。
// 画面（ブラウザ）とエンジン（Node.js の別プロセス）の両方がこのファイルだけを共有する。
//
// 通信: http://127.0.0.1:<port>（既定 47800）に JSON で問い合わせる。
//   GET  /status                 → EngineStatus
//   POST /jobs                   JobRequest → { id }
//   GET  /jobs/:id               → JobState（終わっていれば result 付き）
//   POST /jobs/:id/cancel        → JobState
//   GET  /jobs/:id/files/:name   → 計算に使った入力・出力ファイル（ParaView などで開く用）
// すべての要求に、エンジン起動時に表示される合言葉を `Authorization: Bearer <token>` で付ける。

import type { AnalysisKind, Project, ResultSet } from './types';

export const ENGINE_DEFAULT_PORT = 47800;
export const ENGINE_PROTOCOL_VERSION = 1;

/** 外部の解析ソフト。GPL のものは別プロセスとして呼ぶだけで、Studio M には組み込まない */
export type EngineId = 'calculix' | 'openfoam' | 'gmsh' | 'elmer' | 'openems';

export interface EngineInfo {
  id: EngineId;
  /** 表示名（例: CalculiX） */
  name: string;
  available: boolean;
  /** 見つかった版（分かれば） */
  version?: string;
  /** native = PC に直接入っている、docker = Docker のイメージで動かす */
  via: 'native' | 'docker' | 'none';
  license: string;
  /** 見つからないときの入れ方など、利用者向けの一言 */
  note?: string;
}

/** どの解析をどのエンジンで解けるか */
export interface EngineCapability {
  analysis: AnalysisKind;
  engine: EngineId;
  /** 画面に出す名前（例: 「CalculiX で本計算（塑性あり）」） */
  label: string;
  /** そのエンジンで選べるオプションの説明（プロモード用） */
  options?: EngineOptionSpec[];
}

export interface EngineOptionSpec {
  key: string;
  label: string;
  kind: 'number' | 'select' | 'boolean';
  default: number | string | boolean;
  choices?: { value: string; label: string }[];
  unit?: string;
  hint?: string;
}

export interface EngineStatus {
  server: 'studio-m-engine';
  protocol: number;
  version: string;
  engines: EngineInfo[];
  capabilities: EngineCapability[];
  /** 同時に走らせる計算の数の上限 */
  maxConcurrentJobs: number;
}

/** 計算の細かさ。draft = 速さ優先、fine = 精度優先 */
export type JobQuality = 'draft' | 'standard' | 'fine';

export interface JobRequest {
  analysis: AnalysisKind;
  engine: EngineId;
  project: Project;
  quality?: JobQuality;
  /** EngineCapability.options の key → 値 */
  options?: Record<string, number | string | boolean>;
}

export type JobStatusKind = 'queued' | 'meshing' | 'running' | 'reading' | 'done' | 'failed' | 'cancelled';

export interface JobFile {
  name: string;
  size: number;
  /** 何のファイルか（例: 「CalculiX の入力」「ParaView 用の結果」） */
  description: string;
}

export interface JobState {
  id: string;
  analysis: AnalysisKind;
  engine: EngineId;
  status: JobStatusKind;
  /** 0〜1 */
  progress: number;
  /** 今していること（日本語） */
  message: string;
  /** ソルバーの出力の末尾（最大 200 行程度） */
  log: string[];
  startedAt: number;
  finishedAt?: number;
  /**
   * 結果。Lite と同じ ResultSet（格子は project から作った Raster と同じ nx × ny）。
   * 画面は Lite の結果と並べて比べられる
   */
  result?: ResultSet;
  files?: JobFile[];
  /** 失敗したときの、利用者向けの説明（何が起きて、どうすれば直るか） */
  error?: string;
}
