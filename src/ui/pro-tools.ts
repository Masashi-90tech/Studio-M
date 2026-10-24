// プロ専用ツール: プローブ表・断面グラフ・生データ出力・ソルバーログ。
// ツールレールの「プローブ」「断面」でキャンバスに置いた位置は UI の状態で、プロジェクトには保存しない。
import type { Field } from '../core/types';
import { clear, h, toast } from './dom';
import { saveCsv, saveVtk } from './export-raw';
import { formatNumber, formatQuantity } from './format';
import type { Pt } from './geometry';
import { drawProfile } from './linechart';
import { plainNumber } from './panel-kit';
import { ProState, MAX_PROBES, sampleNearest, sectionProfile } from './probes';
import { safeFileName } from './project-utils';
import type { CanvasView } from './render';
import type { Runner } from './runner';
import type { Store } from './state';

const MM = 1000;
const LOG_LINES = 80;

export function initProTools(store: Store, runner: Runner, view: CanvasView, state: ProState, host: HTMLElement): { update: () => void } {
  const canvas = view.canvas;

  // ---------- キャンバス上の操作 ----------

  const inside = (w: Pt): boolean => w[0] >= 0 && w[1] >= 0 && w[0] <= store.project.domain.width && w[1] <= store.project.domain.height;
  let drawing: { a: Pt } | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (store.mode !== 'pro') return;
    const w = view.toWorld(e.clientX, e.clientY, store.project.domain);
    if (store.tool === 'probe') {
      if (!inside(w)) return;
      if (!state.addProbe(w[0], w[1])) toast(`プローブは ${MAX_PROBES} 個までです。不要なものを削除してください`, 'error');
    } else if (store.tool === 'section') {
      if (!inside(w)) return;
      drawing = { a: w };
      canvas.setPointerCapture(e.pointerId);
      state.setSection(w, w);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const dom = store.project.domain;
    const w = view.toWorld(e.clientX, e.clientY, dom);
    state.setSection(drawing.a, [Math.min(dom.width, Math.max(0, w[0])), Math.min(dom.height, Math.max(0, w[1]))]);
  });
  const finish = (e: PointerEvent): void => {
    if (!drawing) return;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    const s = state.section;
    drawing = null;
    // クリックだけで線にならなかったときは消す
    if (s && Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) < view.pxToWorld(6, store.project.domain)) {
      state.clearSection();
      toast('ドラッグして線を引いてください');
    }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  // 位置が変わったらキャンバスを描き直す。プロジェクトが入れ替わったら位置も消す
  state.on(() => (view.invalid = true));
  store.on('load', () => state.clearAll());

  // ---------- パネル ----------

  const probeBody = h('tbody');
  const probeTable = h(
    'table',
    { class: 'probe-table' },
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'x, y [mm]'), h('th', null, '値'), h('th', null, h('span', { class: 'sr-only' }, '削除')))),
    probeBody,
  );
  const probeEmpty = h('p', { class: 'hint' }, 'ツールレールの「プローブ」を選んでキャンバスをクリックすると、その点の値がここに出ます。座標を入力して追加もできます。');
  const px = plainNumber({ label: 'x', unit: 'mm', value: 0, onChange: () => undefined });
  const py = plainNumber({ label: 'y', unit: 'mm', value: 0, onChange: () => undefined });
  const addBtn = h('button', { class: 'btn small', type: 'button', onclick: () => {
    const x = parseFloat(px.input.value) / MM;
    const y = parseFloat(py.input.value) / MM;
    const dom = store.project.domain;
    if (!(x >= 0 && y >= 0 && x <= dom.width && y <= dom.height)) {
      toast('解析範囲の中の座標を入力してください', 'error');
      return;
    }
    if (!state.addProbe(x, y)) toast(`プローブは ${MAX_PROBES} 個までです`, 'error');
  } }, '追加');
  const clearProbes = h('button', { class: 'btn small', type: 'button', onclick: () => state.clearProbes() }, 'すべて消す');

  const chartCanvas = h('canvas', { class: 'chart', 'aria-label': '断面グラフ', role: 'img' });
  const chartInfo = h('p', { class: 'hint' });
  const clearSection = h('button', { class: 'btn small', type: 'button', onclick: () => state.clearSection() }, '線を消す');

  const secInputs = (['ax', 'ay', 'bx', 'by'] as const).map((k) =>
    plainNumber({ label: k === 'ax' ? 'A の x' : k === 'ay' ? 'A の y' : k === 'bx' ? 'B の x' : 'B の y', unit: 'mm', value: 0, onChange: () => undefined }),
  );
  const applySection = h('button', { class: 'btn small', type: 'button', onclick: () => {
    const [ax, ay, bx, by] = secInputs.map((f) => parseFloat(f.input.value) / MM);
    const dom = store.project.domain;
    const ok = [ax, ay, bx, by].every(Number.isFinite) && [ax, bx].every((v) => v >= 0 && v <= dom.width) && [ay, by].every((v) => v >= 0 && v <= dom.height);
    if (!ok || Math.hypot(bx - ax, by - ay) <= 0) {
      toast('解析範囲の中で、長さのある線を指定してください', 'error');
      return;
    }
    state.setSection([ax, ay], [bx, by]);
  } }, '座標から線を引く');

  const csvBtn = h('button', { class: 'btn small', type: 'button', onclick: () => {
    const r = runner.result;
    const f = runner.currentField();
    if (!r || !f) return toast('まだ結果がありません', 'error');
    saveCsv(r, f, safeFileName(store.project.name));
    toast(`${f.label} を CSV にしました`);
  } }, 'CSV（表計算用）');
  const vtkBtn = h('button', { class: 'btn small', type: 'button', onclick: () => {
    const r = runner.result;
    if (!r || r.fields.length === 0) return toast('まだ結果がありません', 'error');
    saveVtk(r, safeFileName(store.project.name));
    toast('VTK ファイルを書き出しました（ParaView で開けます）');
  } }, 'VTK（ParaView 用）');

  const logPre = h('pre', { class: 'log', tabindex: '0', 'aria-label': '反復と残差の記録' });
  const gridInfo = h('p', { class: 'hint' });

  host.append(
    h(
      'section',
      { class: 'card pro-tools' },
      h('h3', null, 'プロの測定'),
      h('h4', null, 'プローブ（点の値）'),
      probeEmpty,
      probeTable,
      h('div', { class: 'row2 coord-add' }, px.root, py.root),
      h('div', { class: 'btn-row' }, addBtn, clearProbes),
      h('h4', null, '断面グラフ（線に沿った値）'),
      h('p', { class: 'hint' }, 'ツールレールの「断面」でキャンバス上をドラッグすると線が引けます。'),
      chartCanvas,
      chartInfo,
      h('div', { class: 'row2 coord-add' }, ...secInputs.map((f) => f.root)),
      h('div', { class: 'btn-row' }, applySection, clearSection),
      h('h4', null, '生データ出力'),
      h('div', { class: 'btn-row' }, csvBtn, vtkBtn),
      h('p', { class: 'hint' }, 'CSV は現在の表示量を i, j, x[mm], y[mm], 値 で出力します。VTK は全ての量を入れます。'),
      h('details', { class: 'log-box' }, h('summary', null, 'ソルバーのログ'), gridInfo, logPre),
    ),
  );

  // ---------- 更新 ----------

  let rowsSig = '';
  let valueCells: HTMLElement[] = [];
  let lastVersion = -1;
  let lastFieldKey = '';
  let lastAt = 0;
  let lastLog = -1;

  function buildRows(): void {
    clear(probeBody);
    valueCells = [];
    state.probes.forEach((pr, idx) => {
      const x = plainNumber({ label: '', value: Number((pr.x * MM).toPrecision(5)), onChange: (v) => state.moveProbe(pr.id, v / MM, pr.y) });
      const y = plainNumber({ label: '', value: Number((pr.y * MM).toPrecision(5)), onChange: (v) => state.moveProbe(pr.id, pr.x, v / MM) });
      x.input.setAttribute('aria-label', `プローブ ${idx + 1} の x [mm]`);
      y.input.setAttribute('aria-label', `プローブ ${idx + 1} の y [mm]`);
      const val = h('td', { class: 'probe-val' }, '—');
      valueCells.push(val);
      probeBody.append(
        h(
          'tr',
          null,
          h('td', null, String(idx + 1)),
          h('td', { class: 'probe-xy' }, x.input, y.input),
          val,
          h('td', null, h('button', { class: 'btn small danger', type: 'button', 'aria-label': `プローブ ${idx + 1} を削除`, onclick: () => state.removeProbe(pr.id) }, '×')),
        ),
      );
    });
    probeTable.hidden = state.probes.length === 0;
    probeEmpty.hidden = state.probes.length > 0;
    clearProbes.hidden = state.probes.length === 0;
  }

  function fieldNow(): Field | null {
    return runner.currentField();
  }

  function updateValues(): void {
    const r = runner.result;
    const f = fieldNow();
    state.probes.forEach((pr, i) => {
      const v = r && f ? sampleNearest(r, f, pr.x, pr.y) : null;
      const cell = valueCells[i];
      if (cell) cell.textContent = v === null || !f ? '—（値なし）' : formatQuantity(v, f.unit);
    });
  }

  function updateChart(): void {
    const r = runner.result;
    const f = fieldNow();
    const s = state.section;
    chartCanvas.hidden = !s;
    chartInfo.hidden = !s;
    clearSection.hidden = !s;
    if (!s) return;
    if (!r || !f) {
      chartInfo.textContent = '結果を待っています';
      return;
    }
    const prof = sectionProfile(r, f, s.a, s.b);
    drawProfile(chartCanvas, prof, { label: f.label, unit: f.unit });
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    chartInfo.textContent = `A (${formatNumber(s.a[0] * MM, 4)}, ${formatNumber(s.a[1] * MM, 4)}) → B (${formatNumber(s.b[0] * MM, 4)}, ${formatNumber(s.b[1] * MM, 4)}) mm、長さ ${formatQuantity(len, 'm')}`;
    const [a, b] = [s.a, s.b];
    secInputs[0].set(a[0] * MM);
    secInputs[1].set(a[1] * MM);
    secInputs[2].set(b[0] * MM);
    secInputs[3].set(b[1] * MM);
  }

  function updateLog(): void {
    const g = runner.grid;
    gridInfo.textContent = g ? `格子 ${g.nx} × ${g.ny}、1セル ${formatQuantity(g.h, 'm')}（${g.reason}）` : '';
    const n = runner.log.length;
    if (n === lastLog) return;
    lastLog = n;
    const rows = runner.log.slice(-LOG_LINES).map((l) => {
      const res = l.residual !== undefined && Number.isFinite(l.residual) ? formatNumber(l.residual, 3) : '—';
      return `${String(l.iteration).padStart(8)}  残差 ${res.padEnd(10)}  進捗 ${String(Math.round(l.progress * 100)).padStart(3)}%`;
    });
    logPre.textContent = rows.length > 0 ? rows.join('\n') : 'まだ記録がありません';
    logPre.scrollTop = logPre.scrollHeight;
  }

  // 位置の編集中は表を作り直さない（入力欄のフォーカスを保つ）。追加・削除は id の並びで気づく
  state.on(() => {
    lastVersion = -1;
  });
  store.on('analysis', () => (lastVersion = -1));
  store.on('view', () => (lastVersion = -1));
  buildRows();

  return {
    update(): void {
      host.hidden = store.mode !== 'pro';
      if (store.mode !== 'pro') return;
      const sig = state.probes.map((p) => `${p.id}`).join(',');
      if (sig !== rowsSig) {
        rowsSig = sig;
        buildRows();
      }
      const now = performance.now();
      const f = fieldNow();
      const key = `${runner.generation}|${f?.key}`;
      if (runner.resultVersion === lastVersion && key === lastFieldKey) return;
      if (now - lastAt < 120) return;
      lastAt = now;
      lastVersion = runner.resultVersion;
      lastFieldKey = key;
      updateValues();
      updateChart();
      updateLog();
    },
  };
}
