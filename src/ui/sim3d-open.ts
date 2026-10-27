// 3D 解析の画面（src/sim3d）の画面側の入口。使うときに遅延 import する（型だけは静的に読んでよい）。
// 3D モデルの取り込みダイアログ（mesh-open.ts）が、「3D のまま解析する」で呼ぶ。
import type { Study3D } from '../core/types';
import { withLoading } from './lazy';
import type { Runner } from './runner';

let opening = false;

/**
 * 3D 解析の画面を開く。すでに開いているときは何もしない。
 * runner（2D の計算）を渡すと、3D の画面を開いているあいだは 2D の計算を止め、閉じたら元に戻す
 * （3D の計算は重いので、裏で 2D が動いていると計算時間を取り合って遅くなる）
 */
export async function openSim3D(opts: { study: Study3D; warnings?: string[]; runner?: Pick<Runner, 'running' | 'setRunning'> }): Promise<void> {
  if (opening || document.querySelector('.s3d-root')) return;
  opening = true;
  try {
    const mod = await withLoading({ label: '3D 解析の画面', task: import('../sim3d/screen') });
    if (!mod) return;
    const runner = opts.runner;
    const wasRunning = runner?.running ?? false;
    runner?.setRunning(false);
    mod.openSim3D({ study: opts.study, warnings: opts.warnings, onClose: () => runner?.setRunning(wasRunning) });
  } finally {
    opening = false;
  }
}
