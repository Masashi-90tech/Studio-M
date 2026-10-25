// 学ぶ: ヘッダーの「学ぶ」ボタンで開くドロワー（レッスン一覧 → レッスン）と、プリセットを開いたときの「この例で学ぶ」の案内。
// 広い画面では右に列を足す非モーダルの置き方で、キャンバスを触りながらレッスンの「やってみる」を進められる。
// スマホでは画面いっぱいのシートで、閉じても状態（開いていたレッスン・ステップ）は残る。
// 学びモード本体（src/learn）は初めて開くときに遅延 import する。
import type { LessonListHandle, LessonPanelHandle } from '../learn/components';
import type { Lesson, LearnContext } from '../learn/types';
import { h } from './dom';
import {
  INITIAL_DRAWER,
  LEARN_UPDATE_MS,
  backToList,
  chipText,
  chipVisible,
  closeDrawer,
  createGate,
  drawerCoversMath,
  drawerLayout,
  drawerView,
  openDrawer,
  resultForLearning,
  toggleDrawer,
  type DrawerState,
} from './learn-logic';
import { withLoading } from './lazy';
import { createLearnSwitch, loadWhenEnabled, type LearnSwitch } from './learn-pref';
import type { MathCardHandle } from './math-card';
import { openPreset } from './open-preset';
import type { Runner } from './runner';
import type { Store } from './state';

/** 学びモード本体（初めて開くときに読み込む部品の束） */
async function loadLearn() {
  const [components, lessons, progress, logic] = await Promise.all([
    import('../learn/components'),
    import('../learn/lessons'),
    import('../learn/progress'),
    import('../learn/lesson-logic'),
  ]);
  return { ...components, ...lessons, ...progress, progressFromState: logic.progressFromState };
}
type Learn = Awaited<ReturnType<typeof loadLearn>>;

export interface LearnDrawerHandle {
  /** 毎フレーム呼ぶ。レッスンが開いているとき、間引きながら達成の確認をやり直す */
  update(): void;
  /** 開く。lessonId があればそのレッスンを開く */
  open(lessonId?: string): void;
  close(): void;
}

