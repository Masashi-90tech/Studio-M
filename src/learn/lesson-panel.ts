// レッスンパネル: 理論 → やってみる → 確認問題 → 実践 を 1 ステップずつ進める。
// 達成の確認（check）は refresh() のたびにアプリの状態を見て行う（ポーリングはコーディネーター側）。
import { clear, h, nextId } from './dom';
import {
  STEP_KIND_LABEL,
  applyChecks,
  canFinish,
  hasCheck,
  markStepComplete,
  parseBody,
  parseInline,
  quizVerdict,
  restoreLessonState,
  stepIndexClamp,
  stepTitle,
  type Block,
  type Inline,
} from './lesson-logic';
import type { LearnContext, Lesson, LessonState } from './types';

export interface LessonPanelOptions {
  container: HTMLElement;
  lesson: Lesson;
  /** いまのプロジェクトと結果（check の判定に使う） */
  getContext(): LearnContext;
  /** 「このプリセットを開く」を押したとき */
  onLoadPreset?(presetId: string): void;
  /** 状態が変わるたびに呼ぶ（保存はここで行う） */
  onProgress?(state: LessonState): void;
  /** 理論ステップの「数学の窓でこの式を見る」を押したとき */
  onOpenFormula?(formulaId: string): void;
  /** 保存しておいた状態から再開する */
  initial?: Partial<LessonState> | null;
}

export interface LessonPanelHandle {
  /** アプリの状態が変わったとき（達成の確認をやり直す） */
  refresh(): void;
  /** 現在の状態 */
  getState(): LessonState;
  dispose(): void;
}

function inlineNodes(list: Inline[]): Array<Node | string> {
  return list.map((i) => (i.bold ? h('strong', null, i.text) : i.code ? h('code', { class: 'll-code' }, i.text) : i.text));
}

/** 本文を段落と箇条書きにして要素にする */
export function renderBody(body: string): HTMLElement {
  const box = h('div', { class: 'll-body' });
  for (const b of parseBody(body) as Block[]) {
    if (b.type === 'p') box.append(h('p', null, ...inlineNodes(b.inlines)));
    else box.append(h('ul', null, ...b.items.map((it) => h('li', null, ...inlineNodes(it)))));
  }
  return box;
}

