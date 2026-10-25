// KiCad 基板の取り込み（v0.4）の画面側の入口: ダイアログを開く、画面へのドロップを受ける、注意書きを知らせる。
// src/pcb は使うときに遅延 import する（型だけは静的に読んでよい）。
import type { PcbImportResult } from '../pcb/import-dialog';
import { toast } from './dom';
import { withLoading } from './lazy';
import type { Store } from './state';

/** 取り込みで出す toast の最大数（「ほか N 件」を含む） */
export const MAX_IMPORT_TOASTS = 3;

/** 注意書き → toast に出す文。多いときは先頭を残して、最後を「ほか N 件」にまとめる */
export function importToasts(warnings: string[], max: number = MAX_IMPORT_TOASTS): string[] {
  const list = warnings.map((w) => w.trim()).filter((w) => w !== '');
  if (list.length <= max) return list;
  const shown = list.slice(0, Math.max(0, max - 1));
  return [...shown, `ほか ${list.length - shown.length} 件の注意があります（取り込む前の画面の注意書きと同じ内容です）`];
}

/** 文の長さに合わせて toast を出しておく時間 [ms]（読み切れる長さにする） */
export function toastMsFor(text: string): number {
  return Math.min(10000, 3500 + text.length * 60);
}

/** ドロップされたファイルから KiCad の基板ファイル（.kicad_pcb）を選ぶ */
export function pickKicadFile<T extends { name: string }>(files: readonly T[]): T | undefined {
  return files.find((f) => /\.kicad_pcb$/i.test(f.name));
}

let opening = false;

/** 取り込みダイアログを開く。file があれば最初から読み込む */
export async function openKicadImport(opts: { store: Store; file?: File }): Promise<void> {
  // 読み込み中・すでに開いているときに二重に開かない
  if (opening || document.querySelector('.pcb-backdrop')) return;
  opening = true;
  try {
    const mod = await withLoading({ label: 'KiCad 基板の取り込み', task: import('../pcb/import-dialog') });
    if (!mod) return;
    mod.openPcbImport({
      file: opts.file,
      onImport: ({ project, analysis, warnings }: PcbImportResult) => {
        opts.store.loadProject(project, analysis); // 「開く」と同じく、元に戻すで前の内容に戻せる
        for (const text of importToasts(warnings)) toast(text, 'info', { ms: toastMsFor(text) });
      },
    });
  } finally {
    opening = false;
  }
}

/** 作図エリアに .kicad_pcb をドロップしたら、取り込みダイアログをそのファイルで開く */
export function initKicadDrop(opts: { target: HTMLElement; store: Store }): void {
  const { target, store } = opts;
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  target.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    target.classList.add('drop-ready');
  });
  target.addEventListener('dragleave', (e) => {
    if (!target.contains(e.relatedTarget as Node | null)) target.classList.remove('drop-ready');
  });
  target.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    target.classList.remove('drop-ready');
    const files = Array.from(e.dataTransfer?.files ?? []);
    const file = pickKicadFile(files);
    if (file) void openKicadImport({ store, file });
    else if (files.length > 0) toast('ここに置けるのは KiCad の基板ファイル（.kicad_pcb）です。プロジェクトファイルは「ファイル」→「開く」から開いてください', 'error');
  });
}
