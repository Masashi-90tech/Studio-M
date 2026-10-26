// 3D 解析の画面（src/sim3d）の画面側の入口。使うときに遅延 import する（型だけは静的に読んでよい）。
// 3D モデルの取り込みダイアログ（mesh-open.ts）が、「3D のまま解析する」で呼ぶ。
import type { Study3D } from '../core/types';
import { withLoading } from './lazy';

let opening = false;

/** 3D 解析の画面を開く。すでに開いているときは何もしない */
export async function openSim3D(opts: { study: Study3D; warnings?: string[] }): Promise<void> {
  if (opening || document.querySelector('.s3d-root')) return;
  opening = true;
  try {
    const mod = await withLoading({ label: '3D 解析の画面', task: import('../sim3d/screen') });
    mod?.openSim3D({ study: opts.study, warnings: opts.warnings });
  } finally {
    opening = false;
  }
}
