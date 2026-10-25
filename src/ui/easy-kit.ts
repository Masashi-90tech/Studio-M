// かんたんモードのパネル部品: 解析ごとのパネル（workbench/panels）が共有する小さな部品。
import { clear, h } from './dom';
import { bodyMaterial, easyMaterialLabel, EASY_MATERIALS, setBodyMaterial } from './easy-logic';
import type { PanelCtx } from './panel-kit';

/** 作図の補助: 形を置くボタン */
export const helperButton = (label: string, onClick: () => void): HTMLElement => h('button', { class: 'btn small primary', type: 'button', onclick: onClick }, label);

/** 計算セルの幅 [m]（自動格子の結果があればそれ） */
export const cellSize = (ctx: PanelCtx): number => ctx.runner.grid?.h ?? ctx.store.project.domain.width / ctx.store.project.domain.nx;

export const noBodyHint = (): HTMLElement =>
  h('div', { class: 'notice info' }, h('p', null, 'まだ部品がありません。左の「長方形」や「円」で形を描くか、上の「プリセット」から例を開きましょう。'));

/** 全物体に反映する材料の選択（roles で対象の役割を絞れる） */
export function materialPicker(ctx: PanelCtx, label: string, hint?: string, roles?: ('solid' | 'heatSource')[]): HTMLElement {
  const { store } = ctx;
  const select = h('select', { 'aria-label': label });
  const fill = (): void => {
    clear(select);
    const cur = bodyMaterial(store.project, roles);
    const known = new Set(EASY_MATERIALS.map((m) => m.id));
    const items = [...EASY_MATERIALS];
    if (cur.id && !known.has(cur.id)) items.push({ id: cur.id, label: easyMaterialLabel(cur.id) });
    if (cur.mixed) select.append(h('option', { value: '' }, '（いろいろ）'));
    for (const m of items) select.append(h('option', { value: m.id }, m.label));
    select.value = cur.mixed ? '' : (cur.id ?? 'pla');
  };
  select.addEventListener('change', () => {
    if (!select.value) return;
    ctx.change('easy:mat', () => setBodyMaterial(store.project, select.value, roles));
  });
  fill();
  ctx.onRefresh(() => {
    if (document.activeElement !== select) fill();
  });
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), select, hint ? h('span', { class: 'hint' }, hint) : null);
}
