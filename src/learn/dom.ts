// 学びモード用の小さな DOM ヘルパー。画面側（src/ui/dom.ts）には依存しない。
// src/ui/dom.ts と似ているのは意図的: 学び（src/learn）は src/core だけに依存する層なので、画面の部品を逆向きに import しない。
// h() は 15 行ほどで、core には DOM を置けない。共通の置き場を作るほどではないので、コピーを持つ。style の扱いだけ違う。
type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

/** 要素を作る。on... はイベント、class / text / style / 属性はそのまま反映する */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let uid = 0;
/** ラベルと入力を結ぶ id を作る */
export function nextId(prefix: string): string {
  uid += 1;
  return `${prefix}-${uid}`;
}
