// 作図エリアへのファイルのドロップ: 拡張子で、KiCad 基板（.kicad_pcb）と 3D モデル（.stl・.obj）に振り分けて取り込みダイアログを開く。
import { toast } from './dom';
import { openMeshImport, pickMeshFile } from './mesh-open';
import { openKicadImport, pickKicadFile } from './pcb-open';
import type { Runner } from './runner';
import type { Store } from './state';

/** ドロップされたファイルから、取り込める最初のファイルとその種類を選ぶ（KiCad 基板を優先） */
export function pickImportFile<T extends { name: string }>(files: readonly T[]): { kind: 'kicad' | 'mesh'; file: T } | undefined {
  const kicad = pickKicadFile(files);
  if (kicad) return { kind: 'kicad', file: kicad };
  const mesh = pickMeshFile(files);
  if (mesh) return { kind: 'mesh', file: mesh };
  return undefined;
}

/** 取り込めないファイルをドロップされたときの案内 */
export const DROP_ERROR_MESSAGE =
  'ここに置けるのは、KiCad の基板ファイル（.kicad_pcb）か、3D モデル（.stl・.obj）です。プロジェクトファイルは「ファイル」→「開く」から開いてください';

/** 作図エリアに .kicad_pcb / .stl / .obj をドロップしたら、対応する取り込みダイアログをそのファイルで開く */
export function initImportDrop(opts: { target: HTMLElement; store: Store; runner?: Runner }): void {
  const { target, store, runner } = opts;
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
    const pick = pickImportFile(files);
    if (pick?.kind === 'kicad') void openKicadImport({ store, file: pick.file });
    else if (pick?.kind === 'mesh') void openMeshImport({ store, file: pick.file, runner });
    else if (files.length > 0) toast(DROP_ERROR_MESSAGE, 'error');
  });
}
