// 本計算まわりの表示用の純粋関数（DOM に触れない）: 比較表、計算の細かさの名前、状態の文言など。
import type { AnalysisKind, ResultSet } from '../core/types';
import type { EngineCapability, EngineId, EngineInfo, EngineStatus, JobQuality, JobStatusKind } from '../core/engine-protocol';

export const QUALITY_CHOICES: { value: JobQuality; label: string; hint: string }[] = [
  { value: 'draft', label: '速さ優先', hint: '粗い格子で早く答えを出します' },
  { value: 'standard', label: 'ふつう', hint: '時間と精度のバランスをとります' },
  { value: 'fine', label: '精度優先', hint: '細かい格子でじっくり解きます。時間がかかります' },
];

export const JOB_STATUS_TEXT: Record<JobStatusKind, string> = {
  queued: '順番待ち',
  meshing: 'メッシュを作成中',
  running: '計算中',
  reading: '結果を読み込み中',
  done: '完了',
  failed: '失敗',
  cancelled: '中止',
};

/** その解析を解けるエンジンの能力（サーバーが返した capabilities から選ぶ。画面は解析の種類を知らなくてよい） */
export function capabilitiesFor(status: EngineStatus | null, analysis: AnalysisKind): EngineCapability[] {
  return (status?.capabilities ?? []).filter((c) => c.analysis === analysis);
}

export function engineInfo(status: EngineStatus | null, id: EngineId): EngineInfo | undefined {
  return status?.engines.find((e) => e.id === id);
}

/** 表示名（例: CalculiX）。情報がなければ id */
export function engineName(status: EngineStatus | null, id: EngineId): string {
  return engineInfo(status, id)?.name ?? id;
}

export interface CompareRow {
  key: string;
  label: string;
  unit: string;
  lite: number;
  remote: number;
  /** (本計算 − Lite) / |Lite| × 100。Lite が 0 に近いか、どちらかが数でないときは null */
  diffPct: number | null;
}

/** Lite と本計算に共通の代表値（key が同じもの）を、Lite の並び順で比べる */
export function compareScalars(lite: ResultSet | null, remote: ResultSet | null): CompareRow[] {
  if (!lite || !remote) return [];
  const rows: CompareRow[] = [];
  for (const s of lite.scalars) {
    const r = remote.scalars.find((x) => x.key === s.key);
    if (!r) continue;
    const ok = Number.isFinite(s.value) && Number.isFinite(r.value) && Math.abs(s.value) > 1e-30;
    rows.push({ key: s.key, label: s.label, unit: s.unit, lite: s.value, remote: r.value, diffPct: ok ? ((r.value - s.value) / Math.abs(s.value)) * 100 : null });
  }
  return rows;
}

/** 差の表示: +2.3 %、−0.4 %、— */
export function formatDiffPct(d: number | null): string {
  if (d === null || !Number.isFinite(d)) return '—';
  const a = Math.abs(d);
  const text = a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a.toFixed(2);
  if (Number(text) === 0) return '±0 %';
  return `${d > 0 ? '+' : '−'}${text} %`;
}

/** バイト数の表示（ファイルの大きさ） */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 本計算の結果が、今の形や条件のものか */
export function isCurrentRun(opts: { runRev: number; currentRev: number }): boolean {
  return opts.runRev === opts.currentRev;
}

export const STALE_MESSAGE = '形や条件が変わりました。もう一度本計算してください。';
