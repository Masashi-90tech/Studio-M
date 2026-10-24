// 「画像から形を作る」ダイアログ。写真・図面・シルエット画像を多角形の Shape にして取り込む。
// 画像はブラウザの中だけで処理する（通信しない）。アルゴリズムは image-trace.ts。
import './image-import.css';
import type { Shape, ShapeRole } from '../core/types';
import { h, toast } from './dom';
import {
  borderIsMostlyObject,
  centeredOrigin,
  countGroups,
  defaultWidthMm,
  groupsBBox,
  otsuThreshold,
  runPipeline,
  scaleFromWidth,
  toGray,
  toShapes,
  type ContourGroup,
  type PipelineParams,
} from './image-trace';

export interface ImageImportOptions {
  /** 解析領域の大きさ [m]。取り込んだ形はこの中央に置く */
  domain: { width: number; height: number };
  onImport: (shapes: Shape[]) => void;
  materials: { id: string; name: string }[];
  defaultMaterialId: string;
}

/** 処理用に縮小する長辺の最大画素数 */
const MAX_SIDE = 800;
/** これを超える数の形は取り込まない（ノイズの取りすぎ） */
const MAX_SHAPES = 300;

const ROLE_OPTIONS: { value: ShapeRole; label: string }[] = [
  { value: 'solid', label: '物体' },
  { value: 'heatSource', label: '発熱体' },
  { value: 'hole', label: '穴（くり抜き）' },
  { value: 'fixedTemp', label: '温度固定' },
  { value: 'support', label: '固定支持' },
  { value: 'load', label: '荷重' },
];

function hexToRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fmt(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '-';
  return String(Math.round(v * 10 ** digits) / 10 ** digits);
}

