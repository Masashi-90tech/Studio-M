// ヘッダーの「かんたん / 標準 / プロ」切り替えと、詳細設定を変更済みのバッジ。
import { h } from './dom';
import { hasProSettings, MODE_HINTS, MODE_LABELS, MODES, type UiMode } from './modes';
import type { Store } from './state';

export function initModeSwitch(store: Store, host: HTMLElement, badge: HTMLButtonElement): void {
  host.setAttribute('role', 'radiogroup');
  host.setAttribute('aria-label', '表示モード');
  const buttons = new Map<UiMode, HTMLButtonElement>();

  const pick = (m: UiMode, focus = false): void => {
    store.setMode(m);
    if (focus) buttons.get(m)?.focus();
  };

  for (const m of MODES) {
    const b = h('button', { class: 'seg-btn', type: 'button', role: 'radio', title: MODE_HINTS[m], 'data-mode': m, onclick: () => pick(m) }, MODE_LABELS[m]);
    b.addEventListener('keydown', (e) => {
      const i = MODES.indexOf(m);
      let next: number | null = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % MODES.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i + MODES.length - 1) % MODES.length;
      if (next !== null) {
        e.preventDefault();
        pick(MODES[next], true);
      }
    });
    buttons.set(m, b);
    host.append(b);
  }

  const refresh = (): void => {
    for (const [m, b] of buttons) {
      const on = m === store.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    document.body.dataset.mode = store.mode;
    badge.hidden = store.mode === 'pro' || !hasProSettings(store.project);
  };
  badge.addEventListener('click', () => pick('pro'));
  store.on('mode', refresh);
  store.on('project', refresh);
  store.on('load', refresh);
  refresh();
}
