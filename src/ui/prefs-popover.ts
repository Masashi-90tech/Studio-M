// ヘッダーの「設定」（⚙）: 閲覧者ごとの設定を出すポップオーバー。学習機能の表示切り替えと、PC のエンジンへの接続。
import { h } from './dom';
import type { EngineUi } from './engine-open';
import type { LearnSwitch } from './learn-pref';
import { attachDisclosure } from './menu';

export function initPrefsPopover(opts: { button: HTMLElement; panel: HTMLElement; learn: LearnSwitch; engine?: Pick<EngineUi, 'mountSettings'> }): void {
  const { button, panel, learn } = opts;
  const check = h('input', { type: 'checkbox', id: 'optLearn', 'aria-describedby': 'optLearnHint' });
  check.checked = learn.get();
  check.addEventListener('change', () => {
    learn.set(check.checked);
  });
  learn.subscribe((on) => (check.checked = on));

  panel.append(
    h('div', { class: 'pop-title' }, '設定'),
    h('label', { class: 'pop-check', for: 'optLearn' }, check, h('span', null, '学習機能を表示する（数学の窓・学ぶ）')),
    h('p', { class: 'pop-hint', id: 'optLearnHint' }, '式の解説やレッスンが不要なら、オフのままで画面がすっきりします。この設定はこのブラウザに保存されます。'),
  );
  // PC のエンジンの欄は、初めて開いたときに作る（使わない人には何も読み込まない）
  const engineHost = h('div', { class: 'engine-settings' });
  panel.append(engineHost);
  let engineMounted = false;
  attachDisclosure({
    button,
    panel,
    onOpen: () => {
      check.focus();
      if (opts.engine && !engineMounted) {
        engineMounted = true;
        void opts.engine.mountSettings(engineHost).catch((e) => {
          engineMounted = false;
          console.error(e);
        });
      }
    },
  });
}
