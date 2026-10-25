// 数学の窓: 判定の裏の式に今の数字を入れて見せ、スライダーで動かして結果の変わり方を体験する。
// 状態は小さな閉包の中にあり、update() は変わった部分だけを直す（スライダー操作中に壊さない）。
import { clear, h, nextId } from './dom';
import { formatPercentDiff, formatValue, ratioText } from './format';
import { SLIDER_STEPS, sliderPos, sliderValue } from './slider-math';
import type { Formula, MathTopic, MathVar } from './types';

export interface MathWindowOptions {
  container: HTMLElement;
  formulas: Formula[];
  onClose?(): void;
}

export interface MathWindowHandle {
  /** 式を差し替える。構造が同じ式は、動かしているスライダーを保ったまま数字だけ更新する */
  update(formulas: Formula[]): void;
  dispose(): void;
}

/** 変数の値の表示（display があればそれ、なければ SI 接頭辞つき） */
export function varText(v: MathVar, value: number): string {
  return v.display ? v.display(value) : formatValue(value, v.unit);
}

/** 式の結果の表示 */
export function resultText(f: Formula, value: number): string {
  return formatValue(value, f.resultUnit);
}

/** 数字を入れた行。「= …」で始まるなら結果の記号を前に付ける */
export function substitutedLine(f: Formula, text: string): string {
  return text.trimStart().startsWith('=') ? `${f.resultSymbol} ${text.trim()}` : text;
}

const initialValues = (f: Formula): Record<string, number> => Object.fromEntries(f.vars.map((v) => [v.key, v.value]));

/** 構造（文章・変数の並び）の指紋。変わったらカードを作り直す */
function structKey(f: Formula): string {
  return JSON.stringify([f.id, f.title, f.expression, f.resultSymbol, f.resultLabel, f.resultUnit, f.steps, f.why, f.approx, f.topics, f.vars.map((v) => [v.key, v.symbol, v.label, v.unit, v.fixed, v.source, v.log, v.step])]);
}
/** 値と範囲の指紋。変わったら元の値・スライダーの範囲を直す */
const valueKey = (f: Formula): string => JSON.stringify(f.vars.map((v) => [v.value, v.min, v.max]));
const simKey = (f: Formula): string => JSON.stringify(f.simulation ?? null);

function topicChip(t: MathTopic): HTMLElement {
  return h('span', { class: 'lw-chip', 'data-level': t.level }, t.name, h('span', { class: 'lw-chip-level' }, t.level));
}

class Card {
  readonly el: HTMLElement;
  formula: Formula;
  private struct: string;
  private values: string;
  private sim: string;
  /** スライダーで動かしている現在の値 */
  private current: Record<string, number>;
  private readonly refs = new Map<string, { slider: HTMLInputElement; out: HTMLElement; row: HTMLElement }>();
  private substEl!: HTMLElement;
  private resultEl!: HTMLElement;
  private deltaEl!: HTMLElement;
  private insightEl!: HTMLElement;
  private resetBtn!: HTMLButtonElement;
  private simEl!: HTMLElement;

  constructor(formula: Formula) {
    this.formula = formula;
    this.struct = structKey(formula);
    this.values = valueKey(formula);
    this.sim = simKey(formula);
    this.current = initialValues(formula);
    this.el = h('section', { class: 'lw-card', 'data-formula-id': formula.id, 'aria-label': formula.title });
    this.build();
    this.refresh();
  }

  private base(): Record<string, number> {
    return initialValues(this.formula);
  }

  private build(openFlags: boolean[] = []): void {
    const f = this.formula;
    clear(this.el);
    this.refs.clear();
    const titleId = nextId('lw-title');
    this.el.setAttribute('aria-labelledby', titleId);
    this.el.removeAttribute('aria-label');

    this.el.append(
      h('header', { class: 'lw-card-head' }, h('h3', { class: 'lw-title', id: titleId }, f.title), h('div', { class: 'lw-topics' }, ...f.topics.map(topicChip))),
      h('p', { class: 'lw-expr', 'aria-label': `式 ${f.expression}` }, f.expression),
    );
    this.substEl = h('p', { class: 'lw-subst' });
    this.resultEl = h('p', { class: 'lw-result' });
    this.deltaEl = h('p', { class: 'lw-delta' });
    this.insightEl = h('p', { class: 'lw-insight', role: 'status', 'aria-live': 'polite' });
    this.el.append(this.substEl, this.resultEl, this.deltaEl, this.insightEl);

    // スライダー
    const sliders = h('div', { class: 'lw-vars' });
    for (const v of f.vars) sliders.append(this.varRow(v));
    this.resetBtn = h('button', { type: 'button', class: 'btn small lw-reset', onclick: () => this.reset() }, '元に戻す');
    this.el.append(sliders, h('div', { class: 'lw-actions' }, this.resetBtn));

    // 考え方・なぜ
    let detailIndex = 0;
    const details = (summary: string, ...body: Array<Node | string>): HTMLDetailsElement => {
      const d = h('details', { class: 'lw-details' }, h('summary', null, summary), ...body);
      if (openFlags[detailIndex]) d.open = true;
      detailIndex += 1;
      return d;
    };
    if (f.steps && f.steps.length > 0) {
      this.el.append(details('考え方（この式の導き方）', h('ol', { class: 'lw-steps' }, ...f.steps.map((s) => h('li', null, s)))));
    }
    if (f.why && f.why.length > 0) {
      const box = h('div', { class: 'lw-why' });
      for (const w of f.why) box.append(details(`なぜ？ ${w.question}`, h('p', null, w.answer)));
      this.el.append(box);
    }
    if (f.approx) this.el.append(h('p', { class: 'lw-approx' }, h('strong', null, 'この式の限界　'), f.approx));
    this.simEl = h('div', { class: 'lw-sim' });
    this.el.append(this.simEl);
  }

