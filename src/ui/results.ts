// 右パネル上部の「結果」ボックス。状態・スカラー値・注意・表示切り替え・再生ボタン。
import { getWorkbench } from '../workbench';
import { COLORMAP_LABELS, type ColormapName } from './colormap';
import { clear, h } from './dom';
import { formatNumber, formatQuantity } from './format';
import { hasVectorFields } from './render';
import type { Runner } from './runner';
import type { Store } from './state';

const UPDATE_INTERVAL_MS = 120;

export function initResults(store: Store, runner: Runner, host: HTMLElement): { update: () => void } {
  const badge = h('span', { class: 'badge' });
  const statusText = h('span', { class: 'status-text' });
  const bar = h('div', { class: 'progress-bar' });
  const progress = h('div', { class: 'progress' }, bar);
  const msg = h('div', { class: 'status-msg hint' });
  const errorBox = h('div', { class: 'notice error', role: 'alert', hidden: true });
  const hintBox = h('div', { class: 'notice info', hidden: true });
  const warnBox = h('div', { class: 'notice warn', hidden: true });
  const scalars = h('dl', { class: 'scalars adv-only' });

  const play = h('button', { class: 'btn primary', type: 'button', onclick: () => { runner.setRunning(true); refreshButtons(); } }, '再生');
  const pause = h('button', { class: 'btn', type: 'button', onclick: () => { runner.setRunning(false); refreshButtons(); } }, '一時停止');
  const reset = h('button', { class: 'btn', type: 'button', onclick: () => { runner.reset(); refreshButtons(); } }, 'リセット');

  const fieldSel = h('select', { 'aria-label': '表示する量' });
  fieldSel.addEventListener('change', () => {
    store.fieldKeys[store.analysis] = fieldSel.value;
    store.emit('view');
  });
  const cmapSel = h('select', { 'aria-label': 'カラーマップ' }, ...(Object.keys(COLORMAP_LABELS) as ColormapName[]).filter((k) => k !== 'diverging').map((k) => h('option', { value: k }, COLORMAP_LABELS[k])));
  cmapSel.value = store.view.colormap;
  cmapSel.addEventListener('change', () => {
    store.view.colormap = cmapSel.value as ColormapName;
    store.emit('view');
  });

  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void, hint?: string): { root: HTMLElement; input: HTMLInputElement } => {
    const input = h('input', { type: 'checkbox', checked: get() });
    input.addEventListener('change', () => {
      set(input.checked);
      store.emit('view');
    });
    return { root: h('label', { class: 'inline toggle', title: hint }, input, h('span', null, label)), input };
  };
  const smooth = toggle('なめらかに表示', () => store.view.smooth, (v) => (store.view.smooth = v), 'オフにすると、計算セルがそのまま見えます');
  const particles = toggle('流線を動かす', () => store.view.particles, (v) => (store.view.particles = v), '流れに乗って動く粒子を表示します');
  const deform = toggle('変形を強調表示', () => store.view.deform, (v) => (store.view.deform = v), '実際より大きく誇張した変形の輪郭を点線で重ねます');

  host.append(
    h(
      'section',
      { class: 'card results' },
      h('h3', null, '結果'),
      h('div', { class: 'status-row' }, badge, statusText),
      progress,
      msg,
      errorBox,
      hintBox,
      warnBox,
      scalars,
      h('div', { class: 'btn-row' }, play, pause, reset),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, '表示する量'), fieldSel),
      h('label', { class: 'field adv-only' }, h('span', { class: 'field-label' }, '色'), cmapSel),
      h('div', { class: 'toggles adv-only' }, smooth.root, particles.root, deform.root),
    ),
  );

  function refreshButtons(): void {
    play.classList.toggle('active', runner.running);
    pause.classList.toggle('active', !runner.running);
  }

  let fieldKeys = '';
  let lastAt = 0;
  let lastVersion = -1;
  let lastSig = '';

  function setNotice(box: HTMLElement, lines: string[]): void {
    box.hidden = lines.length === 0;
    clear(box);
    for (const l of lines) box.append(h('p', null, l));
  }

  function update(): void {
    const now = performance.now();
    const sig = `${runner.running}|${store.analysis}|${runner.error}`;
    if (runner.resultVersion === lastVersion && sig === lastSig) return;
    if (now - lastAt < UPDATE_INTERVAL_MS && sig === lastSig) return;
    lastAt = now;
    lastVersion = runner.resultVersion;
    lastSig = sig;

    const r = runner.result;
    const st = runner.status;
    refreshButtons();

    // 状態
    let kind = 'run';
    let label = '計算中';
    if (runner.error) {
      kind = 'err';
      label = 'エラー';
    } else if (st?.done) {
      kind = 'done';
      label = '収束しました';
    } else if (!runner.running) {
      kind = 'pause';
      label = '一時停止中';
    } else if (!st) {
      label = '準備中';
    }
    badge.className = `badge ${kind}`;
    badge.textContent = label;
    const parts: string[] = [];
    if (st) {
      parts.push(`反復 ${st.iteration.toLocaleString('ja-JP')} 回`);
      if (st.residual !== undefined && Number.isFinite(st.residual)) parts.push(`残差 ${formatNumber(st.residual, 2)}`);
    }
    statusText.textContent = parts.join(' ・ ');
    bar.style.width = `${Math.round((st?.done ? 1 : Math.min(1, Math.max(0, st?.progress ?? 0))) * 100)}%`;
    progress.hidden = !st;
    msg.textContent = st?.message ?? '';
    msg.hidden = !st?.message;

    setNotice(errorBox, runner.error ? [runner.error] : []);
    setNotice(hintBox, runner.hints);
    setNotice(warnBox, r?.warnings ?? []);

    // スカラー値
    clear(scalars);
    for (const s of r?.scalars ?? []) {
      scalars.append(h('dt', null, s.label), h('dd', null, formatQuantity(s.value, s.unit)));
    }
    scalars.hidden = !r || r.scalars.length === 0;

    // フィールド選択（候補が変わったときだけ作り直す）
    const keys = (r?.fields ?? []).map((f) => f.key).join(',');
    if (keys !== fieldKeys) {
      fieldKeys = keys;
      clear(fieldSel);
      for (const f of r?.fields ?? []) fieldSel.append(h('option', { value: f.key }, f.unit ? `${f.label} [${f.unit}]` : f.label));
    }
    const cur = runner.currentField();
    if (cur) fieldSel.value = cur.key;
    fieldSel.disabled = !r || r.fields.length === 0;

    const vec = hasVectorFields(r);
    const traits = getWorkbench(store.analysis)?.viewTraits;
    particles.root.hidden = !(traits?.particles && vec);
    deform.root.hidden = !(traits?.deform && vec);
  }

  store.on('analysis', () => {
    lastVersion = -1;
  });
  refreshButtons();
  return { update };
}