export function initLearnDrawer(opts: {
  store: Store;
  runner: Runner;
  math: MathCardHandle;
  drawer: HTMLElement;
  button: HTMLButtonElement;
  chipHost: HTMLElement;
  /** 学習機能の表示設定。OFF のあいだはボタン・ドロワー・案内を隠し、学びモードを読み込まない（省略時は常に ON） */
  learn?: LearnSwitch;
}): LearnDrawerHandle {
  const { store, runner, math, drawer, button, chipHost } = opts;
  const enabled = opts.learn ?? createLearnSwitch({ initial: true });
  let state: DrawerState = INITIAL_DRAWER;
  let learn: Learn | null = null;
  let loading: Promise<Learn | null> | null = null;
  let progress: Record<string, import('../learn/types').LessonProgress> = {};
  let list: LessonListHandle | null = null;
  let panel: LessonPanelHandle | null = null;
  let panelLessonId: string | null = null;
  const gate = createGate(LEARN_UPDATE_MS);
  let force = true;
  let lastVersion = -1;

  // ---------- 見た目の骨組み ----------
  const title = h('h2', { class: 'learn-title', tabindex: '-1', id: 'learnTitle' }, '学ぶ');
  const backBtn = h('button', { type: 'button', class: 'btn small learn-back', onclick: () => showList() }, '← 一覧へ戻る');
  const closeBtn = h('button', { type: 'button', class: 'btn small learn-close', 'aria-label': '学ぶを閉じる', onclick: () => close() }, '閉じる');
  const listHost = h('div', { class: 'learn-list-host' });
  const lessonHost = h('div', { class: 'learn-lesson-host' });
  const status = h('p', { class: 'hint learn-status' });
  drawer.append(h('header', { class: 'learn-head' }, title, backBtn, closeBtn), h('div', { class: 'learn-body' }, status, listHost, lessonHost));
  drawer.setAttribute('aria-labelledby', 'learnTitle');

  function syncView(): void {
    drawer.hidden = !state.open;
    button.setAttribute('aria-expanded', String(state.open));
    button.classList.toggle('active', state.open);
    document.body.dataset.learn = state.open ? 'open' : 'closed';
    const view = drawerView(state);
    listHost.hidden = view !== 'list';
    lessonHost.hidden = view !== 'lesson';
    backBtn.hidden = view !== 'lesson';
  }

  // ---------- 学びモードの読み込み ----------
  function ensureLearn(): Promise<Learn | null> {
    if (learn) return Promise.resolve(learn);
    loading ??= withLoading({ label: '学びモード', task: loadWhenEnabled(enabled, loadLearn) }).then((m) => {
      loading = null;
      if (!m) return null;
      learn = m;
      progress = m.loadProgress();
      list = m.renderLessonList({ container: listHost, lessons: m.LESSONS, path: m.LEARNING_PATH, progress, onOpen: (id) => showLesson(id) });
      return m;
    });
    return loading;
  }

  const learnContext = (): LearnContext => ({ project: store.project, result: resultForLearning(runner) });

  // ---------- 一覧 ⇄ レッスン ----------
  function showList(): void {
    state = backToList(state);
    disposePanel();
    syncView();
    drawer.querySelector<HTMLElement>('.learn-title')?.focus();
  }

  function disposePanel(): void {
    panel?.dispose();
    panel = null;
    panelLessonId = null;
  }

  function showLesson(lessonId: string): void {
    const m = learn;
    if (!m) return;
    const lesson: Lesson | undefined = m.findLesson(lessonId);
    if (!lesson) return;
    if (panelLessonId !== lessonId) {
      disposePanel();
      panelLessonId = lessonId;
      panel = m.renderLessonPanel({
        container: lessonHost,
        lesson,
        getContext: learnContext,
        onLoadPreset: (presetId) => {
          // 「プリセット」メニューと同じ経路で開く。結果は作り直されるので、確認は新しい結果で行う
          openPreset({ store, presetId });
          panel?.refresh();
        },
        onOpenFormula: (formulaId) => {
          // ドロワーが数学の窓を覆う置き方では、いったん閉じてから窓を見せる（開き直せば続きから）
          if (drawerCoversMath(drawerLayout(window.innerWidth))) close();
          void math.openFormula(formulaId);
        },
        onProgress: (s) => {
          progress = m.updateLessonProgress(progress, s.lessonId, m.progressFromState(s));
          m.saveProgress(progress);
          list?.update(progress);
        },
        initial: { stepIndex: progress[lessonId]?.step },
      });
    }
    state = openDrawer(state, lessonId);
    chipDismissed = true;
    renderChip();
    syncView();
    force = true;
  }

  function open(lessonId?: string): void {
    if (!enabled.get()) return;
    state = openDrawer(state, lessonId);
    syncView();
    void ensureLearn().then((m) => {
      if (!enabled.get()) return; // 読み込み中に OFF にされた
      if (!m) {
        // 読み込めなかったときは閉じる（toast は withLoading が出している）
        state = closeDrawer(state);
        syncView();
        return;
      }
      status.textContent = '';
      if (state.lessonId) showLesson(state.lessonId);
      else syncView();
      drawer.querySelector<HTMLElement>('.learn-title')?.focus({ preventScroll: true });
    });
  }

  function close(): void {
    if (!state.open) return;
    state = closeDrawer(state);
    syncView();
    button.focus({ preventScroll: true });
  }

  button.addEventListener('click', () => {
    if (toggleDrawer(state).open) open();
    else close();
  });
  drawer.addEventListener('keydown', (e) => {
    // スマホのシートは画面全体を覆うので Esc で閉じる。広い画面では操作の邪魔をしない
    if (e.key === 'Escape' && drawerLayout(window.innerWidth) === 'sheet') close();
  });

  // ---------- 「この例で学ぶ」の案内 ----------
  let chipLesson: Lesson | undefined;
  let chipDismissed = false;
  let edited = false;
  let chipSeq = 0;

  function renderChip(): void {
    const visible = chipVisible({ hasLesson: !!chipLesson, edited, dismissed: chipDismissed });
    chipHost.hidden = !visible;
    chipHost.replaceChildren();
    if (!visible || !chipLesson) return;
    const lesson = chipLesson;
    chipHost.append(
      h(
        'div',
        { class: 'learn-chip' },
        h('button', { type: 'button', class: 'learn-chip-open', onclick: () => open(lesson.id) }, chipText(lesson.minutes)),
        h('button', { type: 'button', class: 'learn-chip-x', 'aria-label': '案内を閉じる', onclick: () => ((chipDismissed = true), renderChip()) }, '×'),
      ),
    );
  }

  /** 開いているプリセットに合う「この例で学ぶ」の案内を作り直す（OFF のあいだは何も読み込まない） */
  function refreshChip(): void {
    const seq = ++chipSeq;
    chipLesson = undefined;
    chipDismissed = false;
    renderChip();
    const presetId = store.presetId;
    if (!presetId) return;
    // 学びモードの読み込みは、案内を出すときだけ（レッスンの一覧は軽い）
    void loadWhenEnabled(enabled, () => import('../learn/lessons')).then((m) => {
      if (!m || seq !== chipSeq) return; // OFF になった、または読み込み中にまた別のものが開かれた
      chipLesson = m.lessonForPreset(presetId);
      // ドロワーでそのレッスンを開いているなら案内は要らない
      chipDismissed = state.open && state.lessonId === chipLesson?.id;
      renderChip();
    });
  }
  store.on('load', () => {
    edited = false;
    refreshChip();
  });
  store.on('project', (src) => {
    if (src === 'name' || src === 'label' || edited) return;
    edited = true;
    renderChip();
  });

  // ---------- 毎フレームの更新 ----------
  for (const ev of ['project', 'load', 'analysis'] as const) store.on(ev, () => (force = true));

  function update(): void {
    if (!state.open || !panel) return;
    const changed = runner.resultVersion !== lastVersion;
    if (!force && !changed) return;
    if (!gate.pass(performance.now(), force)) return;
    force = false;
    lastVersion = runner.resultVersion;
    panel.refresh();
  }

  // 設定で ON / OFF が切り替わったら、ボタンとドロワーを出し入れする
  function syncEnabled(): void {
    const on = enabled.get();
    button.hidden = !on;
    if (!on) {
      // 開いていれば閉じ、レッスンの表示も片づける（フォーカスはボタンが隠れるので動かさない）
      state = closeDrawer(state);
      disposePanel();
      chipSeq++;
      chipLesson = undefined;
      renderChip();
      syncView();
    } else {
      // 開いたままのプリセットがあれば、その案内を出す
      refreshChip();
    }
  }
  enabled.subscribe(syncEnabled);

  syncEnabled();
  syncView();

  return { update, open, close };
}
