// プロモードの「詳細設定」カードの部品: 解析ごとの advanced 項目を「自動 ⇄ 手動」で切り替えて編集する。
// 自動のときは、いま実際に使われている値（結果のスカラー）と理由を見せる。
// 解析ごとの項目の一覧（Spec）は各ワークベンチのパネル（src/workbench/panels/）が持ち、ここは描き方だけを受け持つ。
import { analysisLabel } from '../core/analyses';
import type { AnalysisKind } from '../core/types';
import type { PanelFactory } from '../workbench/types';
import { h, section } from './dom';
import { formatNumber } from './format';
import { cardPanel, plainNumber, type PanelCtx } from './panel-kit';

export interface NumSpec {
  type: 'num';
  key: string;
  label: string;
  unit?: string;
  hint: string;
  min: number;
  max: number;
  /** 手動に切り替えたとき、使われている値が分からない場合の初期値 */
  initial: number;
  /** 自動で使われた値が入っている結果スカラーの key（先に見つかったもの） */
  scalarKeys?: string[];
  /** 自動のときの説明（省略時の値など） */
  autoNote: string;
}

export interface EnumSpec {
  type: 'enum';
  key: string;
  label: string;
  hint: string;
  options: { value: string; label: string }[];
  initial: string;
  autoNote: string;
}

export type Spec = NumSpec | EnumSpec;

/** 反復で解く解析（熱・強度・対流拡散）に共通の項目 */
export const ITERATIVE_SPECS: Spec[] = [
  {
    type: 'num',
    key: 'tolerance',
    label: '収束判定（相対残差）',
    hint: '小さいほど厳密ですが、反復が増えます',
    min: 1e-12,
    max: 0.1,
    initial: 1e-6,
    scalarKeys: ['tolerance'],
    autoNote: '解析に合わせた値',
  },
  {
    type: 'num',
    key: 'maxIterations',
    label: '最大反復回数',
    unit: '回',
    hint: '収束しなくてもここで打ち切ります',
    min: 10,
    max: 1e7,
    initial: 20000,
    scalarKeys: ['maxIterations'],
    autoNote: '解析に合わせた値',
  },
];

type Adv = Record<string, number | string | undefined>;

/** project[kind].advanced を読む／書く（空になったら advanced ごと消す） */
function advOf(ctx: PanelCtx, kind: AnalysisKind): Adv | undefined {
  return (ctx.store.project[kind] as { advanced?: Adv }).advanced;
}

function setAdv(ctx: PanelCtx, kind: AnalysisKind, key: string, value: number | string | undefined): void {
  ctx.change(`adv:${kind}:${key}`, () => {
    const holder = ctx.store.project[kind] as { advanced?: Adv };
    const adv: Adv = { ...(holder.advanced ?? {}) };
    if (value === undefined) delete adv[key];
    else adv[key] = value;
    if (Object.values(adv).some((v) => v !== undefined)) holder.advanced = adv;
    else delete holder.advanced;
  });
}

/** 結果のスカラーから、自動で選ばれた値を探す */
function usedValue(ctx: PanelCtx, keys: string[] | undefined): number | undefined {
  if (!keys) return undefined;
  const r = ctx.runner.result;
  for (const k of keys) {
    const s = r?.scalars.find((x) => x.key === k);
    if (s && Number.isFinite(s.value)) return s.value;
  }
  return undefined;
}

