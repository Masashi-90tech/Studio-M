// 表示モード（かんたん / 標準 / プロ）と、閲覧者ごとの表示設定の保存。
// モードは「何を見せるか」だけを変える。Project のデータはどのモードでも同じ。
import type { Project } from '../core/types';

export type UiMode = 'easy' | 'standard' | 'pro';

export const MODES: UiMode[] = ['easy', 'standard', 'pro'];

export const MODE_LABELS: Record<UiMode, string> = {
  easy: 'かんたん',
  standard: '標準',
  pro: 'プロ',
};

export const MODE_HINTS: Record<UiMode, string> = {
  easy: '質問に答えるだけ。結果は「大丈夫？」から先に見せます',
  standard: '物理量を単位つきで設定します',
  pro: '計算の細かい設定・プローブ・断面グラフ・生データ出力まで使えます',
};

/** かんたんモードの質問の答えなど、閲覧者ごとの表示設定（プロジェクトには保存しない） */
export interface Prefs {
  /** 強度: 目標とする安全率 */
  safetyTarget: number;
  /** 強度: 何を知りたいか */
  stressGoal: 'safe' | 'bend';
  /** 電磁波: 何を知りたいか */
  emGoal: 'cover' | 'reflect';
}

export const DEFAULT_PREFS: Prefs = { safetyTarget: 2, stressGoal: 'safe', emGoal: 'cover' };

export const SAFETY_CHOICES: { value: number; label: string; hint: string }[] = [
  { value: 1.5, label: '1.5', hint: 'ぎりぎり（試作・軽い荷重）' },
  { value: 2, label: '2', hint: 'ふつう（日用品）' },
  { value: 3, label: '3', hint: '安心（人が乗る・衝撃がある）' },
];

const KEY = 'studio-m-lite:ui:v1';

export interface UiState {
  mode?: UiMode;
  prefs: Prefs;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 保存された文字列を読む（壊れていれば既定値） */
export function parseUiState(text: string | null): UiState {
  const out: UiState = { prefs: { ...DEFAULT_PREFS } };
  if (!text) return out;
  try {
    const raw: unknown = JSON.parse(text);
    if (!isObj(raw)) return out;
    if (MODES.includes(raw.mode as UiMode)) out.mode = raw.mode as UiMode;
    if (isObj(raw.prefs)) {
      const p = raw.prefs;
      if (typeof p.safetyTarget === 'number' && Number.isFinite(p.safetyTarget) && p.safetyTarget >= 1 && p.safetyTarget <= 10) out.prefs.safetyTarget = p.safetyTarget;
      if (p.stressGoal === 'safe' || p.stressGoal === 'bend') out.prefs.stressGoal = p.stressGoal;
      if (p.emGoal === 'cover' || p.emGoal === 'reflect') out.prefs.emGoal = p.emGoal;
    }
  } catch {
    // 壊れた保存データは無視する
  }
  return out;
}

export function loadUiState(): UiState {
  try {
    return parseUiState(localStorage.getItem(KEY));
  } catch {
    return parseUiState(null);
  }
}

export function saveUiState(mode: UiMode, prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ mode, prefs }));
  } catch {
    // 保存できなくても動き続ける
  }
}

/** 初めての人は「かんたん」、保存済みのプロジェクトがある人は「標準」から始める */
export function initialMode(saved: UiMode | undefined, hasSavedProject: boolean): UiMode {
  return saved ?? (hasSavedProject ? 'standard' : 'easy');
}

/** プロ用の詳細設定が使われているか（advanced のどれかが設定済み、または格子を手動にしている） */
export function hasProSettings(p: Project): boolean {
  if (p.domain.autoGrid === false) return true;
  for (const k of ['flow', 'heat', 'stress', 'scalar', 'em'] as const) {
    const adv = (p[k] as { advanced?: Record<string, unknown> } | undefined)?.advanced;
    if (adv && Object.values(adv).some((v) => v !== undefined)) return true;
  }
  return false;
}
