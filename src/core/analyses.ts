// 解析の種類（AnalysisKind）ごとの名前と並び順。DOM に触れない。
// 画面のタブ・Excel 出力・ワークベンチ（src/workbench）が同じ名前を使うよう、ここを唯一の出どころにする。
import type { AnalysisKind } from './types';

export interface AnalysisInfo {
  /** 画面とブックに出す名前 */
  label: string;
  /** タブなどの並び順（小さいほど先） */
  order: number;
}

export const ANALYSIS_INFO: Record<AnalysisKind, AnalysisInfo> = {
  flow: { label: '流れ', order: 10 },
  heat: { label: '熱', order: 20 },
  stress: { label: '強度', order: 30 },
  em: { label: '電磁波', order: 40 },
  scalar: { label: '対流拡散', order: 50 },
};

/** 並び順どおりの解析の種類 */
export const ANALYSIS_KINDS: readonly AnalysisKind[] = (Object.keys(ANALYSIS_INFO) as AnalysisKind[]).sort(
  (a, b) => ANALYSIS_INFO[a].order - ANALYSIS_INFO[b].order,
);

/** 最初に開く解析 */
export const DEFAULT_ANALYSIS: AnalysisKind = 'flow';

export function analysisLabel(kind: AnalysisKind): string {
  return ANALYSIS_INFO[kind].label;
}

export function isAnalysisKind(v: unknown): v is AnalysisKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ANALYSIS_INFO, v);
}
