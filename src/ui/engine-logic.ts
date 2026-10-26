// 本計算まわりの表示用の純粋関数（DOM に触れない）: 比較表、計算の細かさの名前、状態の文言、所要時間の目安など。
import { ANALYSIS_KINDS } from '../core/analyses';
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

/** 本計算 1 回分の実績（所要時間の目安に使う。閲覧者ごとに保存する） */
export interface EngineRunRecord {
  analysis: AnalysisKind;
  engine: EngineId;
  /** 画面の格子のセル数（Raster の nx × ny）。細かさの倍率はかけていない */
  cells: number;
  quality: JobQuality;
  /** 実際にかかった秒数 */
  seconds: number;
  /** 記録した時刻（ミリ秒） */
  at: number;
}

/** 同じ解析・エンジンで残す実績の数（新しい順） */
export const ENGINE_RUN_KEEP = 10;

/**
 * 細かさごとの計算量の倍率（セル数の倍率）。エンジン側は格子の一辺を standard で 1.5 倍、fine で 2 倍にするので、
 * セル数はその 2 乗になる。
 */
export const QUALITY_CELL_FACTOR: Record<JobQuality, number> = { draft: 1, standard: 1.5 * 1.5, fine: 2 * 2 };

/** 実績が実害なく使えるか（保存された値の検査にも使う） */
export function isEngineRunRecord(x: unknown): x is EngineRunRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    ANALYSIS_KINDS.includes(r.analysis as AnalysisKind) &&
    typeof r.engine === 'string' &&
    typeof r.cells === 'number' &&
    Number.isFinite(r.cells) &&
    r.cells > 0 &&
    typeof r.seconds === 'number' &&
    Number.isFinite(r.seconds) &&
    r.seconds > 0 &&
    typeof r.quality === 'string' &&
    Object.keys(QUALITY_CELL_FACTOR).includes(r.quality as string) &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at)
  );
}

/** 実績がないときの既定の目安（1 万セルあたりの秒数と最低の秒数）。ここにないエンジンは目安を出さない */
const ENGINE_DEFAULT_RATE: Partial<Record<EngineId, { per10kCells: number; minSeconds: number }>> = {
  calculix: { per10kCells: 1, minSeconds: 2 },
  openfoam: { per10kCells: 30, minSeconds: 20 },
};

/** 実績から換算するときの指数（秒 ∝ セル数^1.2） */
const HISTORY_EXPONENT = 1.2;

/**
 * 本計算の所要時間の目安。
 * - 同じ解析・エンジンの実績があれば、セル数がいちばん近い実績から換算する（basis: 'history'）
 * - なければ既定の目安（basis: 'default'）。細かさの倍率は既定の目安にだけ秒数へかける
 * cells は画面の格子のセル数（nx × ny）。目安を出せないとき（セル数が不正、既定もない）は null
 */
export function estimateEngineSeconds(opts: { analysis: AnalysisKind; engine: EngineId; cells: number; quality?: JobQuality; history?: EngineRunRecord[] }): { seconds: number; basis: 'history' | 'default' } | null {
  if (!Number.isFinite(opts.cells) || opts.cells <= 0) return null;
  const quality = opts.quality ?? 'standard';
  const factor = QUALITY_CELL_FACTOR[quality];
  const cells = opts.cells * factor;

  const past = (opts.history ?? []).filter((r) => isEngineRunRecord(r) && r.analysis === opts.analysis && r.engine === opts.engine);
  if (past.length > 0) {
    const effective = (r: EngineRunRecord): number => r.cells * QUALITY_CELL_FACTOR[r.quality];
    let nearest = past[0];
    for (const r of past) {
      if (Math.abs(Math.log(effective(r)) - Math.log(cells)) < Math.abs(Math.log(effective(nearest)) - Math.log(cells))) nearest = r;
    }
    return { seconds: nearest.seconds * Math.pow(cells / effective(nearest), HISTORY_EXPONENT), basis: 'history' };
  }

  const rate = ENGINE_DEFAULT_RATE[opts.engine];
  if (!rate) return null;
  const base = Math.max(rate.minSeconds, (opts.cells / 10000) * rate.per10kCells);
  return { seconds: base * factor, basis: 'default' };
}

/** 所要時間の目安の表示: 「約 5 秒」「約 2 分」「約 1 時間 10 分」（細かく丸める） */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `約 ${s} 秒`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `約 ${minutes} 分`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `約 ${h} 時間` : `約 ${h} 時間 ${m} 分`;
}

/** 経過時間の表示: 「0:42」「12:05」「1:02:03」 */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 新しい実績を先頭に足し、同じ解析・エンジンの分は ENGINE_RUN_KEEP 件までに切り詰めた新しい配列を返す */
export function recordEngineRun(list: EngineRunRecord[], rec: EngineRunRecord): EngineRunRecord[] {
  const counts = new Map<string, number>();
  return [rec, ...list].filter((r) => {
    const key = `${r.analysis}:${r.engine}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n <= ENGINE_RUN_KEEP;
  });
}
