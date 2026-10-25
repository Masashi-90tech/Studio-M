// かんたんモードの右パネルの枠。解析ごとの短い質問は、ワークベンチ（src/workbench）のパネルが受け持つ。
// 答えは Project（荷重・発熱・速度など）か、表示設定（安全率の目標など）に反映する。
import { createPanelSlot } from './panel-host';
import type { Runner } from './runner';
import type { Store } from './state';

export function initEasyPanel(store: Store, runner: Runner, host: HTMLElement): { update: () => void } {
  // 作り終えたとき、「作りの条件」を控える（これが変わったときだけ作り直す）
  let shapeSig = '';
  const sigOf = (): string => store.project.shapes.map((s) => `${s.id}:${s.role}`).join('|') + `|${panel.structureKey()}`;
  const panel = createPanelSlot({ store, runner, container: host, slot: 'easy', onMount: () => (shapeSig = sigOf()) });

  function build(): void {
    host.hidden = store.mode !== 'easy';
    panel.mount(store.mode === 'easy' ? store.analysis : null);
  }

  store.on('analysis', build);
  store.on('load', build);
  store.on('mode', build);
  store.on('selection', build);
  // 形の増減（荷重・発熱体を置いたなど）で出し分けが変わるときだけ作り直す。値の変更は表示だけ更新する
  store.on('project', () => {
    if (store.mode !== 'easy') return;
    const sig = sigOf();
    if (sig !== shapeSig) {
      shapeSig = sig;
      build();
    } else panel.refresh();
  });
  build();

  return {
    update(): void {
      if (store.mode === 'easy') panel.update();
    },
  };
}
