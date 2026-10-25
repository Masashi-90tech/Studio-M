// 「KiCad 基板を開く」ダイアログ。.kicad_pcb を読み、プレビューと部品の表を見ながら熱プロジェクトにする。
// ファイルはブラウザの中だけで処理する（通信しない）。読み取りは kicad.ts、組み立ては build.ts。
// 画面（ハーネス）からは、このファイルを使うときに遅延 import すること。
import './import-dialog.css';
import type { AnalysisKind, Project } from '../core/types';
import { h, numField, toast } from '../ui/dom';
import { buildPcbProject, type BuildResult, type PartAssignment, type PartOverride } from './build';
import { KicadParseError, parseKicadPcb, type KicadBoard } from './kicad';
import { drawPreview, hitPart, layerColor, previewHeight, type PreviewView } from './preview';

export interface PcbImportResult {
  project: Project;
  /** 取り込んだあとに開く解析（熱）。画面は解析の名前を直接書かず、これを使う */
  analysis: AnalysisKind;
  /** 取り込みで気づいたこと（外形の隙間、ライブラリにない部品、格子の説明など） */
  warnings: string[];
}

export interface PcbImportOptions {
  onImport: (result: PcbImportResult) => void;
  /** 最初から読み込むファイル（画面へのドロップなどで渡す）。省略時は選んでもらう */
  file?: File;
}

const COOLING: { value: string; label: string }[] = [
  { value: '7', label: '自然放置（h = 7）' },
  { value: '25', label: '小型ファン（h = 25）' },
  { value: '60', label: '強いファン（h = 60）' },
];

const round2 = (v: number): string => String(Math.round(v * 100) / 100);

