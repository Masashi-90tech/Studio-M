// プロモード専用の道具一式（プローブ表・断面グラフ・生データ出力・ソルバーログ・キャンバスの重ね描き）。
// プロモードを初めて開くときだけ遅延 import で読み込まれる（main.ts）。
import { drawProbes, drawSection } from './pro-overlay';
import { initProTools } from './pro-tools';
import { ProState } from './probes';
import type { CanvasView } from './render';
import type { Runner } from './runner';
import type { Store } from './state';

export interface ProSuite {
  /** プローブと断面の位置（UI の状態。プロジェクトには保存しない） */
  state: ProState;
  /** 毎フレーム呼ぶ */
  update(): void;
}

export function initProSuite(opts: { store: Store; runner: Runner; view: CanvasView; host: HTMLElement }): ProSuite {
  const { store, runner, view, host } = opts;
  const state = new ProState();
  view.overlays.push(
    (p) => store.mode === 'pro' && drawProbes(p, state),
    (p) => store.mode === 'pro' && drawSection(p, state),
  );
  const tools = initProTools(store, runner, view, state, host);
  return { state, update: tools.update };
}