/** 1 項目: 自動 ⇄ 手動のスイッチと、手動のときだけ使える入力 */
function autoManualRow(ctx: PanelCtx, kind: AnalysisKind, spec: Spec): HTMLElement {
  const name = `adv-${kind}-${spec.key}`;
  const mk = (value: string, label: string): HTMLInputElement => {
    const input = h('input', { type: 'radio', name, value });
    return Object.assign(input, { title: label });
  };
  const autoRadio = mk('auto', '自動');
  const manualRadio = mk('manual', '手動');
  const note = h('span', { class: 'hint auto-note' });
  const slot = h('div', { class: 'manual-slot' });

  let numeric: ReturnType<typeof plainNumber> | null = null;
  let select: HTMLSelectElement | null = null;
  if (spec.type === 'num') {
    numeric = plainNumber({
      label: '値',
      unit: spec.unit,
      value: spec.initial,
      min: spec.min,
      max: spec.max,
      onChange: (v) => setAdv(ctx, kind, spec.key, v),
    });
    slot.append(numeric.root);
  } else {
    select = h('select', { 'aria-label': spec.label }, ...spec.options.map((o) => h('option', { value: o.value }, o.label)));
    select.addEventListener('change', () => setAdv(ctx, kind, spec.key, select!.value));
    slot.append(select);
  }

  const apply = (manual: boolean): void => {
    if (!manual) {
      setAdv(ctx, kind, spec.key, undefined);
      return;
    }
    // 手動にしたら、いま使われている値から始める
    if (spec.type === 'num') {
      const used = usedValue(ctx, spec.scalarKeys);
      const v = Math.min(spec.max, Math.max(spec.min, used ?? spec.initial));
      numeric!.input.value = String(Number(v.toPrecision(6)));
      setAdv(ctx, kind, spec.key, Number(v.toPrecision(6)));
    } else {
      setAdv(ctx, kind, spec.key, spec.initial);
    }
  };
  autoRadio.addEventListener('change', () => autoRadio.checked && apply(false));
  manualRadio.addEventListener('change', () => manualRadio.checked && apply(true));

  const refresh = (): void => {
    const cur = advOf(ctx, kind)?.[spec.key];
    const manual = cur !== undefined;
    autoRadio.checked = !manual;
    manualRadio.checked = manual;
    slot.hidden = !manual;
    if (manual) {
      if (numeric && typeof cur === 'number') numeric.set(cur);
      if (select && typeof cur === 'string') select.value = cur;
      note.textContent = '手動で指定しています';
    } else {
      const used = spec.type === 'num' ? usedValue(ctx, spec.scalarKeys) : undefined;
      note.textContent = used !== undefined ? `自動: ${formatNumber(used, 3)}（${spec.autoNote}）` : `自動: ${spec.autoNote}`;
    }
  };
  ctx.onRefresh(refresh);
  refresh();

  const seg = h(
    'div',
    { class: 'seg mini', role: 'radiogroup', 'aria-label': `${spec.label}の自動・手動` },
    h('label', null, autoRadio, h('span', null, '自動')),
    h('label', null, manualRadio, h('span', null, '手動')),
  );
  return h(
    'div',
    { class: 'pro-row' },
    h('div', { class: 'pro-head' }, h('span', { class: 'field-label' }, spec.label), seg),
    note,
    slot,
    h('span', { class: 'hint' }, spec.hint),
  );
}

/** 詳細設定カード */
export function proCard(ctx: PanelCtx, kind: AnalysisKind, specs: Spec[]): HTMLElement {
  const reset = h('button', { class: 'btn small', type: 'button', onclick: () => {
    ctx.change(`adv:${kind}:reset`, () => delete (ctx.store.project[kind] as { advanced?: Adv }).advanced);
  } }, 'すべて自動に戻す');
  return section(
    `詳細設定（${analysisLabel(kind)}・プロ）`,
    h('p', { class: 'hint' }, '「自動」のままなら、ソルバーが条件に合わせて決めます。手動にした項目だけが固定されます。'),
    ...specs.map((s) => autoManualRow(ctx, kind, s)),
    reset,
  );
}

/** プロモードの詳細設定パネル（PanelFactory）を、項目の一覧から作る */
export function proPanel(opts: { kind: AnalysisKind; specs: Spec[] }): PanelFactory {
  return cardPanel((ctx) => proCard(ctx, opts.kind, opts.specs));
}