/** ダイアログを開く。戻り値は閉じる関数 */
export function openPcbImport(opts: PcbImportOptions): () => void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const css = getComputedStyle(document.documentElement);
  const colors = {
    accent: css.getPropertyValue('--accent').trim() || '#e8590c',
    blue: css.getPropertyValue('--blue').trim() || '#2563eb',
    ink: css.getPropertyValue('--ink').trim() || '#26221c',
    muted: css.getPropertyValue('--muted').trim() || '#6b6459',
  };

  // ---------- 状態 ----------
  let board: KicadBoard | null = null;
  let fileName = '';
  let built: BuildResult | null = null;
  let view: PreviewView | null = null;
  let selectedKey: string | null = null;
  let closed = false;
  const overrides: Record<string, PartOverride> = {};
  const visible = new Set<string>();
  const quiet = new Set<string>(); // 最初は目立たせない行（発熱しない・ライブラリにない部品）
  const settings = { boardThicknessMm: 1.6, copperThicknessUm: 35, ambientC: 25, surfaceH: 7 };
  const rows = new Map<string, { root: HTMLElement; use: HTMLInputElement; w: HTMLInputElement; t: HTMLInputElement }>();

  // ---------- DOM ----------
  const titleId = 'pcb-title';
  const fileInput = h('input', { type: 'file', accept: '.kicad_pcb,.txt', hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
  const pickBtn = h('button', { type: 'button', class: 'btn primary', onClick: () => fileInput.click() }, '基板ファイルを選ぶ…');
  const fileNameEl = h('span', { class: 'pcb-file-name' }, '');
  const canvas = h('canvas', { class: 'pcb-canvas', hidden: true, role: 'img', 'aria-label': '取り込む基板のプレビュー。部品をクリックすると右の表で選ばれます' });
  const empty = h(
    'div',
    { class: 'pcb-empty' },
    h('strong', null, '.kicad_pcb ファイルをここにドロップ'),
    h('span', null, 'または「基板ファイルを選ぶ」。KiCad で保存した基板ファイルです（ゾーンは塗りつぶしてから保存してください）'),
    h('button', { type: 'button', class: 'btn', onClick: () => void loadSample() }, 'サンプル基板で試す'),
    h('span', { class: 'pcb-sample-note' }, 'ESP32 とモータードライバーを載せた手書きの例です。手元に基板がなくても、使い方を確かめられます'),
  );
  const stage = h('div', { class: 'pcb-stage' }, empty, canvas);
  const chips = h('div', { class: 'pcb-chips', role: 'group', 'aria-label': '表示する銅箔の層' });
  const summary = h('div', { class: 'readout pcb-summary', role: 'status', 'aria-live': 'polite' }, '基板ファイルを読み込むと、ここに結果が出ます');
  const warnEl = h('div', { class: 'pcb-warn', hidden: true, role: 'status' });
  const totalEl = h('div', { class: 'pcb-total', 'aria-live': 'polite' }, '');
  const list = h('div', { class: 'pcb-parts', role: 'list' });
  const showAll = h('input', { type: 'checkbox' });
  showAll.addEventListener('change', () => list.classList.toggle('all', showAll.checked));
  const quietNote = h('span', { class: 'pcb-quiet-note' }, '');

  const thick = numField({ label: '基板の厚さ', unit: 'mm', value: settings.boardThicknessMm, min: 0.2, max: 6, step: 0.1, digits: 2, hint: '普通は 1.6', onChange: (v) => { settings.boardThicknessMm = v; rebuild(); } });
  const cuT = numField({ label: '銅箔の厚さ', unit: 'µm', value: settings.copperThicknessUm, min: 5, max: 400, step: 1, digits: 1, hint: '1oz = 35、2oz = 70（全層に同じ値）', onChange: (v) => { settings.copperThicknessUm = v; rebuild(); } });
  const amb = numField({ label: '周囲の温度', unit: '°C', value: settings.ambientC, min: -40, max: 150, step: 1, digits: 1, onChange: (v) => { settings.ambientC = v; rebuild(); } });
  const coolSelect = h('select', { 'aria-label': '冷却' }, ...COOLING.map((c) => h('option', { value: c.value }, c.label)));
  coolSelect.value = String(settings.surfaceH);
  coolSelect.addEventListener('change', () => {
    settings.surfaceH = Number(coolSelect.value);
    rebuild();
  });
  const coolField = h('label', { class: 'field' }, h('span', { class: 'field-label' }, '冷却'), coolSelect, h('span', { class: 'hint' }, '基板の表面から空気へ熱が逃げやすいほど、数字（熱伝達率 h）が大きくなります'));

  const importBtn = h('button', { type: 'button', class: 'btn primary', disabled: true, onClick: () => doImport() }, '取り込む');
  const cancelBtn = h('button', { type: 'button', class: 'btn', onClick: () => close() }, 'キャンセル');
  const closeBtn = h('button', { type: 'button', class: 'btn pcb-close', 'aria-label': '閉じる', onClick: () => close() }, '×');

  const left = h(
    'div',
    { class: 'pcb-col' },
    h('p', { class: 'pcb-hint' }, '基板の形・銅箔・部品の位置を取り込み、部品ごとの発熱から基板の温度を調べます。発熱は目安の値なので、自分の回路に合わせて直してください'),
    stage,
    h('div', { class: 'pcb-file-row' }, pickBtn, fileNameEl),
    chips,
    summary,
    warnEl,
  );
  const right = h(
    'div',
    { class: 'pcb-col' },
    h('h3', { class: 'pcb-h' }, '条件'),
    h('div', { class: 'pcb-inline' }, thick.root, cuT.root),
    h('div', { class: 'pcb-inline' }, amb.root, coolField),
    h('h3', { class: 'pcb-h' }, '部品の発熱'),
    h('p', { class: 'pcb-hint' }, 'ライブラリの値は「だいたいこのくらい」の目安です。チェックを外すと熱源にしません。数字は書き換えられます'),
    h('label', { class: 'pcb-toggle' }, showAll, h('span', null, '発熱しない部品・ライブラリにない部品も表示'), quietNote),
    totalEl,
    list,
  );
  const dialog = h(
    'div',
    { class: 'pcb-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'pcb-head' }, h('h2', { id: titleId }, 'KiCad 基板を開く'), closeBtn),
    h('div', { class: 'pcb-body' }, left, right),
    h('div', { class: 'pcb-foot' }, cancelBtn, importBtn),
    fileInput,
  );
  const backdrop = h('div', { class: 'pcb-backdrop' }, dialog);
  document.body.append(backdrop);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  // ---------- 部品の表 ----------
  function numInput(label: string, value: number, step: string, min: number, onValid: (v: number) => void): HTMLInputElement {
    const input = h('input', { type: 'number', inputmode: 'decimal', step, min: String(min), value: round2(value), 'aria-label': label });
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      const ok = Number.isFinite(v) && v >= min;
      input.classList.toggle('invalid', !ok && input.value !== '');
      if (ok) onValid(v);
    });
    input.addEventListener('change', () => input.classList.remove('invalid'));
    return input;
  }

  function buildRows(parts: PartAssignment[]): void {
    list.replaceChildren();
    rows.clear();
    quiet.clear();
    // 発熱する部品を上に、それ以外を下に（同じ中では W の大きい順）
    const sorted = [...parts].sort((a, b) => Number(b.included) - Number(a.included) || b.watts - a.watts);
    for (const p of sorted) {
      if (!p.included) quiet.add(p.key);
      const use = h('input', { type: 'checkbox', checked: p.included, 'aria-label': `${p.ref} を熱源にする` });
      const w = numInput(`${p.ref} の発熱（ワット）`, p.watts, '0.01', 0, (v) => {
        (overrides[p.key] ??= {}).watts = v;
        // 発熱を入れたら、熱源として入れる
        if (v > 0 && !current(p.key)?.included) overrides[p.key].included = true;
        rebuild();
      });
      const t = numInput(`${p.ref} の上限温度（度）`, p.maxTempC, '5', 1, (v) => {
        (overrides[p.key] ??= {}).maxTempC = v;
        rebuild();
      });
      use.addEventListener('change', () => {
        (overrides[p.key] ??= {}).included = use.checked;
        rebuild();
      });
      const root = h(
        'div',
        { class: 'pcb-part', role: 'listitem', 'data-key': p.key },
        h('label', { class: 'pcb-part-main' }, use, h('strong', null, p.ref), h('span', { class: 'pcb-val' }, p.value), p.side === 'back' ? h('span', { class: 'pcb-tag' }, '裏') : null),
        h('span', { class: `pcb-kind${p.matched ? '' : ' unknown'}` }, p.partLabel),
        h('div', { class: 'pcb-nums' }, h('label', null, '発熱 ', w, ' W'), h('label', null, '上限 ', t, ' °C')),
        p.note ? h('div', { class: 'pcb-note' }, p.note) : null,
      );
      root.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('input, label')) return;
        select(p.key, false);
      });
      rows.set(p.key, { root, use, w, t });
      list.append(root);
    }
  }

  const current = (key: string): PartAssignment | undefined => built?.parts.find((p) => p.key === key);

  function updateRows(): void {
    if (!built) return;
    let hidden = 0;
    for (const p of built.parts) {
      const r = rows.get(p.key);
      if (!r) continue;
      r.use.checked = p.included;
      r.root.classList.toggle('off', !p.included);
      r.root.classList.toggle('quiet', quiet.has(p.key) && !overrides[p.key]);
      r.root.classList.toggle('sel', p.key === selectedKey);
      // 入力中の欄は上書きしない
      if (document.activeElement !== r.w) r.w.value = round2(p.watts);
      if (document.activeElement !== r.t) r.t.value = round2(p.maxTempC);
      if (quiet.has(p.key) && !overrides[p.key]) hidden++;
    }
    quietNote.textContent = hidden > 0 ? `（他に ${hidden} 個）` : '';
  }

  function select(key: string | null, scroll: boolean): void {
    selectedKey = key;
    const r = key ? rows.get(key) : null;
    if (r) {
      r.root.classList.add('peek');
      if (scroll) r.root.scrollIntoView({ block: 'nearest' });
    }
    for (const [k, row] of rows) if (k !== key) row.root.classList.remove('peek');
    updateRows();
    draw();
  }

  // ---------- 計算と表示 ----------
  function rebuild(): void {
    if (!board) return;
    built = buildPcbProject({
      board,
      fileName,
      overrides,
      boardThicknessMm: settings.boardThicknessMm,
      copperThicknessUm: settings.copperThicknessUm,
      ambientC: settings.ambientC,
      surfaceH: settings.surfaceH,
    });
    updateRows();
    updateInfo();
    draw();
  }

  function updateInfo(): void {
    if (!board || !built) return;
    const wMm = (board.bbox.x1 - board.bbox.x0) * 1e3;
    const hMm = (board.bbox.y1 - board.bbox.y0) * 1e3;
    const on = built.parts.filter((p) => p.included);
    const total = on.reduce((s, p) => s + p.watts, 0);
    summary.textContent = `基板 ${round2(wMm)} × ${round2(hMm)} mm・銅箔 ${board.layers.length} 層・部品 ${built.parts.length} 個・切り抜き ${board.holes.length} 個`;
    totalEl.textContent = `熱源 ${on.length} 個・発熱の合計 ${round2(total)} W`;
    const lines = built.warnings;
    warnEl.hidden = lines.length === 0;
    warnEl.replaceChildren(...lines.map((w) => h('div', null, w)));
    importBtn.disabled = on.length === 0;
  }

  function draw(): void {
    if (!board || !built) return;
    const w = Math.max(240, stage.clientWidth - 2);
    const maxH = Math.max(220, Math.round(window.innerHeight * 0.5));
    view = drawPreview(canvas, { board, parts: built.parts, visibleLayers: visible, selectedKey, colors }, w, previewHeight(board, w, maxH));
  }

  function setBoard(b: KicadBoard, name: string): void {
    board = b;
    fileName = name;
    for (const k of Object.keys(overrides)) delete overrides[k];
    visible.clear();
    b.layers.forEach((l) => visible.add(l.name));
    selectedKey = null;
    settings.boardThicknessMm = b.thicknessMm;
    settings.copperThicknessUm = b.layers[0]?.thicknessUm ?? 35;
    thick.set(settings.boardThicknessMm);
    cuT.set(settings.copperThicknessUm);
    chips.replaceChildren(
      ...b.layers.map((l) => {
        const input = h('input', { type: 'checkbox', checked: true, 'aria-label': `${l.name} を表示` });
        input.addEventListener('change', () => {
          if (input.checked) visible.add(l.name);
          else visible.delete(l.name);
          draw();
        });
        return h('label', { class: 'pcb-chip' }, input, h('span', { class: 'pcb-swatch', style: `background:${layerColor(l.name)}` }), h('span', null, l.name));
      }),
    );
    fileNameEl.textContent = name;
    empty.hidden = true;
    canvas.hidden = false;
    stage.classList.add('has-board');
    built = buildPcbProject({ board: b, fileName: name, boardThicknessMm: settings.boardThicknessMm, copperThicknessUm: settings.copperThicknessUm, surfaceH: settings.surfaceH });
    buildRows(built.parts);
    rebuild();
  }

  // ---------- ファイルの読み込み ----------
  async function loadFile(file: File): Promise<void> {
    await loadText(file.name, () => file.text());
  }

  /** 同梱のサンプル基板（手書きの .kicad_pcb）。使うときに初めて読み込む（Vite の ?raw） */
  async function loadSample(): Promise<void> {
    await loadText('esp32-motor.kicad_pcb（サンプル）', async () => (await import('./fixtures/esp32-motor.kicad_pcb?raw')).default);
  }

  async function loadText(name: string, read: () => Promise<string>): Promise<void> {
    summary.textContent = '読み込み中…';
    try {
      const text = await read();
      if (closed) return;
      setBoard(parseKicadPcb(text), name);
    } catch (e) {
      if (closed) return;
      summary.textContent = '基板ファイルを読み込むと、ここに結果が出ます';
      toast(e instanceof KicadParseError ? e.message : '基板ファイルを読めませんでした。KiCad の .kicad_pcb ファイルを選んでください。', 'error');
    }
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void loadFile(f);
    fileInput.value = '';
  });

  canvas.addEventListener('click', (e) => {
    if (!view || !built) return;
    const r = canvas.getBoundingClientRect();
    const hit = hitPart(built.parts, view, e.clientX - r.left, e.clientY - r.top);
    select(hit?.key ?? null, true);
  });

  // ドラッグ＆ドロップ
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  backdrop.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    stage.classList.add('drag');
  });
  backdrop.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    stage.classList.add('drag');
  });
  backdrop.addEventListener('dragleave', (e) => {
    if (e.target === backdrop || !dialog.contains(e.relatedTarget as Node | null)) stage.classList.remove('drag');
  });
  backdrop.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('drag');
    const files = Array.from(e.dataTransfer?.files ?? []);
    const f = files.find((x) => /\.kicad_pcb$/i.test(x.name)) ?? files[0];
    if (f) void loadFile(f);
  });

  // キーボード: Esc で閉じる、Tab はダイアログの中でぐるぐる回す
  const focusables = (): HTMLElement[] =>
    Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, [tabindex]')).filter(
      (el) => !(el as HTMLButtonElement).disabled && !el.hidden && el.tabIndex >= 0 && el.getClientRects().length > 0,
    );
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
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
      if (!dialog.contains(active)) {
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
    // ダイアログの外にフォーカスがあるとき、下の画面のショートカットを動かさない
    if (!dialog.contains(e.target as Node | null)) e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  // 入力中のキー（Delete など）が画面のショートカットに届かないようにする
  backdrop.addEventListener('keydown', (e) => e.stopPropagation());
  const onResize = () => draw();
  window.addEventListener('resize', onResize);

  // ---------- 取り込み・終了 ----------
  function doImport(): void {
    if (importBtn.disabled || !built) return;
    const result = built;
    close();
    opts.onImport({ project: result.project, analysis: 'heat', warnings: result.warnings });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    document.body.style.overflow = prevOverflow;
    backdrop.remove();
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
  }

  pickBtn.focus();
  if (opts.file) void loadFile(opts.file);
  return close;
}
