// 数学の窓のカード: 判定カードのすぐ下に出る、たたんだり開いたりできるカード。
// 中身（式・スライダー）は src/learn の部品で、カードを開くときに初めて読み込む（遅延 import）。
// 式の提供者は、解析の種類を見分けずに登録表（loadMathProvider）から引く。
import type { AnalysisKind } from '../core/types';
import type { Formula, MathProvider } from '../learn/types';
import { loadMathProvider } from '../workbench';
import { clear, h } from './dom';
import { createGate, LEARN_UPDATE_MS, loadMathOpen, resolveMathOpen, resultForLearning, saveMathOpen } from './learn-logic';
import { withLoading } from './lazy';
import type { Runner } from './runner';
import type { Store } from './state';

type MathWindow = { update(formulas: Formula[]): void; dispose(): void };

export interface MathCardHandle {
  /** 毎フレーム呼ぶ。開いていて、前回から間引きの間隔が過ぎたとき（または構造が変わったとき）だけ式を更新する */
  update(): void;
  /** 開く（読み込みが済んだら true） */
  open(): Promise<boolean>;
  /** 開いて、その式のカードまで画面を動かす */
  openFormula(formulaId: string): Promise<void>;
  isOpen(): boolean;
}

export function initMathCard(opts: { store: Store; runner: Runner; host: HTMLElement }): MathCardHandle {
  const { store, runner, host } = opts;
  let saved = loadMathOpen();
  let isOpen = resolveMathOpen({ saved, mode: store.mode });
  let win: MathWindow | null = null;
  let building = false;
  /** 読み込み済みの式の提供者（解析の種類ごと）。null は「この解析には数学の窓がない」 */
  const providers = new Map<string, MathProvider | null>();
  const providerLoading = new Set<string>();
  const gate = createGate(LEARN_UPDATE_MS);
  let force = true;
  let lastVersion = -1;

  const bodyId = 'mathWindowBody';
  const caret = h('span', { class: 'math-caret', 'aria-hidden': 'true' }, '▾');
  const toggle = h(
    'button',
    { type: 'button', class: 'math-toggle', 'aria-controls': bodyId, 'aria-expanded': String(isOpen), onclick: () => setOpen(!isOpen, true) },
    h('span', { class: 'math-title' }, '数学の窓（この答えの式）'),
    caret,
  );
  const body = h('div', { class: 'math-body', id: bodyId });
  const note = h('p', { class: 'hint math-note' });
  const card = h('section', { class: 'card math-card', 'aria-label': '数学の窓' }, toggle, body);
  host.append(card);

  function syncView(): void {
    card.dataset.open = String(isOpen);
    toggle.setAttribute('aria-expanded', String(isOpen));
    body.hidden = !isOpen;
  }

  /** 開閉を変える。remember なら閲覧者ごとの設定として保存する（モードの既定値より優先） */
  function setOpen(next: boolean, remember: boolean): void {
    if (remember) {
      saved = next;
      saveMathOpen(next);
    }
    isOpen = next;
    syncView();
    if (isOpen) {
      force = true;
      void ensureWindow().then(() => update());
    }
  }

  /** 学びモードの部品と、いまの解析の式の提供者を読み込み、数学の窓を作る */
  async function ensureWindow(): Promise<MathWindow | null> {
    if (win) return win;
    if (building) return null;
    building = true;
    try {
      const mod = await withLoading({ label: '数学の窓', task: import('../learn/components') });
      if (!mod) return null;
      if (!win) {
        clear(body);
        win = mod.renderMathWindow({ container: body, formulas: [] });
        body.append(note);
      }
      return win;
    } finally {
      building = false;
    }
  }

  async function ensureProvider(kind: AnalysisKind): Promise<void> {
    if (providers.has(kind) || providerLoading.has(kind)) return;
    providerLoading.add(kind);
    try {
      providers.set(kind, await loadMathProvider(kind));
    } catch (e) {
      console.error(e);
    } finally {
      providerLoading.delete(kind);
    }
    force = true;
  }

  function update(): void {
    if (!isOpen || !win) return;
    const kind = runner.analysis;
    const provider = providers.get(kind);
    if (provider === undefined) {
      void ensureProvider(kind);
      return;
    }
    const changed = runner.resultVersion !== lastVersion;
    if (!force && !changed) return;
    if (!gate.pass(performance.now(), force)) return;
    force = false;
    lastVersion = runner.resultVersion;
    note.textContent = provider ? '' : 'この解析にはまだ数学の窓の式がありません。';
    try {
      win.update(provider ? provider.formulas({ project: store.project, result: resultForLearning(runner) }) : []);
    } catch (e) {
      // 式の組み立てに失敗しても画面全体は止めない
      console.error(e);
    }
  }

  // プロジェクト・タブ・プリセット・モードが変わったら、間引きを待たずに次のフレームで更新する
  for (const ev of ['project', 'load', 'analysis', 'mode'] as const) {
    store.on(ev, (src) => {
      if (ev === 'project' && (src === 'name' || src === 'label')) return;
      force = true;
    });
  }
  // まだ自分で開閉していない人は、モードに合わせて既定を切り替える（かんたんは開く、ほかは閉じる）
  store.on('mode', () => {
    if (saved !== undefined) return;
    const next = resolveMathOpen({ saved, mode: store.mode });
    if (next !== isOpen) setOpen(next, false);
  });

  syncView();
  if (isOpen) void ensureWindow().then(() => update());

  async function open(): Promise<boolean> {
    if (!isOpen) setOpen(true, true);
    await ensureWindow();
    return !!win;
  }

  async function openFormula(formulaId: string): Promise<void> {
    await open();
    force = true;
    // 式の提供者の読み込みと描画を待ってから、その式の位置へ動かす
    for (let i = 0; i < 40; i++) {
      update();
      const el = body.querySelector<HTMLElement>(`[data-formula-id="${CSS.escape(formulaId)}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('math-flash');
        window.setTimeout(() => el.classList.remove('math-flash'), 1600);
        return;
      }
      await new Promise((r) => window.setTimeout(r, 50));
    }
  }

  return { update, open, openFormula, isOpen: () => isOpen };
}
