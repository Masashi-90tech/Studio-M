// 3D モデル（STL・OBJ）の取り込み（v0.6）の画面側の入口: ダイアログを開く、ドロップされたファイルから 3D モデルを選ぶ。
// src/mesh3d は使うときに遅延 import する（型だけは静的に読んでよい）。
import type { MeshImportResult } from '../mesh3d/import-dialog';
import { toast } from './dom';
import { importToasts, toastMsFor } from './import-toast';
import { withLoading } from './lazy';
import type { Store } from './state';

/** ドロップされたファイルから 3D モデル（.stl / .obj）を選ぶ */
export function pickMeshFile<T extends { name: string }>(files: readonly T[]): T | undefined {
  return files.find((f) => /\.(stl|obj)$/i.test(f.name));
}

let opening = false;

/** 取り込みダイアログを開く。file があれば最初から読み込む */
export async function openMeshImport(opts: { store: Store; file?: File }): Promise<void> {
  // 読み込み中・すでに開いているときに二重に開かない
  if (opening || document.querySelector('.m3d-backdrop')) return;
  opening = true;
  try {
    const mod = await withLoading({ label: '3D モデルの取り込み', task: import('../mesh3d/import-dialog') });
    if (!mod) return;
    mod.openMeshImport({
      file: opts.file,
      onImport: ({ project, analysis, warnings }: MeshImportResult) => {
        opts.store.loadProject(project, analysis); // 「開く」と同じく、元に戻すで前の内容に戻せる
        for (const text of importToasts(warnings)) toast(text, 'info', { ms: toastMsFor(text) });
      },
    });
  } finally {
    opening = false;
  }
}
