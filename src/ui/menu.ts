// ヘッダーのメニュー・ポップオーバーの共通部分: 開閉、外側のクリックと Esc で閉じる、矢印キーで項目を移る。
// 見た目は style.css の .menu / .menu-item。DOM の組み立ては呼び出し側。

/** 矢印キーなどで次にフォーカスする項目の番号。キーが関係ないとき・項目がないときは -1 */
export function nextMenuIndex(opts: { current: number; count: number; key: string }): number {
  const { current, count, key } = opts;
  if (count <= 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return -1;
  }
}

export interface Disclosure {
  open(focusInside?: boolean): void;
  close(restoreFocus?: boolean): void;
  isOpen(): boolean;
}

/** ボタンで開閉するパネル。外側のクリック・Esc で閉じる。aria-expanded を合わせる */
export function attachDisclosure(opts: { button: HTMLElement; panel: HTMLElement; onOpen?: (viaKeyboard: boolean) => void }): Disclosure {
  const { button, panel } = opts;
  let open = false;

  const set = (next: boolean): void => {
    open = next;
    panel.hidden = !next;
    button.setAttribute('aria-expanded', String(next));
  };
  const close = (restoreFocus = false): void => {
    if (!open) return;
    set(false);
    if (restoreFocus) button.focus();
  };

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open) close();
    else {
      set(true);
      // キーボードで押されたとき（detail が 0）だけ、中へフォーカスを移す
      opts.onOpen?.(e.detail === 0);
    }
  });
  document.addEventListener('click', (e) => {
    if (open && !panel.contains(e.target as Node) && !button.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close(panel.contains(document.activeElement) || document.activeElement === button);
    }
  });
  // フォーカスがパネルの外へ出たら閉じる（Tab で抜けたとき）
  panel.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (open && to && !panel.contains(to) && !button.contains(to)) close();
  });
  set(false);
  return { open: () => set(true), close, isOpen: () => open };
}

const ITEMS = '[role="menuitem"]:not([disabled])';

/** 項目（role="menuitem"）を矢印キーで移れるメニュー。項目を押したら閉じる */
export function attachMenu(opts: { button: HTMLElement; menu: HTMLElement }): Disclosure {
  const { button, menu } = opts;
  const items = (): HTMLElement[] => Array.from(menu.querySelectorAll<HTMLElement>(ITEMS));
  const focusAt = (i: number): void => {
    const list = items();
    list[i]?.focus();
  };
  const d = attachDisclosure({
    button,
    panel: menu,
    onOpen: (viaKeyboard) => {
      for (const el of items()) el.tabIndex = -1; // Tab ではなく矢印キーで移る
      if (viaKeyboard) focusAt(0);
    },
  });

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!d.isOpen() && e.target === button) {
        e.preventDefault();
        button.click();
        // click の detail は 0 なので、onOpen が先頭に移す。上矢印なら末尾へ
        if (e.key === 'ArrowUp') focusAt(items().length - 1);
        return;
      }
    }
    if (!d.isOpen() || !menu.contains(e.target as Node)) return;
    const list = items();
    const next = nextMenuIndex({ current: list.indexOf(document.activeElement as HTMLElement), count: list.length, key: e.key });
    if (next >= 0) {
      e.preventDefault();
      list[next].focus();
    }
  };
  button.addEventListener('keydown', onKey);
  menu.addEventListener('keydown', onKey);
  menu.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest(ITEMS)) d.close();
  });
  return d;
}
