// 熱のパネル: 標準モードの設定カード、かんたんモードの質問、プロモードの詳細設定。
// ワークベンチ（modules/heat.ts）が遅延 import で読み込む。
import type { EdgeBC, HeatSettings } from '../../core/types';
import { checkField, h, numField, section } from '../../ui/dom';
import { helperButton, materialPicker, noBodyHint } from '../../ui/easy-kit';
import { coolingIndex, HEAT_PRESETS, setTotalHeatW, suggestHeatRect, totalHeatW } from '../../ui/easy-logic';
import { cardPanel, chipRow, plainNumber, type PanelCtx } from '../../ui/panel-kit';
import { ITERATIVE_SPECS, proPanel } from '../../ui/pro-panel';
import { COOLING_LEVELS } from '../verdicts/heat';

/** 解析範囲の 1 辺の境界条件（断熱 / 温度固定 / 対流） */
function edgeRow(ctx: PanelCtx, label: string, side: keyof HeatSettings['edges']): HTMLElement {
  const { store, change } = ctx;
  const bc = store.project.heat.edges[side];
  const type = h(
    'select',
    { 'aria-label': `${label}の境界` },
    h('option', { value: 'adiabatic' }, '断熱'),
    h('option', { value: 'temp' }, '温度固定'),
    h('option', { value: 'convection' }, '対流'),
  );
  type.value = bc.type;
  const val = numField({
    label: '',
    value: bc.type === 'temp' ? bc.tempC : bc.type === 'convection' ? bc.h : 0,
    digits: 1,
    min: bc.type === 'convection' ? 0 : undefined,
    onChange: (v) => setEdge(side, readType(), v),
  });
  const unit = h('span', { class: 'unit' });
  const readType = (): EdgeBC['type'] => type.value as EdgeBC['type'];
  const sync = (): void => {
    val.input.hidden = type.value === 'adiabatic';
    unit.textContent = type.value === 'temp' ? '°C' : type.value === 'convection' ? 'W/m²K' : '';
  };
  const setEdge = (s: keyof HeatSettings['edges'], t: EdgeBC['type'], v: number): void => {
    const next: EdgeBC = t === 'temp' ? { type: 'temp', tempC: v } : t === 'convection' ? { type: 'convection', h: Math.max(0, v) } : { type: 'adiabatic' };
    change(`edge:${s}`, () => (store.project.heat.edges[s] = next));
  };
  type.addEventListener('change', () => {
    const v = Number.parseFloat(val.input.value);
    setEdge(side, readType(), Number.isFinite(v) ? v : readType() === 'convection' ? 10 : store.project.heat.ambientC);
    if (type.value !== 'adiabatic' && !Number.isFinite(v)) val.input.value = type.value === 'convection' ? '10' : String(store.project.heat.ambientC);
    sync();
  });
  sync();
  return h('div', { class: 'edge-row' }, h('span', { class: 'edge-name' }, label), type, val.input, unit);
}

/** 標準モード: 熱の設定 */
export const heatSettings = cardPanel((ctx) => {
  const { store, change } = ctx;
  const t = store.project.heat;
  return section(
    '熱の設定',
    numField({
      label: '周囲の温度',
      unit: '°C',
      hint: '部屋の空気の温度。物体のないところはこの温度の空気として扱います',
      value: t.ambientC,
      digits: 1,
      onChange: (v) => change('amb', () => (store.project.heat.ambientC = v)),
    }).root,
    numField({
      label: '熱伝達率',
      unit: 'W/m²K',
      hint: '自然対流 5〜10、ファン 20〜100 W/m²K',
      value: t.surfaceH,
      min: 0,
      digits: 1,
      onChange: (v) => change('h', () => (store.project.heat.surfaceH = v)),
    }).root,
    checkField('板の表裏からも放熱する', t.faceCooling, (v) => change('face', () => (store.project.heat.faceCooling = v)), '薄い板やヒートシンクでは大切です。厚みのある塊ならオフでも'),
    h('h4', null, '解析範囲の4辺'),
    h('p', { class: 'hint' }, '物体が辺に接しているときだけ効きます（取り付け面を冷やす・温めるなど）'),
    edgeRow(ctx, '左', 'left'),
    edgeRow(ctx, '右', 'right'),
    edgeRow(ctx, '上', 'top'),
    edgeRow(ctx, '下', 'bottom'),
  );
});

/** かんたんモード: 発熱・冷やし方・室温・材料 */
export const heatEasy = cardPanel((ctx) => {
  const { store } = ctx;
  const p = store.project;
  const card = section('熱をかんたんに調べる');
  if (!p.shapes.some((s) => s.role === 'solid' || s.role === 'heatSource')) {
    card.append(noBodyHint());
    return card;
  }
  const hasSource = p.shapes.some((s) => s.role === 'heatSource');
  if (!hasSource) {
    card.append(
      h(
        'div',
        { class: 'notice info' },
        h('p', null, '熱を出すもの（発熱体）がまだありません。'),
        helperButton('発熱体を置く', () => {
          const g = suggestHeatRect(store.project);
          if (g) store.addShape(g, { role: 'heatSource', name: '発熱体', heatW: 5 });
        }),
      ),
    );
  } else {
    const watt = chipRow('どれくらい熱くなるもの？（発熱）', HEAT_PRESETS.map((x) => ({ value: x.watt, label: x.label })), (v) => {
      ctx.change('easy:watt', () => setTotalHeatW(store.project, v));
    });
    const num = plainNumber({
      label: '発熱量',
      unit: 'W',
      value: Number(totalHeatW(p).toPrecision(4)),
      min: 0,
      onChange: (v) => ctx.change('easy:watt', () => setTotalHeatW(store.project, v)),
    });
    const sync = (): void => {
      const w = totalHeatW(store.project);
      watt.set(HEAT_PRESETS.find((x) => Math.abs(x.watt - w) < 1e-9)?.watt ?? null);
      num.set(Number(w.toPrecision(4)));
    };
    ctx.onRefresh(sync);
    sync();
    card.append(watt.root, num.root);
  }

  const cool = chipRow(
    '冷やし方',
    COOLING_LEVELS.map((c) => ({ value: c.h, label: c.label, hint: `熱伝達率 h = ${c.h} W/m²K` })),
    (v) => ctx.change('easy:cool', () => (store.project.heat.surfaceH = v)),
    '空気に熱を逃がす強さ（熱伝達率）に直して計算します',
  );
  const syncCool = (): void => {
    const i = coolingIndex(store.project.heat.surfaceH, COOLING_LEVELS);
    cool.set(i >= 0 ? COOLING_LEVELS[i].h : null);
  };
  ctx.onRefresh(syncCool);
  syncCool();
  card.append(cool.root);

  const amb = plainNumber({
    label: '室温',
    unit: '°C',
    value: p.heat.ambientC,
    onChange: (v) => ctx.change('easy:amb', () => (store.project.heat.ambientC = v)),
  });
  ctx.onRefresh(() => amb.set(store.project.heat.ambientC));
  card.append(amb.root, materialPicker(ctx, '部品の材料（発熱体以外）', 'アルミは熱をよく逃がし、樹脂は熱がこもります', ['solid']));
  return card;
});

/** プロモード: 詳細設定（反復の収束判定など） */
export const heatPro = proPanel({ kind: 'heat', specs: ITERATIVE_SPECS });
