// 左のツールレール、キャンバス上の「新しい図形」バー、解析タブ。
import type { AnalysisKind, ShapeRole } from '../core/types';
import { listWorkbenches, materialLabel } from '../workbench';
import { clear, h } from './dom';
import { ROLE_HINTS, ROLE_LABELS, ROLES, roleUsesMaterial, solidMaterials } from './project-utils';
import type { Store, Tool } from './state';

const svg = (inner: string): string =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const ICONS: Record<string, string> = {
  select: svg('<path d="M5 3l14 8-6 1.8L10.5 19z"/>'),
  rect: svg('<rect x="4" y="6" width="16" height="12" rx="1.5"/>'),
  circle: svg('<circle cx="12" cy="12" r="8"/>'),
  polygon: svg('<path d="M5 18l3-12 9 2 3 9z"/><circle cx="5" cy="18" r="1.2"/><circle cx="8" cy="6" r="1.2"/><circle cx="17" cy="8" r="1.2"/><circle cx="20" cy="17" r="1.2"/>'),
  freehand: svg('<path d="M4 16c3-9 6-9 8-4s5 4 8-5"/>'),
  delete: svg('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/>'),
  probe: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>'),
  section: svg('<path d="M4 18L20 6"/><circle cx="4" cy="18" r="1.6"/><circle cx="20" cy="6" r="1.6"/><path d="M8 20h8" stroke-dasharray="2 2"/>'),
  undo: svg('<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 8"/>'),
  redo: svg('<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 000 8"/>'),
};

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: 'select', label: '選択/移動', key: 'V' },
  { tool: 'rect', label: '長方形', key: 'R' },
  { tool: 'circle', label: '円', key: 'C' },
  { tool: 'polygon', label: '多角形', key: 'P' },
  { tool: 'freehand', label: 'フリーハンド', key: 'F' },
  { tool: 'delete', label: '削除', key: 'X' },
  { tool: 'probe', label: 'プローブ', key: 'O' },
  { tool: 'section', label: '断面', key: 'L' },
];

/** プロモードだけで使うツール */
const PRO_TOOLS: Tool[] = ['probe', 'section'];

export function initToolRail(store: Store, rail: HTMLElement): void {
  const buttons = new Map<Tool, HTMLButtonElement>();
  for (const t of TOOLS) {
    const b = h('button', { class: 'tool', type: 'button', title: `${t.label}（${t.key}）`, 'aria-label': t.label, onclick: () => store.setTool(t.tool) });
    b.innerHTML = `${ICONS[t.tool]}<span>${t.label}</span>`;
    buttons.set(t.tool, b);
    if (PRO_TOOLS.includes(t.tool)) b.dataset.pro = '1';
    rail.append(b);
  }
  rail.append(h('div', { class: 'rail-sep' }));
  const undo = h('button', { class: 'tool', type: 'button', title: '元に戻す（Ctrl+Z）', 'aria-label': '元に戻す', onclick: () => store.undo() });
  undo.innerHTML = `${ICONS.undo}<span>元に戻す</span>`;
  const redo = h('button', { class: 'tool', type: 'button', title: 'やり直す（Ctrl+Shift+Z）', 'aria-label': 'やり直す', onclick: () => store.redo() });
  redo.innerHTML = `${ICONS.redo}<span>やり直す</span>`;
  rail.append(undo, redo);

  const refresh = (): void => {
    for (const [tool, b] of buttons) {
      b.classList.toggle('active', tool === store.tool);
      b.setAttribute('aria-pressed', String(tool === store.tool));
    }
    undo.disabled = !store.canUndo();
    redo.disabled = !store.canRedo();
    for (const t of PRO_TOOLS) buttons.get(t)!.hidden = store.mode !== 'pro';
  };
  store.on('mode', refresh);
  store.on('tool', refresh);
  store.on('project', refresh);
  store.on('load', refresh);
  refresh();
}

/** キャンバス上部: 新しい図形の役割・材料、スナップなど */
export function initStageBar(store: Store, bar: HTMLElement): void {
  const role = h('select', { id: 'newRole', 'aria-label': '新しい図形の役割' }, ...ROLES.map((r) => h('option', { value: r }, ROLE_LABELS[r])));
  role.value = store.newRole;
  const mat = h('select', { id: 'newMat', 'aria-label': '新しい図形の材料' });
  // 電磁波のときは比誘電率 εr も並べる
  const fillMaterials = (): void => {
    clear(mat);
    for (const m of solidMaterials()) mat.append(h('option', { value: m.id }, materialLabel({ kind: store.analysis, material: m })));
    mat.value = store.newMaterialId;
  };
  fillMaterials();
  const matBox = h('label', { class: 'inline' }, h('span', null, '材料'), mat);

  role.addEventListener('change', () => {
    store.newRole = role.value as ShapeRole;
    store.emit('tool');
  });
  mat.addEventListener('change', () => {
    store.newMaterialId = mat.value;
    store.emit('tool');
  });

  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void, title: string): HTMLElement => {
    const input = h('input', { type: 'checkbox', checked: get() });
    input.addEventListener('change', () => {
      set(input.checked);
      store.emit('view');
    });
    return h('label', { class: 'inline toggle', title }, input, h('span', null, label));
  };

  bar.append(
    h('label', { class: 'inline', title: '次に描く図形の役割' }, h('span', null, '描く図形の役割'), role),
    matBox,
    toggle('セルに吸着', () => store.view.snap, (v) => (store.view.snap = v), '図形の位置を計算格子のセルに合わせます'),
    toggle('グリッド', () => store.view.grid, (v) => (store.view.grid = v), '目盛り線を表示します'),
  );

  const refresh = (): void => {
    role.value = store.newRole;
    mat.value = store.newMaterialId;
    matBox.hidden = !roleUsesMaterial(store.newRole);
    role.title = ROLE_HINTS[store.newRole];
  };
  store.on('tool', refresh);
  store.on('analysis', fillMaterials);
  refresh();
}

export function initTabs(store: Store, tabs: HTMLElement): void {
  const buttons = new Map<AnalysisKind, HTMLButtonElement>();
  // タブは登録されたワークベンチから作る（並び順・名前・説明・バッジはワークベンチが持つ）
  for (const wb of listWorkbenches()) {
    const k = wb.kind;
    const b = h('button', { class: 'tab', type: 'button', role: 'tab', title: wb.shortHint, onclick: () => store.setAnalysis(k) }, wb.label);
    if (wb.tabBadge) b.append(h('small', null, wb.tabBadge));
    buttons.set(k, b);
    tabs.append(b);
  }
  const refresh = (): void => {
    for (const [k, b] of buttons) {
      b.classList.toggle('active', k === store.analysis);
      b.setAttribute('aria-selected', String(k === store.analysis));
    }
  };
  store.on('analysis', refresh);
  refresh();
}
