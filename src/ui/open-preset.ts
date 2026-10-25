// プリセットを開く唯一の入口。「プリセット」メニューも、学ぶドロワーの「このプリセットを開く」も、ここを通る。
// 元に戻せる読み込み（Store.loadPreset）で、そのプリセットの解析タブに切り替わり、計算結果もやり直しになる。
import { toast } from './dom';
import { PRESETS, type Preset } from './presets';
import type { Store } from './state';

/** プリセットを開く。見つからなければ何もせず null */
export function openPreset(opts: { store: Store; presetId: string; notify?: boolean }): Preset | null {
  const p = PRESETS.find((x) => x.id === opts.presetId);
  if (!p) return null;
  opts.store.loadPreset({ project: p.build(), analysis: p.analysis, presetId: p.id });
  if (opts.notify !== false) toast(`プリセット「${p.title}」を開きました`);
  return p;
}