  private varRow(v: MathVar): HTMLElement {
    const id = nextId('lw-var');
    const value = this.current[v.key] ?? v.value;
    if (v.fixed) {
      const out = h('output', { class: 'lw-var-value', for: id }, varText(v, value));
      const row = h('div', { class: 'lw-var lw-var-fixed' }, h('span', { class: 'lw-var-label' }, h('span', { class: 'lw-var-sym' }, v.symbol), ` ${v.label}`), out);
      this.refs.set(v.key, { slider: h('input', { type: 'hidden' }), out, row });
      return row;
    }
    const slider = h('input', {
      type: 'range',
      id,
      class: 'lw-slider',
      min: 0,
      max: SLIDER_STEPS,
      step: 1,
      value: sliderPos(v, value),
      'data-key': v.key,
      'aria-valuetext': varText(v, value),
    });
    const out = h('output', { class: 'lw-var-value', for: id }, varText(v, value));
    slider.addEventListener('input', () => {
      const cur = this.formula.vars.find((x) => x.key === v.key);
      if (!cur) return;
      this.current[v.key] = sliderValue(cur, Number(slider.value));
      this.refresh();
    });
    const row = h(
      'div',
      { class: 'lw-var' },
      h('label', { class: 'lw-var-label', for: id }, h('span', { class: 'lw-var-sym' }, v.symbol), ` ${v.label}`, v.source ? h('span', { class: 'lw-var-source' }, `（${v.source}）`) : null),
      slider,
      out,
    );
    this.refs.set(v.key, { slider, out, row });
    return row;
  }

  /** 元の値に戻す */
  reset(): void {
    this.current = this.base();
    this.refresh();
  }

  /** 今の値で、式・結果・一言・比較を描き直す */
  refresh(): void {
    const f = this.formula;
    const base = this.base();
    const cur = this.current;
    for (const v of f.vars) {
      const ref = this.refs.get(v.key);
      if (!ref) continue;
      const value = cur[v.key] ?? v.value;
      ref.out.textContent = varText(v, value);
      if (!v.fixed) {
        const pos = String(sliderPos(v, value));
        if (ref.slider.value !== pos) ref.slider.value = pos;
        ref.slider.setAttribute('aria-valuetext', varText(v, value));
      }
      ref.row.classList.toggle('lw-changed', Math.abs(value - v.value) > 1e-12 * Math.max(1, Math.abs(v.value)));
    }
    let result = NaN;
    let baseResult = NaN;
    let text = '';
    try {
      result = f.evaluate(cur);
      baseResult = f.evaluate(base);
      text = f.substituted(cur);
    } catch {
      /* 計算できない値のときは「—」を出す */
    }
    this.substEl.textContent = substitutedLine(f, text);
    clear(this.resultEl);
    this.resultEl.append(
      h('span', { class: 'lw-sym' }, f.resultSymbol),
      ' = ',
      h('strong', { class: 'lw-value' }, Number.isFinite(result) ? resultText(f, result) : '—'),
      h('span', { class: 'lw-result-label' }, `　${f.resultLabel}`),
    );
    const changed = f.vars.some((v) => !v.fixed && Math.abs((cur[v.key] ?? v.value) - v.value) > 1e-12 * Math.max(1, Math.abs(v.value)));
    this.resetBtn.disabled = !changed;
    this.deltaEl.hidden = !changed || !Number.isFinite(result) || !Number.isFinite(baseResult);
    if (!this.deltaEl.hidden) {
      const ratio = baseResult !== 0 ? result / baseResult : NaN;
      this.deltaEl.textContent = `元の値 ${resultText(f, baseResult)}${Number.isFinite(ratio) && ratio > 0 ? ` → ${ratioText(ratio)}` : ''}`;
    }
    let insight: string | null = null;
    try {
      insight = changed ? (f.insight?.(cur, base) ?? null) : null;
    } catch {
      insight = null;
    }
    this.insightEl.textContent = insight ?? '';
    this.insightEl.hidden = !insight;
    this.renderSim();
  }

