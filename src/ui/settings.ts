// 右パネルの「解析の設定」の枠。解析に共通の「解析する範囲」カードをここで作り、
// 解析ごとの設定カードとプロの詳細設定は、ワークベンチ（src/workbench）のパネルを遅延 import で差し込む。
import { clear, fieldRow, h, numField, section } from './dom';
import { formatQuantity } from './format';
import { createPanelSlot } from './panel-host';
import { makeCtx, type PanelCtx } from './panel-kit';
import type { Runner } from './runner';
import type { Store } from './state';

const MM = 1000;

export function initSettings(store: Store, runner: Runner, host: HTMLElement): { update: () => void } {
  const derived: (() => void)[] = [];
  const ctx: PanelCtx = makeCtx(store, runner, derived);
  const change = ctx.change;

  /** 格子の細かさ。自動のときは理由を見せ、プロでは自動 ⇄ 手動を切り替えられる */
  function domainCard(): HTMLElement {
    const p = store.project;
    const pro = store.mode === 'pro';
    const gridText = h('div', { class: 'readout' });
    const nxOut = h('output', null, String(p.domain.nx));
    const slider = h('input', { type: 'range', min: 40, max: 600, step: 10, value: p.domain.nx, 'aria-label': '横のセル数' });
    slider.addEventListener('input', () => {
      change('nx', () => (store.project.domain.nx = Number(slider.value)));
      nxOut.textContent = slider.value;
    });
    const autoRadio = h('input', { type: 'radio', name: 'grid-mode', value: 'auto' });
    const manualRadio = h('input', { type: 'radio', name: 'grid-mode', value: 'manual' });
    const setAuto = (auto: boolean): void => {
      change('autoGrid', () => {
        const d = store.project.domain;
        if (!auto) d.nx = runner.grid?.nx ?? d.nx; // 手動にしたら、いま自動で使っている値から始める
        d.autoGrid = auto;
      });
      updateGrid();
    };
    autoRadio.addEventListener('change', () => autoRadio.checked && setAuto(true));
    manualRadio.addEventListener('change', () => manualRadio.checked && setAuto(false));
    const sliderRow = fieldRow('格子の細かさ（横のセル数）', h('div', { class: 'slider' }, slider, nxOut), undefined);
    const gridMode = h(
      'div',
      { class: 'pro-row' },
      h(
        'div',
        { class: 'pro-head' },
        h('span', { class: 'field-label' }, '格子の細かさ'),
        h('div', { class: 'seg mini', role: 'radiogroup', 'aria-label': '格子の自動・手動' }, h('label', null, autoRadio, h('span', null, '自動')), h('label', null, manualRadio, h('span', null, '手動'))),
      ),
    );
    gridMode.hidden = !pro;

    const updateGrid = (): void => {
      const d = store.project.domain;
      const auto = d.autoGrid !== false;
      const g = runner.grid;
      autoRadio.checked = auto;
      manualRadio.checked = !auto;
      // 手動のときは標準モードでもスライダーを見せる（隠れた設定にならないように）
      sliderRow.hidden = auto;
      const cells = g ? `格子 ${g.nx} × ${g.ny}（1セル ${formatQuantity(g.h, 'm')}）` : '格子を準備中';
      gridText.textContent = auto
        ? `自動: nx=${g?.nx ?? '…'}（${g?.reason ?? '準備中'}）。${g ? `${cells}。` : ''}${pro ? '' : '細かさを自分で決めるには「プロ」モードで手動にします'}`
        : `手動: ${cells}。細かいほどきれいですが、計算は重くなります${pro ? '' : '（プロモードで設定した値です）'}`;
      slider.value = String(d.nx);
      nxOut.textContent = slider.value;
    };
    derived.push(updateGrid);
    updateGrid();

    return section(
      '解析する範囲',
      h(
        'div',
        { class: 'row2' },
        numField({ label: '幅', unit: 'mm', value: p.domain.width * MM, min: 1, digits: 1, onChange: (v) => change('dw', () => (store.project.domain.width = v / MM)) }).root,
        numField({ label: '高さ', unit: 'mm', value: p.domain.height * MM, min: 1, digits: 1, onChange: (v) => change('dh', () => (store.project.domain.height = v / MM)) }).root,
      ),
      gridMode,
      sliderRow,
      gridText,
      numField({
        label: '厚さ（奥行き）',
        unit: 'mm',
        hint: '2D解析では、断面を奥行きのある板として扱います',
        value: p.thickness * MM,
        min: 0.01,
        digits: 2,
        onChange: (v) => change('th', () => (store.project.thickness = v / MM)),
      }).root,
    );
  }

  let lastGridKey = '';

  // 並び順は「解析の設定 → 解析する範囲 → 詳細設定（プロ）」。パネルは読み込みが終わり次第、それぞれの場所に入る
  const kindSlot = h('div', { class: 'panel-slot' });
  const proSlot = h('div', { class: 'panel-slot' });
  const kindPanel = createPanelSlot({ store, runner, container: kindSlot, slot: 'settings' });
  const proPanel = createPanelSlot({ store, runner, container: proSlot, slot: 'pro' });

  function build(): void {
    clear(host);
    derived.length = 0;
    // かんたんモードの質問パネルは easy-panel.ts が受け持つ
    host.hidden = store.mode === 'easy';
    kindPanel.mount(null);
    proPanel.mount(null);
    if (store.mode === 'easy') return;
    host.append(kindSlot, domainCard(), proSlot);
    kindPanel.mount(store.analysis);
    if (store.mode === 'pro') proPanel.mount(store.analysis);
  }

  const refreshAll = (): void => {
    derived.forEach((fn) => fn());
    kindPanel.refresh();
    proPanel.refresh();
  };

  store.on('analysis', build);
  store.on('load', build);
  store.on('mode', build);
  store.on('project', refreshAll);
  build();

  return {
    /** 毎フレーム呼ぶ。計算を作り直したとき・自動値が変わったときに表示を更新する */
    update(): void {
      kindPanel.update();
      proPanel.update();
      const g = runner.grid;
      const key = `${runner.generation}|${g?.nx}|${runner.result?.scalars.length ?? 0}`;
      if (key === lastGridKey) return;
      lastGridKey = key;
      refreshAll();
    },
  };
}
