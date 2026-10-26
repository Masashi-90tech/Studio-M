// 「3D モデルを開く」ダイアログ。STL / OBJ を読み、3D で見ながら切る面を選び、その断面を 2D の形にして Project にする。
// ファイルはブラウザの中だけで処理する（通信しない）。読み取りは load.ts、整理は mesh.ts、断面は slice.ts、組み立ては build.ts。
// 画面（ハーネス）からは、このファイルを使うときに遅延 import すること。
import './import-dialog.css';
import { ANALYSIS_KINDS, DEFAULT_ANALYSIS, analysisLabel } from '../core/analyses';
import { MATERIALS } from '../core/materials';
import type { AnalysisKind, Project, Study3D } from '../core/types';
import { fieldRow, h, numField, selectField, toast } from '../ui/dom';
import { DEFAULT_MATERIAL_ID, buildMeshProject } from './build';
import { buildStudy3D } from './build3d';
import { parseMeshFile } from './load';
import { analyzeMesh, type MeshInfo } from './mesh';
import { sampleMesh } from './primitives';
import { drawSection, sectionPreviewHeight } from './section-preview';
import { sectionSegments3D, sliceMesh, type SliceResult } from './slice';
import { AXIS_NAMES, MeshParseError, UNIT_LABEL, UNIT_TO_M, type Axis, type LengthUnit, type TriMesh } from './types';
import { createViewer, type Viewer } from './viewer';

export interface MeshImportResult {
  project: Project;
  /** 取り込んだあとに開く解析。画面は解析の名前を直接書かず、これを使う */
  analysis: AnalysisKind;
  /** 取り込みで気づいたこと（穴のあるモデル、閉じない断面など） */
  warnings: string[];
}

export interface MeshImportOptions {
  onImport: (result: MeshImportResult) => void;
  /**
   * 「3D のまま解析する（熱）」を選んだとき。ダイアログを閉じてから呼ぶ。
   * 省略すると、そのボタンを出さない（mesh3d は 3D 解析の画面を知らない。開くのは画面側）
   */
  onAnalyze3D?: (study: Study3D, info: { warnings: string[] }) => void;
  /** 最初から読み込むファイル（画面へのドロップなどで渡す）。省略時は選んでもらう */
  file?: File;
}

const SLIDER_STEPS = 1000;
const round2 = (v: number): string => String(Math.round(v * 100) / 100);
const tick = (): Promise<void> => new Promise((r) => window.setTimeout(r, 20));

const AXIS_HINT = ['X（横から）', 'Y（前から）', 'Z（上から）'] as const;

