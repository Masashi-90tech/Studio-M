// localStorage への自動保存。使えない環境（プライベートモードなど）でも黙って動き続ける。
import type { AnalysisKind, Project } from '../core/types';
import { ANALYSES, sanitizeProject } from './project-utils';

const KEY = 'studio-m-lite:v1';

export interface SavedState {
  project: Project;
  analysis: AnalysisKind;
}

export function loadSaved(): SavedState | null {
  try {
    const text = localStorage.getItem(KEY);
    if (!text) return null;
    const raw = JSON.parse(text) as { project?: unknown; analysis?: unknown };
    const project = sanitizeProject(raw.project);
    if (!project) return null;
    const analysis = ANALYSES.includes(raw.analysis as AnalysisKind) ? (raw.analysis as AnalysisKind) : 'flow';
    return { project, analysis };
  } catch {
    return null;
  }
}

let timer: number | undefined;

/** 連続した変更をまとめて、少し待ってから保存する */
export function scheduleSave(get: () => SavedState, delayMs = 600): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(get()));
    } catch {
      // 保存できなくてもアプリは動かし続ける
    }
  }, delayMs);
}
