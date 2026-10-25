// ヘッダーの「設定」（⚙）: 閲覧者ごとの表示の設定を出すポップオーバー。いまは学習機能の表示切り替えだけ。
import { h } from './dom';
import type { LearnSwitch } from './learn-pref';
import { attachDisclosure } from './menu';

export function initPrefsPopover(opts: { button: HTMLElement; panel: HTMLElement; learn: LearnSwitch }): void {
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
  attachDisclosure({ button, panel, onOpen: () => check.focus() });
}