/** ダイアログを開く。戻り値は閉じる関数 */
export function openMeshImport(opts: MeshImportOptions): () => void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const css = getComputedStyle(document.documentElement);
  const colors = {
    accent: css.getPropertyValue('--accent').trim() || '#e8590c',
    blue: css.getPropertyValue('--blue').trim() || '#2563eb',
    ink: css.getPropertyValue('--ink').trim() || '#26221c',
    muted: css.getPropertyValue('--muted').trim() || '#6b6459',
  };

  // ---------- 状態 ----------
  let info: MeshInfo | null = null;
  let fileName = '';
  let axis: Axis = 2;
  let position = 0;
  let unit: LengthUnit = 'mm';
  let analysis: AnalysisKind = DEFAULT_ANALYSIS;
  let materialId = DEFAULT_MATERIAL_ID;
  let thicknessEdited = false;
  let slice: SliceResult | null = null;
  let viewer: Viewer | null = null;
  let closed = false;
  let timer = 0;

  // ---------- DOM ----------
  const titleId = 'm3d-title';
  const fileInput = h('input', { type: 'file', accept: '.stl,.obj,.txt', hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
  const pickBtn = h('button', { type: 'button', class: 'btn primary', onClick: () => fileInput.click() }, '3D モデルを選ぶ…');
  const fileNameEl = h('span', { class: 'm3d-file-name' }, '');
  const viewHost = h('div', { class: 'm3d-view', hidden: true });
  const empty = h(
    'div',
    { class: 'm3d-empty' },
    h('strong', null, 'STL・OBJ ファイルをここにドロップ'),
    h('span', null, 'または「3D モデルを選ぶ」。Blender や CAD から STL / OBJ で書き出したファイルです。長さの単位はファイルに入っていないので、読み込んだあとで選びます'),
    h('button', { type: 'button', class: 'btn', onClick: () => void loadSample() }, 'サンプル（穴のあいた板）で試す'),
    h('span', { class: 'm3d-sample-note' }, '手元にモデルがなくても、断面を切って解析にかけるまでの流れを試せます'),
  );
  const stage = h('div', { class: 'm3d-stage' }, empty, viewHost);
  const summary = h('div', { class: 'readout m3d-summary', role: 'status', 'aria-live': 'polite' }, '3D モデルを読み込むと、ここに結果が出ます');
  const fixesEl = h('div', { class: 'm3d-fixes', hidden: true });
  const meshWarnEl = h('div', { class: 'm3d-warn', hidden: true, role: 'status' });

  // 切る軸
  const axisBtns = ([0, 1, 2] as Axis[]).map((a) => {
    const b = h('button', { type: 'button', class: 'm3d-seg', 'aria-pressed': 'false', onClick: () => setAxis(a) }, AXIS_HINT[a]);
    return b;
  });
  const axisGroup = h('div', { class: 'm3d-segs', role: 'group', 'aria-label': '切る軸' }, ...axisBtns);
  // 切る位置
  const slider = h('input', { type: 'range', class: 'm3d-slider', min: '0', max: String(SLIDER_STEPS), step: '1', value: String(SLIDER_STEPS / 2), 'aria-label': '切る位置', disabled: true });
  const posInput = h('input', { type: 'number', inputmode: 'decimal', step: 'any', 'aria-label': '切る位置の数値', disabled: true });
  const posUnit = h('span', { class: 'unit' }, '');
  const posRow = fieldRow('切る位置', h('div', { class: 'm3d-pos' }, posInput, posUnit), '右へ動かすと、選んだ軸の正の向きへ進みます');
  const clipBox = h('input', { type: 'checkbox', disabled: true });
  const clipRow = h('label', { class: 'm3d-check' }, clipBox, h('span', null, '3D の表示で、切る面より上を隠して中を見る'));
  // 断面の 2D プレビュー
  const sectionCanvas = h('canvas', { class: 'm3d-section', role: 'img', 'aria-label': '断面の形。外形は実線、穴は点線で表示します' });
  const sectionBox = h('div', { class: 'm3d-section-box' }, sectionCanvas);
  const sectionInfo = h('div', { class: 'readout m3d-summary', role: 'status', 'aria-live': 'polite' }, '');
  const sliceWarnEl = h('div', { class: 'm3d-warn', hidden: true, role: 'status' });

  const unitSel = selectField(
    '長さの単位',
    (Object.keys(UNIT_LABEL) as LengthUnit[]).map((u) => ({ value: u, label: UNIT_LABEL[u] })),
    unit,
    (v) => {
      unit = v as LengthUnit;
      thicknessEdited = false;
      onUnitChanged();
    },
    'STL・OBJ には単位が入っていません。モデルを作ったときの単位を選びます（多くは mm）',
  );
  const unitWarn = h('div', { class: 'm3d-note', hidden: true, role: 'status' });
  const analysisSel = selectField(
    'どの解析で開くか',
    ANALYSIS_KINDS.map((k) => ({ value: k, label: analysisLabel(k) })),
    analysis,
    (v) => {
      analysis = v as AnalysisKind;
      updateImportState();
    },
    '取り込んだあとに開く解析です。あとから画面上部のタブで切り替えられます',
  );
  const materialSel = selectField(
    '材料',
    MATERIALS.filter((m) => m.kind === 'solid').map((m) => ({ value: m.id, label: m.name })),
    materialId,
    (v) => {
      materialId = v;
    },
  );
  const thick = numField({
    label: '板の厚さ',
    unit: 'mm',
    value: 10,
    min: 0.01,
    max: 100000,
    step: 'any',
    digits: 3,
    hint: '2D の解析は、この厚さを持つ板として扱います。切る軸や単位を変えると、その方向のモデルの長さに合わせ直します',
    onChange: () => {
      thicknessEdited = true;
    },
  });

  const importBtn = h('button', { type: 'button', class: 'btn primary', disabled: true, onClick: () => doImport() }, '取り込む');
  const analyze3dBtn = h(
    'button',
    { type: 'button', class: 'btn', disabled: true, hidden: !opts.onAnalyze3D, title: '断面を切らずに、3D モデルをそのまま 3D で解きます（熱）', onClick: () => doAnalyze3D() },
    '3D のまま解析する（熱）',
  );
  const cancelBtn = h('button', { type: 'button', class: 'btn', onClick: () => close() }, 'キャンセル');
  const closeBtn = h('button', { type: 'button', class: 'btn m3d-close', 'aria-label': '閉じる', onClick: () => close() }, '×');

  const left = h(
    'div',
    { class: 'm3d-col' },
    h('p', { class: 'm3d-hint' }, '3D モデルを読み込み、切る面を選んで、その断面（2D の形）を解析にかけます。モデルは Z が上の向きで表示します'),
    stage,
    h('div', { class: 'm3d-file-row' }, pickBtn, fileNameEl),
    summary,
    fixesEl,
    meshWarnEl,
  );
  const right = h(
    'div',
    { class: 'm3d-col' },
    h('h3', { class: 'm3d-h' }, '切る面'),
    axisGroup,
    h('div', { class: 'm3d-slide-row' }, slider),
    posRow,
    clipRow,
    sectionBox,
    sectionInfo,
    sliceWarnEl,
    h('h3', { class: 'm3d-h' }, '条件'),
    h('div', { class: 'm3d-inline' }, unitSel.root, thick.root),
    unitWarn,
    h('div', { class: 'm3d-inline' }, analysisSel.root, materialSel.root),
  );
  const dialog = h(
    'div',
    { class: 'm3d-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'm3d-head' }, h('h2', { id: titleId }, '3D モデルを開く（STL・OBJ）'), closeBtn),
    h('div', { class: 'm3d-body' }, left, right),
    h('div', { class: 'm3d-foot' }, cancelBtn, analyze3dBtn, importBtn),
    fileInput,
  );
  const backdrop = h('div', { class: 'm3d-backdrop' }, dialog);
  document.body.append(backdrop);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  // ---------- 断面の計算と表示 ----------
  const range = (): [number, number] => (info ? [info.bounds.min[axis], info.bounds.max[axis]] : [0, 1]);

  function updateImportState(): void {
    const ok = !!slice && slice.loops.some((l) => !l.hole);
    importBtn.disabled = !ok;
    analyze3dBtn.disabled = !info;
  }

  function drawPreview(): void {
    const w = Math.max(220, sectionBox.clientWidth - 2);
    const maxH = Math.max(200, Math.round(window.innerHeight * 0.38));
    drawSection(sectionCanvas, slice, colors, UNIT_LABEL[unit], w, sectionPreviewHeight(slice, w, maxH));
  }

  function renderSlice(): void {
    window.clearTimeout(timer);
    if (!info) return;
    slice = sliceMesh(info.mesh, { axis, position });
    viewer?.setPlane({ axis, position });
    viewer?.setSection(slice.loops.length > 0 ? sectionSegments3D(slice) : null);
    drawPreview();
    const outers = slice.loops.filter((l) => !l.hole).length;
    const holes = slice.loops.length - outers;
    const area = slice.loops.reduce((s, l) => s + (l.hole ? -l.area : l.area), 0);
    const [u0, v0, u1, v1] = slice.bounds2d ?? [0, 0, 0, 0];
    sectionInfo.textContent =
      slice.loops.length === 0
        ? '断面がありません'
        : `${AXIS_NAMES[axis]} = ${round2(position)} ${UNIT_LABEL[unit]} の断面・${round2(u1 - u0)} × ${round2(v1 - v0)} ${UNIT_LABEL[unit]}・外形 ${outers} 個・穴 ${holes} 個・面積 ${round2(area)} ${UNIT_LABEL[unit]}²`;
    sliceWarnEl.hidden = slice.warnings.length === 0;
    sliceWarnEl.replaceChildren(...slice.warnings.map((w) => h('div', null, w)));
    updateImportState();
  }

  /** スライダーを動かしている間は、最後の 1 回だけ計算する（大きなモデルでも固まらない） */
  function scheduleSlice(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(renderSlice, 16);
  }

  function setPosition(v: number, fromSlider: boolean): void {
    const [lo, hi] = range();
    position = Math.min(hi, Math.max(lo, v));
    if (!fromSlider) {
      const t = hi > lo ? (position - lo) / (hi - lo) : 0.5;
      slider.value = String(Math.round(Math.min(1, Math.max(0, (t - 0.001) / 0.998)) * SLIDER_STEPS));
    }
    if (document.activeElement !== posInput) posInput.value = round2(position);
    scheduleSlice();
  }

  function autoThicknessMm(): number {
    const [lo, hi] = range();
    return (hi - lo) * UNIT_TO_M[unit] * 1e3;
  }

  function syncThickness(): void {
    if (!info || thicknessEdited) return;
    const v = autoThicknessMm();
    if (v > 0) thick.set(v);
  }

  function setAxis(a: Axis): void {
    if (!info) return;
    axis = a;
    thicknessEdited = false;
    axisBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === a)));
    const [lo, hi] = range();
    posInput.min = String(lo);
    posInput.max = String(hi);
    setPosition((lo + hi) / 2, false);
    syncThickness();
  }

  function onUnitChanged(): void {
    posUnit.textContent = UNIT_LABEL[unit];
    syncThickness();
    updateInfo();
    scheduleSlice();
  }

  // ---------- モデルの表示 ----------
  function updateInfo(): void {
    if (!info) return;
    const b = info.bounds;
    const size = [0, 1, 2].map((a) => b.max[a] - b.min[a]);
    const u = UNIT_LABEL[unit];
    const state = info.watertight.watertight ? '閉じた立体です' : '閉じていません（穴あり）';
    summary.textContent = `三角形 ${info.triangleCount.toLocaleString('ja-JP')} 個・大きさ ${size.map(round2).join(' × ')} ${u}・体積 ${round2(info.volume)} ${u}³・${state}`;
    const maxM = Math.max(...size) * UNIT_TO_M[unit];
    if (maxM > 3) {
      unitWarn.hidden = false;
      unitWarn.textContent = `この単位だと、モデルの一番長い辺が ${round2(maxM)} m になります。単位が違うかもしれません（mm で作ったモデルなら「mm」を選びます）。`;
    } else if (maxM < 0.002) {
      unitWarn.hidden = false;
      unitWarn.textContent = `この単位だと、モデルの一番長い辺が ${round2(maxM * 1e3)} mm しかありません。単位が違うかもしれません（m で作ったモデルなら「m」を選びます）。`;
    } else {
      unitWarn.hidden = true;
    }
  }

  async function setMesh(raw: TriMesh, name: string): Promise<void> {
    summary.textContent = '整理しています…（頂点の統合・穴の確認）';
    await tick();
    if (closed) return;
    const a = analyzeMesh(raw);
    if (a.mesh.indices.length === 0) {
      info = null;
      summary.textContent = '3D モデルを読み込むと、ここに結果が出ます';
      toast(a.warnings[0] ?? '使える三角形がありませんでした。', 'error');
      return;
    }
    info = a;
    fileName = name;
    fileNameEl.textContent = name;
    thicknessEdited = false;
    empty.hidden = true;
    viewHost.hidden = false;
    stage.classList.add('has-model');
    ensureViewer();
    viewer?.setMesh(a.mesh, a.bounds);
    fixesEl.hidden = a.fixes.length === 0;
    fixesEl.textContent = a.fixes.join(' ');
    meshWarnEl.hidden = a.warnings.length === 0;
    meshWarnEl.replaceChildren(...a.warnings.map((w) => h('div', null, w)));
    for (const el of [slider, posInput, clipBox]) el.disabled = false;
    updateInfo();
    posUnit.textContent = UNIT_LABEL[unit];
    // 一番薄い軸で切るのが、板や基板のような形には向いている（同じなら Z）
    const ext = [0, 1, 2].map((i) => a.bounds.max[i] - a.bounds.min[i]);
    let best: Axis = 2;
    for (const i of [0, 1] as Axis[]) if (ext[i] < ext[best] * 0.999) best = i;
    setAxis(best);
    renderSlice();
  }

  function ensureViewer(): void {
    if (viewer) return;
    const r = createViewer(viewHost, { accent: colors.accent, background: '#f7f5f1' });
    if ('error' in r) {
      viewHost.append(h('div', { class: 'm3d-message' }, r.error));
      return;
    }
    viewer = r.viewer;
    viewer.setClipAbove(clipBox.checked);
  }

  // ---------- ファイルの読み込み ----------
  async function loadFile(file: File): Promise<void> {
    summary.textContent = '読み込み中…';
    try {
      const buf = await file.arrayBuffer();
      if (closed) return;
      await tick();
      await setMesh(parseMeshFile(file.name, buf), file.name);
    } catch (e) {
      if (closed) return;
      summary.textContent = info ? summary.textContent : '3D モデルを読み込むと、ここに結果が出ます';
      if (info) updateInfo();
      toast(e instanceof MeshParseError ? e.message : `3D モデルを読めませんでした。STL か OBJ のファイルを選んでください（${e instanceof Error ? e.message : String(e)}）`, 'error', { ms: 9000 });
    }
  }

  async function loadSample(): Promise<void> {
    summary.textContent = '読み込み中…';
    await setMesh(sampleMesh(), '穴あき板（サンプル）');
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void loadFile(f);
    fileInput.value = '';
  });

  slider.addEventListener('input', () => {
    if (!info) return;
    const [lo, hi] = range();
    const t = 0.001 + (Number(slider.value) / SLIDER_STEPS) * 0.998;
    setPosition(lo + t * (hi - lo), true);
  });
  posInput.addEventListener('input', () => {
    const v = parseFloat(posInput.value);
    if (!Number.isFinite(v)) return;
    setPosition(v, false);
  });
  posInput.addEventListener('change', () => {
    posInput.value = round2(position);
  });
  clipBox.addEventListener('change', () => viewer?.setClipAbove(clipBox.checked));

  // ドラッグ＆ドロップ
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');
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
    const f = files.find((x) => /\.(stl|obj)$/i.test(x.name)) ?? files[0];
    if (f) void loadFile(f);
  });

  // キーボード: Esc で閉じる、Tab はダイアログの中でぐるぐる回す
  const focusables = (): HTMLElement[] =>
    Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, canvas[tabindex], [tabindex]')).filter(
      (el) => !(el as HTMLButtonElement).disabled && !el.hidden && el.tabIndex >= 0 && el.getClientRects().length > 0,
    );
  const onKey = (e: KeyboardEvent): void => {
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
  const onResize = (): void => {
    drawPreview();
    viewer?.resize();
  };
  window.addEventListener('resize', onResize);

  // ---------- 取り込み・終了 ----------
  function doImport(): void {
    if (importBtn.disabled || !info || !slice) return;
    try {
      const built = buildMeshProject({
        slice,
        fileName,
        analysis,
        unit,
        materialId,
        thicknessM: thicknessEdited ? thick.input.valueAsNumber * 1e-3 : undefined,
      });
      const warnings = [...info.warnings, ...built.warnings];
      close();
      opts.onImport({ project: built.project, analysis, warnings });
    } catch (e) {
      toast(e instanceof Error ? e.message : '取り込めませんでした', 'error');
    }
  }

  function doAnalyze3D(): void {
    if (analyze3dBtn.disabled || !info || !opts.onAnalyze3D) return;
    try {
      const study = buildStudy3D({ mesh: info.mesh, fileName, unit, materialId });
      const warnings = [...info.warnings];
      const cb = opts.onAnalyze3D;
      close();
      cb(study, { warnings });
    } catch (e) {
      toast(e instanceof Error ? e.message : '3D 解析を始められませんでした', 'error');
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    window.clearTimeout(timer);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    viewer?.dispose();
    viewer = null;
    document.body.style.overflow = prevOverflow;
    backdrop.remove();
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
  }

  pickBtn.focus();
  if (opts.file) void loadFile(opts.file);
  return close;
}
