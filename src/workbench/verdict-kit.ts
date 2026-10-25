// 判定の共通部品。DOM に触れない。各解析の判定（verdicts/）が使う。
import { getMaterial } from '../core/materials';
import type { Material, ResultSet, SolverStatus } from '../core/types';
import type { Verdict, VerdictAction, VerdictLevel } from './types';

/** チップに出す短い文字 */
export const CHIP_TEXT: Record<VerdictLevel, string> = { ok: 'OK', warn: '注意', ng: 'NG', info: '目安', pending: '計算中' };

/** 判定を組み立てる */
export const makeVerdict = (level: VerdictLevel, headline: string, lines: string[] = [], actions: VerdictAction[] = []): Verdict => ({
  level,
  chip: CHIP_TEXT[level],
  headline,
  lines,
  actions,
});

/** 結果のスカラー値を key で引く（有限の数だけ） */
export function scalarOf(r: ResultSet | null, key: string): number | undefined {
  const s = r?.scalars.find((x) => x.key === key);
  return s && Number.isFinite(s.value) ? s.value : undefined;
}

/** 収束した、または進捗が 100% に届いたか */
export function isFinished(status: SolverStatus | null): boolean {
  return !!status && (status.done || status.progress >= 1);
}

/** 「計算中…」の判定（進み具合つき） */
export function waitingVerdict(status: SolverStatus | null): Verdict {
  const pct = status ? Math.round(Math.min(1, Math.max(0, status.progress)) * 100) : 0;
  return makeVerdict('pending', '計算中…', [pct > 0 ? `進み具合 約 ${pct}%` : 'しばらくお待ちください。']);
}

/** 材料を探す（なければ undefined） */
export function tryMaterial(id: string): Material | undefined {
  try {
    return getMaterial(id);
  } catch {
    return undefined;
  }
}
