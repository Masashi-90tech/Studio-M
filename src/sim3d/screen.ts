// 3D 解析の画面（全画面のオーバーレイ）。左に 3D ビュー、右に設定と結果のパネル。閉じると 2D の画面に戻る（2D の状態には触れない）。
// 画面（ハーネス）からは、このファイルを使うときに遅延 import すること（src/ui/sim3d-open.ts が入口）。
import './sim3d.css';
import type { Solver3DFactory, Study3D } from '../core/types';
import { h } from '../ui/dom';
import { Sim3DModel } from './model';
import { createLegend, createPanel } from './panel';
import { Sim3DRunner, loadHeat3DSolver } from './runner';
import { createSceneView } from './view';

export interface Sim3DOptions {
  study: Study3D;
  /** 取り込みで気づいたこと（穴のあるモデルなど）。パネルの先頭に出す */
  warnings?: string[];
  /** 閉じたとき */
  onClose?: () => void;
  /** ソルバーの読み込み。省略時は Lite の 3D の熱（テストや、将来のエンジン連携で差し替える） */
  loadSolver?: () => Promise<Solver3DFactory | null>;
}

export interface Sim3DHandle {
  close(): void;
  model: Sim3DModel;
}

/** 3D 解析の画面を開く */
export function openSim3D(opts: Sim3DOptions): Sim3DHandle {
  const prevFocus = document.activeElement as HTMLElement | null;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#e8590c';

  const model = new Sim3DModel(opts.study, { warnings: opts.warnings });
  const runner = new Sim3DRunner(model, opts.loadSolver ?? loadHeat3DSolver);
  const panel = createPanel({ model, runner });
  const legend = createLegend(model);
  let closed = false;

  // ---------- DOM ----------
  const titleId = 's3d-title';
  const closeBtn = h('button', { type: 'button', class: 'btn s3d-close', 'aria-label': '閉じる（Esc）', title: '閉じる（Esc）', onClick: () => close() }, '×');
  const head = h(
    'div',
    { class: 's3d-head' },
    h('h2', { id: titleId }, '3D 解析（熱）'),
    h('span', { class: 's3d-title-name', title: opts.study.source ?? opts.study.name }, opts.study.name),
    closeBtn,
  );
  const viewHost = h('div', { class: 's3d-view' });
  const hint = h('div', { class: 's3d-hint' }, '面をクリックで選択（Shift / Ctrl で追加）・ドラッグで回転・ホイールで拡大縮小');
  const clearSel = h('button', { type: 'button', class: 'btn small', onClick: () => model.clearSelection() }, '選択を解除');
  const resetView = h('button', { type: 'button', class: 'btn small', onClick: () => scene?.resetView() }, '視点を戻す');
  const toolbar = h('div', { class: 's3d-toolbar' }, hint, h('span', { class: 's3d-spacer' }), clearSel, resetView);
  const stage = h('div', { class: 's3d-stage' }, viewHost, legend.root);
  const viewCol = h('div', { class: 's3d-view-col' }, toolbar, stage);
  const side = h('aside', { class: 's3d-panel', 'aria-label': '設定と結果' }, panel.root);
  const root = h('div', { class: 's3d-root', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, head, h('div', { class: 's3d-body' }, viewCol, side));
  document.body.append(root);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  // ---------- 3D ビュー ----------
  const sv = createSceneView({ host: viewHost, model, accent, background: '#f7f5f1' });
  let scene: Extract<typeof sv, { view: unknown }>['view'] | null = null;
  if ('error' in sv) {
    viewHost.append(h('div', { class: 's3d-message' }, sv.error));
    for (const el of [clearSel, resetView]) el.disabled = true;
  } else {
    scene = sv.view;
  }

  const syncToolbar = (): void => {
    clearSel.disabled = model.selection.size === 0;
  };
  syncToolbar();
  legend.refresh();

  const off = model.subscribe((e) => {
    panel.refresh(e);
    scene?.refresh(e);
    if (e === 'selection') syncToolbar();
    if (e === 'result' || e === 'study' || e === 'view') legend.refresh();
  });

  // ---------- キーボード: Esc で閉じる。Tab は画面の中でぐるぐる回す ----------
  const focusables = (): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('button, input, select, canvas[tabindex], [tabindex]')).filter(
      (el) => !(el as HTMLButtonElement).disabled && !el.hidden && el.tabIndex >= 0 && el.getClientRects().length > 0,
    );
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // 入力欄の編集を止めるだけの Esc ではなく、画面を閉じる
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    // 下の 2D の画面のショートカット（Delete など）を動かさない
    if (!root.contains(e.target as Node | null)) e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('keydown', (e) => e.stopPropagation());
  const onResize = (): void => scene?.resize();
  window.addEventListener('resize', onResize);

  function close(): void {
    if (closed) return;
    closed = true;
    off();
    runner.dispose();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    scene?.dispose();
    document.body.style.overflow = prevOverflow;
    root.remove();
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
    opts.onClose?.();
  }

  closeBtn.focus();
  return { close, model };
}
