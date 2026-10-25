// パネル部品: 設定パネル（標準・かんたん・プロ）で共有する小さな部品。
import type { PanelFactory } from '../workbench/types';
import { h } from './dom';
import type { Runner } from './runner';
import type { Store } from './state';

/** 設定パネルが共有する道具 */
export interface PanelCtx {
  store: Store;
  runner: Runner;
  /** 値を書き換えて通知する。同じ欄の連続入力は 1 回の「元に戻す」にまとめる */
  change(key: string, apply: () => void): void;
  /** 計算結果やプロジェクトが変わったときに呼ぶ更新関数を登録する */
  onRefresh(fn: () => void): void;
}

export function makeCtx(store: Store, runner: Runner, refreshers: (() => void)[]): PanelCtx {
  return {
    store,
    runner,
    change(key, apply) {
      store.checkpoint(`set:${key}`, 800);
      apply();
      store.touch('settings');
    },
    onRefresh(fn) {
      refreshers.push(fn);
    },
  };
}

/**
 * カード 1 枚のパネル（PanelFactory）を作る。build は PanelCtx を受け取ってカードを返す。
 * ctx.onRefresh に登録した関数は handle.refresh() でまとめて呼ばれる。毎フレームの処理があれば { root, update } で返す。
 * 作りが変わる条件があれば structureKey で返す（PanelHandle.structureKey）。dispose はカードを container から外す。
 */
export function cardPanel(
  build: (ctx: PanelCtx) => HTMLElement | { root: HTMLElement; update?: () => void; structureKey?: () => string },
): PanelFactory {
  return ({ store, runner, container }) => {
    const refreshers: (() => void)[] = [];
    const built = build(makeCtx(store, runner, refreshers));
    const part = 'root' in built ? built : { root: built, update: undefined, structureKey: undefined };
    container.append(part.root);
    return {
      refresh: () => refreshers.forEach((fn) => fn()),
      update: part.update,
      structureKey: part.structureKey,
      dispose: () => part.root.remove(),
    };
  };
}

export interface ChipOption<T extends string | number> {
  value: T;
  label: string;
  /** ボタンの title（補足） */
  hint?: string;
}

export interface ChipRow<T extends string | number> {
  root: HTMLElement;
  /** 選択中の値を反映する。該当なしは null */
  set(value: T | null): void;
}

/**
 * 選択肢をボタンで並べる（押した状態は aria-pressed）。
 * 「質問に答える」かんたんモードの基本部品。
 */
export function chipRow<T extends string | number>(label: string, options: ChipOption<T>[], onPick: (v: T) => void, hint?: string): ChipRow<T> {
  const buttons = new Map<T, HTMLButtonElement>();
  const group = h('div', { class: 'chips', role: 'group', 'aria-label': label });
  for (const o of options) {
    const b = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', title: o.hint, onclick: () => onPick(o.value) }, o.label);
    buttons.set(o.value, b);
    group.append(b);
  }
  const root = h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), group, hint ? h('span', { class: 'hint' }, hint) : null);
  return {
    root,
    set(value) {
      for (const [v, b] of buttons) {
        const on = value !== null && v === value;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('on', on);
      }
    },
  };
}

/** 小さな数値入力（単位つき）。指数表記も受け付ける。確定するまで入力中の欄は書き換えない */
export function plainNumber(opts: {
  label: string;
  unit?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number | 'any';
  hint?: string;
  onChange: (v: number) => void;
}): { root: HTMLElement; input: HTMLInputElement; set(v: number): void } {
  const fmt = (v: number): string => (Number.isFinite(v) ? String(Number(v.toPrecision(6))) : '');
  const input = h('input', { type: 'number', inputmode: 'decimal', step: opts.step ?? 'any', min: opts.min, max: opts.max, value: fmt(opts.value) });
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    const ok = Number.isFinite(v) && (opts.min === undefined || v >= opts.min) && (opts.max === undefined || v <= opts.max);
    input.classList.toggle('invalid', !ok && input.value !== '');
    if (ok) opts.onChange(v);
  });
  input.addEventListener('change', () => {
    input.classList.remove('invalid');
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) input.value = fmt(Math.min(opts.max ?? Infinity, Math.max(opts.min ?? -Infinity, v)));
  });
  const root = h(
    'label',
    { class: 'field' },
    h('span', { class: 'field-label' }, opts.label, opts.unit ? h('span', { class: 'unit' }, ` [${opts.unit}]`) : null),
    input,
    opts.hint ? h('span', { class: 'hint' }, opts.hint) : null,
  );
  return {
    root,
    input,
    set(v) {
      if (document.activeElement !== input) input.value = fmt(v);
    },
  };
}