export function renderLessonPanel(opts: LessonPanelOptions): LessonPanelHandle {
  const { container, lesson } = opts;
  let state = restoreLessonState(lesson, opts.initial);
  let disposed = false;
  /** 「答えを見る」を押したクイズ（このセッションだけ） */
  const revealed = new Set<number>();

  const root = h('div', { class: 'll-root', role: 'region', 'aria-label': `レッスン: ${lesson.title}` });
  const dots = h('ol', { class: 'll-dots', 'aria-label': 'ステップ' });
  const stage = h('section', { class: 'll-step', 'aria-live': 'polite' });
  const nav = h('div', { class: 'll-nav' });
  const head = h(
    'header',
    { class: 'll-head' },
    h('h3', { class: 'll-title' }, lesson.title),
    h(
      'p',
      { class: 'll-meta' },
      h('span', { class: 'll-level', 'data-level': lesson.level }, lesson.level),
      `約 ${lesson.minutes} 分`,
      ...lesson.topics.map((t) => h('span', { class: 'lw-chip', 'data-level': t.level }, t.name, h('span', { class: 'lw-chip-level' }, t.level))),
    ),
    opts.onLoadPreset ? h('button', { type: 'button', class: 'btn small ll-open-preset', onclick: () => opts.onLoadPreset?.(lesson.presetId) }, 'このプリセットを開く') : null,
  );
  root.append(head, dots, stage, nav);
  container.append(root);

  // 状態が変わったときに更新する要素（ステップを作り直さずに直す）
  let statusEl: HTMLElement | null = null;
  let manualBtn: HTMLButtonElement | null = null;

  const emit = (): void => opts.onProgress?.(state);
  /** コンテキストを取れないときは何も達成していない扱い（check は例外を「まだ」にする） */
  const safeContext = (): LearnContext => {
    try {
      return opts.getContext();
    } catch {
      return { project: null as never, result: null };
    }
  };

  const setState = (next: LessonState, silent = false): void => {
    if (next === state) return;
    state = next;
    renderDots();
    renderNav();
    updateStatus();
    if (!silent) emit();
  };

  const go = (i: number): void => {
    const idx = stepIndexClamp(lesson, i);
    let next: LessonState = { ...state, stepIndex: idx };
    // 理論は開いたら読んだことにする
    if (lesson.steps[idx].kind === 'theory') next = markStepComplete(next, idx);
    state = applyChecks(lesson, next, safeContext());
    renderAll();
    emit();
  };

  function renderDots(): void {
    clear(dots);
    lesson.steps.forEach((step, i) => {
      const cur = i === state.stepIndex;
      const done = state.completed[i] === true;
      const label = `ステップ ${i + 1}（${STEP_KIND_LABEL[step.kind]}）${stepTitle(step, i)}${done ? ' 完了' : ''}`;
      const btn = h(
        'button',
        { type: 'button', class: `ll-dot${cur ? ' current' : ''}${done ? ' done' : ''}`, 'aria-label': label, title: label, 'aria-current': cur ? 'step' : false, onclick: () => go(i) },
        done ? '✓' : String(i + 1),
      );
      dots.append(h('li', null, btn));
    });
  }

  function renderNav(): void {
    clear(nav);
    const i = state.stepIndex;
    const last = i === lesson.steps.length - 1;
    nav.append(
      h('button', { type: 'button', class: 'btn small ll-prev', disabled: i === 0, onclick: () => go(i - 1) }, '← 戻る'),
      h('span', { class: 'll-count' }, `${i + 1} / ${lesson.steps.length}`),
    );
    if (!last) nav.append(h('button', { type: 'button', class: 'btn small primary ll-next', onclick: () => go(i + 1) }, '次へ →'));
    else {
      nav.append(
        h(
          'button',
          {
            type: 'button',
            class: 'btn small primary ll-finish',
            onclick: () => {
              setState({ ...state, done: true });
              renderAll();
            },
          },
          state.done ? '完了済み（もう一度）' : 'レッスンを終える',
        ),
      );
    }
  }

  function statusText(i: number): { ok: boolean; text: string } {
    const step = lesson.steps[i];
    const ok = state.completed[i] === true;
    if (hasCheck(step)) return ok ? { ok, text: '✓ できました' } : { ok, text: 'まだです。操作してみると、ここが ✓ に変わります。' };
    return ok ? { ok, text: '✓ やってみました' } : { ok, text: '' };
  }

  function updateStatus(): void {
    if (statusEl) {
      const s = statusText(state.stepIndex);
      statusEl.textContent = s.text;
      statusEl.classList.toggle('ok', s.ok);
    }
    if (manualBtn) manualBtn.hidden = state.completed[state.stepIndex] === true;
  }

  function actionStep(kind: 'try' | 'practice', i: number): HTMLElement {
    const step = lesson.steps[i];
    if (step.kind !== 'try' && step.kind !== 'practice') return h('div');
    const box = h('div', { class: 'll-action' });
    box.append(h('div', { class: 'll-task' }, ...inlineNodes(parseInline(step.kind === 'try' ? step.instruction : step.goal))));
    if (step.hint) box.append(h('details', { class: 'lw-details ll-hint' }, h('summary', null, 'ヒント'), h('p', null, step.hint)));
    statusEl = h('p', { class: 'll-status', role: 'status' });
    box.append(statusEl);
    if (!hasCheck(step)) {
      manualBtn = h(
        'button',
        {
          type: 'button',
          class: 'btn small',
          onclick: () => setState(markStepComplete(state, i)),
        },
        kind === 'try' ? 'やってみた' : 'できた',
      );
      box.append(manualBtn);
    }
    return box;
  }

  function quizStep(i: number): HTMLElement {
    const step = lesson.steps[i];
    if (step.kind !== 'quiz') return h('div');
    const box = h('div', { class: 'll-quiz' });
    const qid = nextId('ll-q');
    box.append(h('p', { class: 'll-question', id: qid }, ...inlineNodes(parseInline(step.question))));
    const choice = state.quizChoice[i];
    const verdict = quizVerdict(step, choice);
    const showAnswer = verdict === 'correct' || revealed.has(i);
    const list = h('div', { class: 'll-choices', role: 'group', 'aria-labelledby': qid });
    step.choices.forEach((text, k) => {
      const picked = choice === k;
      const cls = ['ll-choice'];
      if (picked) cls.push(verdict === 'correct' ? 'correct' : 'wrong');
      if (showAnswer && k === step.answer) cls.push('correct');
      list.append(
        h(
          'button',
          {
            type: 'button',
            class: cls.join(' '),
            'aria-pressed': picked ? 'true' : 'false',
            disabled: verdict === 'correct',
            onclick: () => {
              let next: LessonState = { ...state, quizChoice: { ...state.quizChoice, [i]: k } };
              if (k === step.answer) next = markStepComplete(next, i);
              state = next;
              renderAll();
              emit();
            },
          },
          h('span', { class: 'll-choice-mark', 'aria-hidden': 'true' }, String.fromCharCode(65 + k)),
          text,
        ),
      );
    });
    box.append(list);
    const fb = h('div', { class: 'll-feedback', role: 'status' });
    if (verdict === 'correct') fb.append(h('p', { class: 'll-fb-title ok' }, '✓ 正解です'));
    else if (verdict === 'wrong') {
      fb.append(h('p', { class: 'll-fb-title ng' }, 'おしい。もう一度考えてみましょう。'));
      if (!revealed.has(i)) {
        fb.append(
          h(
            'button',
            {
              type: 'button',
              class: 'btn small',
              onclick: () => {
                revealed.add(i);
                renderAll();
              },
            },
            '答えと説明を見る',
          ),
        );
      }
    }
    if (showAnswer) fb.append(h('p', { class: 'll-explain' }, step.explanation));
    box.append(fb);
    return box;
  }

  function renderStep(): void {
    clear(stage);
    statusEl = null;
    manualBtn = null;
    const i = state.stepIndex;
    const step = lesson.steps[i];
    stage.append(h('p', { class: 'll-kind', 'data-kind': step.kind }, STEP_KIND_LABEL[step.kind]), h('h4', { class: 'll-step-title' }, stepTitle(step, i)));
    if (step.kind === 'theory') {
      stage.append(renderBody(step.body));
      if (step.formulaId && opts.onOpenFormula) {
        const id = step.formulaId;
        stage.append(h('button', { type: 'button', class: 'btn small ll-formula', onclick: () => opts.onOpenFormula?.(id) }, '数学の窓でこの式を見る'));
      }
    } else if (step.kind === 'quiz') stage.append(quizStep(i));
    else stage.append(actionStep(step.kind, i));
    if (i === lesson.steps.length - 1 && state.done) {
      stage.append(
        h(
          'p',
          { class: 'll-finished' },
          canFinish(lesson, state) ? 'このレッスンは完了です。お疲れさまでした。' : '終えました。飛ばしたステップは、上の番号からいつでも戻れます。',
        ),
      );
    }
    updateStatus();
  }

  function renderAll(): void {
    renderDots();
    renderStep();
    renderNav();
  }

  // 初回: 開いたステップが理論なら読んだことにする
  if (lesson.steps[state.stepIndex]?.kind === 'theory') state = markStepComplete(state, state.stepIndex);
  state = applyChecks(lesson, state, safeContext());
  renderAll();

  return {
    refresh() {
      if (disposed) return;
      let ctx: LearnContext;
      try {
        ctx = opts.getContext();
      } catch {
        return;
      }
      const next = applyChecks(lesson, state, ctx);
      if (next !== state) {
        state = next;
        renderDots();
        updateStatus();
        emit();
      }
    },
    getState: () => state,
    dispose() {
      disposed = true;
      root.remove();
    },
  };
}