/** ダイアログを開く。戻り値は閉じる関数 */
export function openImageImport(opts: ImageImportOptions): () => void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#e8590c';
  const blue = css.getPropertyValue('--blue').trim() || '#2563eb';
  const accentRgb = hexToRgb(accent, [232, 89, 12]);

  // ---------- 状態 ----------
  let imgCanvas: HTMLCanvasElement | null = null; // 縮小した元画像
  let gray: Uint8Array | null = null;
  let iw = 0;
  let ih = 0;
  let groups: ContourGroup[] = [];
  let maskCanvas: HTMLCanvasElement | null = null;
  let raf = 0;
  let widthTouched = false; // 利用者が幅を入力したか（入力後は既定値で上書きしない）
  let widthMm = 100;
  let basis: 'object' | 'image' = 'object';
  let role: ShapeRole = 'solid';
  let materialId = opts.defaultMaterialId;
  let fileName = '';
  let closed = false;

  const p: PipelineParams & { minAreaStep: number; tolStep: number } = {
    threshold: 128,
    invert: false,
    minArea: 0,
    morphRadius: 0,
    tolerance: 1,
    includeHoles: true,
    minAreaStep: 6,
    tolStep: 10,
  };

  // ---------- DOM ----------
  const titleId = 'imp-title';
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
  const pickBtn = h('button', { type: 'button', class: 'btn primary', onClick: () => fileInput.click() }, '画像を選ぶ…');
  const canvas = h('canvas', { class: 'imp-canvas', hidden: true, role: 'img', 'aria-label': '取り込み結果のプレビュー' });
  const ctx = canvas.getContext('2d')!;
  const empty = h(
    'div',
    { class: 'imp-empty' },
    h('strong', null, '画像をここにドロップ'),
    h('span', null, 'または「画像を選ぶ」、貼り付け（Ctrl+V）'),
  );
  const stage = h('div', { class: 'imp-stage' }, empty, canvas);
  const fileNameEl = h('span', { class: 'imp-file-name' }, '');
  const summary = h('div', { class: 'readout imp-summary', role: 'status', 'aria-live': 'polite' }, '画像を読み込むと、ここに結果が出ます');
  const warnEl = h('div', { class: 'imp-warn', hidden: true, role: 'alert' });

  // スライダー部品
  function slider(label: string, min: number, max: number, step: number, value: number, show: (v: number) => string, onInput: (v: number) => void, hint?: string) {
    const input = h('input', { type: 'range', min, max, step, 'aria-label': label });
    input.value = String(value);
    const val = h('span', { class: 'imp-val' }, show(value));
    input.addEventListener('input', () => {
      const v = Number(input.value);
      val.textContent = show(v);
      onInput(v);
    });
    const root = h('div', { class: 'imp-slider' }, h('div', { class: 'imp-slider-head' }, h('span', { class: 'field-label' }, label), val), input, hint ? h('span', { class: 'hint' }, hint) : null);
    return { root, input, val, setShow: (v: number) => (val.textContent = show(v)) };
  }

  const thSlider = slider('しきい値', 0, 255, 1, p.threshold, (v) => String(v), (v) => {
    p.threshold = v;
    schedule();
  }, '小さくすると、濃い部分だけが物体になります');
  const autoBtn = h('button', { type: 'button', class: 'btn small', onClick: () => autoThreshold() }, '自動');
  const invertInput = h('input', { type: 'checkbox' });
  invertInput.addEventListener('change', () => {
    p.invert = invertInput.checked;
    schedule();
  });
  const invertLabel = h('label', { class: 'imp-toggle' }, invertInput, h('span', null, '反転（明るい部分を物体にする）'));

  const areaSlider = slider(
    'ノイズ除去',
    0,
    100,
    1,
    p.minAreaStep,
    () => (p.minArea > 0 ? `${p.minArea} 画素² 未満を消す` : 'なし'),
    (v) => {
      p.minAreaStep = v;
      updateDerived();
      schedule();
    },
    '右へ動かすほど、小さな点やゴミを消します',
  );
  const tolSlider = slider(
    'なめらかさ',
    0,
    40,
    1,
    p.tolStep,
    () => (p.tolerance > 0 ? `許容 ${fmt(p.tolerance)} 画素` : '最も細かい'),
    (v) => {
      p.tolStep = v;
      updateDerived();
      schedule();
    },
    '右へ動かすほど頂点が減って軽くなります（形は少しずれます）',
  );
  const morphSelect = h(
    'select',
    { 'aria-label': 'ギザギザの整形' },
    h('option', { value: '0' }, 'なし'),
    h('option', { value: '1' }, '弱い'),
    h('option', { value: '2' }, '強い'),
  );
  morphSelect.addEventListener('change', () => {
    p.morphRadius = Number(morphSelect.value);
    schedule();
  });
  const morphField = h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'ギザギザの整形'), morphSelect, h('span', { class: 'hint' }, '細い突起や小さなすき間をならします'));

  // 実寸
  const widthLabel = h('span', { class: 'field-label' }, '物体の幅', h('span', { class: 'unit' }, ' [mm]'));
  const widthInput = h('input', { type: 'number', inputmode: 'decimal', step: 'any', min: '0.01', 'aria-label': '実寸の幅（ミリメートル）' });
  widthInput.value = String(widthMm);
  widthInput.addEventListener('input', () => {
    const v = parseFloat(widthInput.value);
    const ok = Number.isFinite(v) && v > 0;
    widthInput.classList.toggle('invalid', !ok && widthInput.value !== '');
    if (ok) {
      widthMm = v;
      widthTouched = true;
      updateInfo();
    }
  });
  widthInput.addEventListener('change', () => {
    widthInput.classList.remove('invalid');
    widthInput.value = String(widthMm);
  });
  const widthField = h('label', { class: 'field' }, widthLabel, widthInput);
  const basisSelect = h(
    'select',
    { 'aria-label': '幅の基準' },
    h('option', { value: 'object' }, '物体の幅（輪郭全体）'),
    h('option', { value: 'image' }, '画像全体の幅'),
  );
  basisSelect.addEventListener('change', () => {
    // 縮尺は変えずに、基準だけ切り替える
    const s = currentScale();
    basis = basisSelect.value as 'object' | 'image';
    const px = basisPx();
    if (s > 0 && px > 0) widthMm = s * px * 1000;
    widthInput.value = String(Math.round(widthMm * 100) / 100);
    widthLabel.firstChild!.textContent = basis === 'object' ? '物体の幅' : '画像全体の幅';
    updateInfo();
  });
  const basisField = h('label', { class: 'field' }, h('span', { class: 'field-label' }, '幅の基準'), basisSelect);
  const sizeInfo = h('div', { class: 'hint', 'aria-live': 'polite' });

  const roleSelect = h('select', { 'aria-label': '役割' }, ...ROLE_OPTIONS.map((o) => h('option', { value: o.value }, o.label)));
  roleSelect.addEventListener('change', () => {
    role = roleSelect.value as ShapeRole;
    updateRoleState();
  });
  const roleField = h('label', { class: 'field' }, h('span', { class: 'field-label' }, '役割'), roleSelect);
  const matSelect = h('select', { 'aria-label': '材料' }, ...opts.materials.map((m) => h('option', { value: m.id }, m.name)));
  matSelect.value = opts.materials.some((m) => m.id === opts.defaultMaterialId) ? opts.defaultMaterialId : (opts.materials[0]?.id ?? '');
  materialId = matSelect.value;
  matSelect.addEventListener('change', () => (materialId = matSelect.value));
  const matField = h('label', { class: 'field' }, h('span', { class: 'field-label' }, '材料'), matSelect);
  const holesInput = h('input', { type: 'checkbox', checked: true });
  holesInput.addEventListener('change', () => {
    p.includeHoles = holesInput.checked;
    schedule();
  });
  const holesLabel = h('label', { class: 'imp-toggle' }, holesInput, h('span', null, '穴も取り込む'));

  const importBtn = h('button', { type: 'button', class: 'btn primary', disabled: true, onClick: () => doImport() }, '取り込む');
  const cancelBtn = h('button', { type: 'button', class: 'btn', onClick: () => close() }, 'キャンセル');
  const closeBtn = h('button', { type: 'button', class: 'btn imp-close', 'aria-label': '閉じる', onClick: () => close() }, '×');

  const left = h(
    'div',
    { class: 'imp-col' },
    h('p', { class: 'imp-hint' }, '白い紙の上に置いた部品の写真、図面、シルエット画像がきれいに取れます。背景が複雑な写真は苦手です'),
    stage,
    h('div', { class: 'imp-file-row' }, pickBtn, fileNameEl),
    summary,
    warnEl,
  );
  const right = h(
    'div',
    { class: 'imp-col' },
    thSlider.root,
    h('div', { class: 'imp-inline' }, autoBtn, invertLabel),
    areaSlider.root,
    tolSlider.root,
    morphField,
    h('div', { class: 'imp-inline' }, widthField, basisField),
    sizeInfo,
    h('div', { class: 'imp-inline' }, roleField, matField),
    holesLabel,
  );

  const dialog = h(
    'div',
    { class: 'imp-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'imp-head' }, h('h2', { id: titleId }, '画像から形を作る'), closeBtn),
    h('div', { class: 'imp-body' }, left, right),
    h('div', { class: 'imp-foot' }, cancelBtn, importBtn),
    fileInput,
  );
  const backdrop = h('div', { class: 'imp-backdrop' }, dialog);
  document.body.append(backdrop);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  // ---------- 計算 ----------
  function updateDerived(): void {
    // ノイズ除去: 画像面積に対する割合（段階を二乗で効かせる）
    const area = Math.max(1, iw * ih || 640 * 480);
    p.minArea = p.minAreaStep === 0 ? 0 : Math.max(2, Math.round(area * 0.0001 * (p.minAreaStep / 10) ** 2));
    p.tolerance = p.tolStep / 10;
    areaSlider.setShow(p.minAreaStep);
    tolSlider.setShow(p.tolStep);
  }

  function basisPx(): number {
    if (basis === 'image') return iw;
    const bb = groupsBBox(groups);
    return bb ? bb.maxX - bb.minX : 0;
  }
  function currentScale(): number {
    return scaleFromWidth(widthMm, basisPx());
  }

  function schedule(): void {
    if (raf || !gray) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      recompute();
    });
  }

  function recompute(): void {
    if (!gray) return;
    const r = runPipeline(gray, iw, ih, p);
    groups = r.groups;
    // マスクを色つき半透明の画像にしておく（描画のたびに作らない）
    if (!maskCanvas) maskCanvas = document.createElement('canvas');
    maskCanvas.width = iw;
    maskCanvas.height = ih;
    const mctx = maskCanvas.getContext('2d')!;
    const id = mctx.createImageData(iw, ih);
    for (let i = 0; i < r.mask.length; i++) {
      if (!r.mask[i]) continue;
      id.data[i * 4] = accentRgb[0];
      id.data[i * 4 + 1] = accentRgb[1];
      id.data[i * 4 + 2] = accentRgb[2];
      id.data[i * 4 + 3] = 90;
    }
    mctx.putImageData(id, 0, 0);

    if (!widthTouched) {
      const bb = groupsBBox(groups);
      if (bb) {
        const objPx = bb.maxX - bb.minX;
        const aspect = objPx / Math.max(1e-9, bb.maxY - bb.minY);
        const objMm = defaultWidthMm(opts.domain, aspect);
        widthMm = basis === 'object' ? objMm : (objMm * iw) / objPx;
        widthInput.value = String(widthMm);
      }
    }
    draw();
    updateInfo();
  }

  function draw(): void {
    if (!imgCanvas) return;
    if (canvas.width !== iw || canvas.height !== ih) {
      canvas.width = iw;
      canvas.height = ih;
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, iw, ih);
    ctx.globalAlpha = 0.4;
    ctx.drawImage(imgCanvas, 0, 0);
    ctx.globalAlpha = 1;
    if (maskCanvas) ctx.drawImage(maskCanvas, 0, 0);
    // 画面上で線の太さが約 2px になるように換算する
    const shown = canvas.getBoundingClientRect().width || iw;
    const k = Math.max(1, iw / shown);
    ctx.lineJoin = 'round';
    const trace = (pts: [number, number][]) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    };
    ctx.lineWidth = 2 * k;
    ctx.setLineDash([]);
    ctx.strokeStyle = accent;
    for (const g of groups) trace(g.outer.points);
    ctx.strokeStyle = blue;
    ctx.setLineDash([6 * k, 4 * k]);
    for (const g of groups) for (const hl of g.holes) trace(hl.points);
    ctx.setLineDash([]);
  }

  function updateInfo(): void {
    const c = countGroups(groups);
    if (!gray) {
      summary.textContent = '画像を読み込むと、ここに結果が出ます';
      importBtn.disabled = true;
      sizeInfo.textContent = '';
      warnEl.hidden = true;
      return;
    }
    summary.textContent = `輪郭 ${c.outers} 個（穴 ${c.holes} 個）・頂点 ${c.vertices}`;
    const bb = groupsBBox(groups);
    const s = currentScale();
    const warns: string[] = [];
    if (bb && s > 0) {
      const wMm = (bb.maxX - bb.minX) * s * 1000;
      const hMm = (bb.maxY - bb.minY) * s * 1000;
      sizeInfo.textContent = `取り込む大きさ: ${fmt(wMm)} × ${fmt(hMm)} mm（1 画素 = ${fmt(s * 1000, 3)} mm）`;
      if (wMm / 1000 > opts.domain.width || hMm / 1000 > opts.domain.height) {
        warns.push(`解析領域（${fmt(opts.domain.width * 1000, 0)} × ${fmt(opts.domain.height * 1000, 0)} mm）より大きいため、はみ出します。幅を小さくしてください。`);
      }
    } else {
      sizeInfo.textContent = '';
    }
    const total = c.outers + (role === 'solid' || role === 'heatSource' ? c.holes : 0);
    if (c.outers === 0) warns.push('輪郭が見つかりません。しきい値や「反転」を変えてみてください。');
    else if (total > MAX_SHAPES) warns.push(`形が ${total} 個もあります。ノイズ除去を強めてください（上限 ${MAX_SHAPES} 個）。`);
    else if (c.outers > 40) warns.push('輪郭がとても多いです。ノイズ除去を強めると見やすくなります。');
    warnEl.hidden = warns.length === 0;
    warnEl.textContent = warns.join(' ');
    importBtn.disabled = c.outers === 0 || !(s > 0) || total > MAX_SHAPES;
  }

  function updateRoleState(): void {
    const hasHoles = role === 'solid' || role === 'heatSource';
    holesInput.disabled = !hasHoles;
    matSelect.disabled = !(role === 'solid' || role === 'heatSource');
    updateInfo();
  }

  function autoThreshold(): void {
    if (!gray) return;
    const t = otsuThreshold(gray);
    p.threshold = t;
    thSlider.input.value = String(t);
    thSlider.setShow(t);
    p.invert = borderIsMostlyObject(gray, iw, ih, t);
    invertInput.checked = p.invert;
    schedule();
  }

  // ---------- 画像の読み込み ----------
  function loadFile(file: File): void {
    if (!file.type.startsWith('image/')) {
      toast('画像ファイルを選んでください', 'error');
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (closed) return;
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const hh = Math.max(1, Math.round(img.naturalHeight * scale));
      const off = document.createElement('canvas');
      off.width = w;
      off.height = hh;
      const octx = off.getContext('2d', { willReadFrequently: true })!;
      octx.fillStyle = '#fff'; // 透明な部分は白い紙として扱う
      octx.fillRect(0, 0, w, hh);
      octx.drawImage(img, 0, 0, w, hh);
      let data: ImageData;
      try {
        data = octx.getImageData(0, 0, w, hh);
      } catch {
        toast('画像を読み取れませんでした', 'error');
        return;
      }
      imgCanvas = off;
      iw = w;
      ih = hh;
      gray = toGray(data);
      fileName = file.name || '貼り付けた画像';
      fileNameEl.textContent = `${fileName}（${iw} × ${ih} 画素${scale < 1 ? '・縮小して処理' : ''}）`;
      empty.hidden = true;
      canvas.hidden = false;
      stage.classList.add('has-image');
      widthTouched = false;
      updateDerived();
      autoThreshold();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast('画像を読み込めませんでした（対応していない形式かもしれません）', 'error');
    };
    img.src = url;
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) loadFile(f);
    fileInput.value = '';
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
    const f = Array.from(e.dataTransfer?.files ?? []).find((x) => x.type.startsWith('image/')) ?? e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });

  // 貼り付け（Ctrl+V）
  const onPaste = (e: ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const it = items.find((x) => x.kind === 'file' && x.type.startsWith('image/'));
    const f = it?.getAsFile();
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    loadFile(f);
  };
  document.addEventListener('paste', onPaste, true);

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
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
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
  // 入力中のキーが画面のショートカット（Delete など）に届かないようにする
  backdrop.addEventListener('keydown', (e) => e.stopPropagation());
  const onResize = () => draw();
  window.addEventListener('resize', onResize);

  // ---------- 取り込み・終了 ----------
  function doImport(): void {
    if (importBtn.disabled) return;
    const bb = groupsBBox(groups);
    const s = currentScale();
    if (!bb || !(s > 0)) return;
    const { originX, originY } = centeredOrigin(bb, ih, s, opts.domain);
    const shapes = toShapes(groups, {
      scaleMPerPx: s,
      originX,
      originY,
      flipY: true,
      imageHeight: ih,
      role,
      materialId,
      namePrefix: '画像の形',
      includeHoles: p.includeHoles,
    });
    close();
    opts.onImport(shapes);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (raf) cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('paste', onPaste, true);
    window.removeEventListener('resize', onResize);
    document.body.style.overflow = prevOverflow;
    backdrop.remove();
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
  }

  updateDerived();
  updateRoleState();
  pickBtn.focus();
  return close;
}