  private renderSim(): void {
    const f = this.formula;
    clear(this.simEl);
    const s = f.simulation;
    this.simEl.hidden = !s;
    if (!s) return;
    let mine = NaN;
    try {
      mine = f.evaluate(this.base());
    } catch {
      /* 比べられない */
    }
    const diff = Number.isFinite(mine) && s.value !== 0 && mine / s.value > 0 ? formatPercentDiff(mine / s.value) : null;
    this.simEl.append(
      h('div', { class: 'lw-sim-row' }, h('span', { class: 'lw-sim-key' }, s.label), h('strong', null, formatValue(s.value, s.unit))),
      h('div', { class: 'lw-sim-row' }, h('span', { class: 'lw-sim-key' }, 'この式（元の値）'), h('strong', null, Number.isFinite(mine) ? formatValue(mine, f.resultUnit) : '—'), diff ? h('span', { class: 'lw-sim-diff' }, `式は ${diff}`) : null),
    );
    if (s.note) this.simEl.append(h('p', { class: 'lw-sim-note' }, s.note));
  }

  /** 新しい式を受け取る。構造が変わったときだけ作り直し、スライダーの位置はできるだけ保つ */
  setFormula(next: Formula): void {
    const prev = this.formula;
    const struct = structKey(next);
    const values = valueKey(next);
    const sim = simKey(next);
    if (struct === this.struct && values === this.values && sim === this.sim) {
      this.formula = next; // 関数だけ差し替え（中身は同じ）
      return;
    }
    // 元の値が変わった変数のスライダーは新しい元の値へ。変わっていないものは動かした位置を保つ
    const keep: Record<string, number> = {};
    for (const v of next.vars) {
      const old = prev.vars.find((x) => x.key === v.key);
      keep[v.key] = old && old.value === v.value && this.current[v.key] !== undefined ? this.current[v.key] : v.value;
    }
    this.formula = next;
    this.current = keep;
    if (struct !== this.struct) {
      const flags = Array.from(this.el.querySelectorAll('details'), (d) => d.open);
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.key : undefined;
      this.build(flags);
      if (focused) this.refs.get(focused)?.slider.focus();
    } else if (values !== this.values) {
      for (const v of next.vars) {
        const ref = this.refs.get(v.key);
        if (ref && !v.fixed) ref.slider.value = String(sliderPos(v, keep[v.key]));
      }
    }
    this.struct = struct;
    this.values = values;
    this.sim = sim;
    this.refresh();
  }
}

export function renderMathWindow(opts: MathWindowOptions): MathWindowHandle {
  const { container, onClose } = opts;
  const root = h('div', { class: 'lw-root', role: 'region', 'aria-label': '数学の窓' });
  const head = h(
    'div',
    { class: 'lw-head' },
    h('h2', { class: 'lw-heading' }, '数学の窓'),
    onClose ? h('button', { type: 'button', class: 'btn small lw-close', 'aria-label': '数学の窓を閉じる', onclick: () => onClose() }, '閉じる') : null,
  );
  const HINT = 'スライダーを動かすと、答えがどう変わるか見えます。式の中の数は m・N・Pa などの基本単位で計算しています。';
  const hint = h('p', { class: 'lw-hint' }, HINT);
  const list = h('div', { class: 'lw-list' });
  root.append(head, hint, list);
  container.append(root);

  const cards = new Map<string, Card>();
  let disposed = false;

  const update = (formulas: Formula[]): void => {
    if (disposed) return;
    const ids = formulas.map((f) => f.id);
    for (const [id, card] of cards) {
      if (!ids.includes(id)) {
        card.el.remove();
        cards.delete(id);
      }
    }
    let prev: HTMLElement | null = null;
    for (const f of formulas) {
      let card = cards.get(f.id);
      if (card) card.setFormula(f);
      else {
        card = new Card(f);
        cards.set(f.id, card);
      }
      // 順番をそろえる（すでに正しい位置なら動かさない）
      const want: Element | null = prev ? prev.nextElementSibling : list.firstElementChild;
      if (want !== card.el) list.insertBefore(card.el, want);
      prev = card.el;
    }
    list.hidden = formulas.length === 0;
    hint.textContent = formulas.length === 0 ? 'この解析にはまだ数学の窓の式がありません。' : HINT;
  };
  update(opts.formulas);

  return {
    update,
    dispose() {
      disposed = true;
      cards.clear();
      root.remove();
    },
  };
}
