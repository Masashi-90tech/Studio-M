// KiCad 基板の取り込み（v0.4）の画面側の入口: ダイアログを開く、ドロップされたファイルから基板ファイルを選ぶ。
// 作図エリアへのドロップを受けるのは import-drop.ts（3D モデルと振り分ける）。
// src/pcb は使うときに遅延 import する（型だけは静的に読んでよい）。
import type { PcbImportResult } from '../pcb/import-dialog';
import { toast } from './dom';
import { importToasts, toastMsFor } from './import-toast';
import { withLoading } from './lazy';
import type { Store } from './state';

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

// 既存の import 元（テストなど）のために、共通の処理をここからも出しておく
export { MAX_IMPORT_TOASTS, importToasts, toastMsFor } from './import-toast';
