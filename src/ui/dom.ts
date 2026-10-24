// 小さな DOM ヘルパー（フレームワークなしで部品を組み立てる）。
import { inputNumber } from './format';

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

/** 要素を作る。on... はイベント、class/text/style/属性はそのまま反映する */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'style') el.style.cssText = String(v);
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

/** ラベル + 入力 + ヒントの一行 */
export function fieldRow(label: string, control: HTMLElement, hint?: string, unit?: string): HTMLElement {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label' }, label, unit ? h('span', { class: 'unit' }, ` [${unit}]`) : null),
    control,
    hint ? h('span', { class: 'hint' }, hint) : null,
  );
}

export interface NumField {
  root: HTMLElement;
  input: HTMLInputElement;
  /** 入力中でなければ値を差し替える */
  set(v: number): void;
}

export interface NumFieldOpts {
  label: string;
  unit?: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number | 'any';
  /** 表示する小数桁 */
  digits?: number;
  onChange: (v: number) => void;
}

export function numField(o: NumFieldOpts): NumField {
  const digits = o.digits ?? 3;
  const input = h('input', {
    type: 'number',
    inputmode: 'decimal',
    step: o.step ?? 'any',
    min: o.min,
    max: o.max,
    value: inputNumber(o.value, digits),
  });
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    const ok = Number.isFinite(v) && (o.min === undefined || v >= o.min) && (o.max === undefined || v <= o.max);
    input.classList.toggle('invalid', !ok && input.value !== '');
    if (ok) o.onChange(v);
  });
  input.addEventListener('change', () => {
    // 確定時に表示を整える（不正な入力は元の値に戻す）
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) input.value = inputNumber(Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v)), digits);
    input.classList.remove('invalid');
  });
  return {
    root: fieldRow(o.label, input, o.hint, o.unit),
    input,
    set(v: number) {
      if (document.activeElement !== input) input.value = inputNumber(v, digits);
    },
  };
}

export function selectField(
  label: string,
  options: { value: string; label: string }[],
  value: string,
  onChange: (v: string) => void,
  hint?: string,
): { root: HTMLElement; select: HTMLSelectElement } {
  const select = h('select', null, ...options.map((o) => h('option', { value: o.value }, o.label)));
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return { root: fieldRow(label, select, hint), select };
}

export function checkField(label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string): HTMLElement {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'field check' }, h('span', { class: 'check-line' }, input, h('span', { class: 'field-label' }, label)), hint ? h('span', { class: 'hint' }, hint) : null);
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'card' }, h('h3', null, title), ...children);
}

/** 画面下に一時的なメッセージを出す */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  host.append(el);
  window.setTimeout(() => el.classList.add('out'), kind === 'error' ? 6000 : 2800);
  window.setTimeout(() => el.remove(), kind === 'error' ? 6400 : 3200);
}

interface ClaudeDownloads {
  save(req: { filename: string; data: Blob }): Promise<unknown>;
}
interface ClaudeHost {
  use(name: 'downloads'): Promise<ClaudeDownloads | null>;
}

/**
 * ファイルを保存させる。claude.ai の Artifact として開かれているときは、
 * 通常のダウンロードが禁止されているので、ビューアーの保存機能を使う。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const host = (window as unknown as { claude?: ClaudeHost }).claude;
  if (host?.use) {
    void host.use('downloads').then(async (dl) => {
      if (!dl) {
        toast('この表示ではファイルを保存できません', 'error');
        return;
      }
      try {
        await dl.save({ filename, data: blob });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code !== 'declined') toast(`保存できませんでした（${code ?? '不明なエラー'}）`, 'error');
      }
    });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
