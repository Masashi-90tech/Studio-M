// 結果の先頭に出す「判定カード」: OK / 注意 / NG と、かんたんモードの次の一手ボタン。
// 判定の中身と次の一手の反映は、解析ごとのワークベンチ（WorkbenchModule.verdict / applyAction）が受け持つ。
import { getWorkbench } from '../workbench';
import type { Verdict, VerdictAction } from '../workbench/types';
import { clear, h, toast } from './dom';
import type { Runner } from './runner';
import type { Store } from './state';

const MARKS = { ok: '✓', warn: '!', ng: '✕', info: 'i', pending: '…' } as const;
const UPDATE_INTERVAL_MS = 150;

/** 次の一手をプロジェクトに反映する（元に戻せる） */
export function applyAction(store: Store, a: VerdictAction): void {
  const wb = getWorkbench(store.analysis);
  if (!wb?.applyAction) return;
  store.checkpoint(`verdict:${a.kind}`);
  wb.applyAction({ project: store.project, action: a, selectShape: (id) => store.select(id) });
  store.touch('settings');
  toast(`「${a.label}」を適用しました（元に戻すボタンで戻せます）`);
}

export function initVerdictCard(store: Store, runner: Runner, host: HTMLElement): { update: () => void } {
  let sig = '';
  let lastAt = 0;
  let lastVersion = -1;
  let lastMode = '';

  function render(v: Verdict | null, title: string): void {
    clear(host);
    if (!v) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const card = h(
      'section',
      { class: `card verdict ${v.level}`, role: 'status', 'aria-live': 'polite', 'aria-label': title },
      h('div', { class: 'verdict-top' }, h('span', { class: 'vchip' }, h('span', { 'aria-hidden': 'true' }, MARKS[v.level]), ` ${v.chip}`), h('span', { class: 'vtitle' }, title)),
      h('p', { class: 'verdict-head' }, v.headline),
    );
    if (v.lines.length > 0) card.append(h('ul', { class: 'verdict-lines' }, ...v.lines.map((l) => h('li', null, l))));
    if (store.mode === 'easy' && v.actions.length > 0) {
      card.append(
        h(
          'div',
          { class: 'verdict-actions' },
          h('span', { class: 'hint' }, '次の一手'),
          h('div', { class: 'btn-row' }, ...v.actions.map((a) => h('button', { class: 'btn small', type: 'button', onclick: () => applyAction(store, a) }, a.label))),
        ),
      );
    }
    host.append(card);
  }

  function update(): void {
    const now = performance.now();
    if (runner.resultVersion === lastVersion && store.mode === lastMode) return;
    if (now - lastAt < UPDATE_INTERVAL_MS && store.mode === lastMode) return;
    lastAt = now;
    lastVersion = runner.resultVersion;
    lastMode = store.mode;
    const kind = runner.analysis;
    const wb = getWorkbench(kind);
    const v = runner.error
      ? null
      : (wb?.verdict?.({
          kind,
          project: runner.resolved ?? store.project,
          result: runner.result,
          status: runner.status,
          raster: runner.shownRaster,
          prefs: store.prefs,
        }) ?? null);
    const next = v ? `${kind}|${store.mode}|${v.level}|${v.headline}|${v.lines.join('/')}|${v.actions.map((a) => a.label).join('/')}` : `${kind}|none`;
    if (next === sig) return;
    sig = next;
    render(v, wb?.verdictTitle ?? '');
  }

  store.on('analysis', () => {
    sig = '';
    lastVersion = -1;
  });
  store.on('view', () => {
    sig = '';
    lastVersion = -1;
  });
  store.on('project', () => {
    lastVersion = -1;
  });
  host.hidden = true;
  return { update };
}
