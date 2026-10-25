// 流れのパネル: 標準モードの設定カード、かんたんモードの質問、プロモードの詳細設定。
// ワークベンチ（modules/flow.ts）が遅延 import で読み込む。
import { getMaterial } from '../../core/materials';
import { chipRow, cardPanel, plainNumber } from '../../ui/panel-kit';
import { clear, h, numField, section, selectField } from '../../ui/dom';
import { noBodyHint } from '../../ui/easy-kit';
import { FLOW_SPEEDS } from '../../ui/easy-logic';
import { formatNumber, formatQuantity } from '../../ui/format';
import { proPanel, type Spec } from '../../ui/pro-panel';
import { characteristicLength, fluidMaterials } from '../../ui/project-utils';
import { reynoldsWords } from '../verdicts/flow';

/** 標準モード: 流れの設定 */
export const flowSettings = cardPanel((ctx) => {
  const { store, change } = ctx;
  const f = store.project.flow;
  const re = h('div', { class: 'readout' });
  const updateRe = (): void => {
    const p = store.project;
    let nu = 1.5e-5;
    try {
      nu = getMaterial(p.flow.fluidId).viscosity ?? nu;
    } catch {
      // 材料が見つからなければ空気の値で代用する
    }
    const L = characteristicLength(p);
    const Re = (p.flow.inletVelocity * L) / nu;
    re.textContent = `レイノルズ数の目安 Re ≈ ${formatNumber(Re, 2)}（代表長さ ${formatQuantity(L, 'm')}）。円柱では 50 を超えるあたりから渦が交互にできます`;
  };
  ctx.onRefresh(updateRe);
  updateRe();
  return section(
    '流れの設定',
    selectField(
      '流体',
      fluidMaterials().map((m) => ({ value: m.id, label: m.name })),
      f.fluidId,
      (v) => change('fluid', () => (store.project.flow.fluidId = v)),
    ).root,
    numField({
      label: '流入速度',
      unit: 'm/s',
      hint: '左から流れ込む速さ。ゆるい風 0.1〜1、扇風機 2〜5 m/s',
      value: f.inletVelocity,
      min: 0,
      digits: 4,
      onChange: (v) => change('u', () => (store.project.flow.inletVelocity = v)),
    }).root,
    selectField(
      '上下の壁',
      [
        { value: 'slip', label: 'すべる壁（対称・動画と同じ）' },
        { value: 'noslip', label: '壁面（粘着・管の中）' },
      ],
      f.walls,
      (v) => change('walls', () => (store.project.flow.walls = v === 'noslip' ? 'noslip' : 'slip')),
      'すべる壁は、広い空間の中に物体があるイメージ',
    ).root,
    re,
  );
});

/** かんたんモード: 何の流れか・どのくらいの速さか */
export const flowEasy = cardPanel((ctx) => {
  const { store, runner } = ctx;
  const p = store.project;
  const card = section('流れをかんたんに調べる');
  const fluid = chipRow('何の流れ？', fluidMaterials().map((m) => ({ value: m.id, label: m.name })), (v) => ctx.change('easy:fluid', () => (store.project.flow.fluidId = v)));
  const speed = chipRow('どのくらいの速さ？', FLOW_SPEEDS.map((x) => ({ value: x.speed, label: x.label })), (v) => ctx.change('easy:speed', () => (store.project.flow.inletVelocity = v)));
  const num = plainNumber({
    label: '速さ',
    unit: 'm/s',
    value: p.flow.inletVelocity,
    min: 0,
    onChange: (v) => ctx.change('easy:speed', () => (store.project.flow.inletVelocity = v)),
  });
  const words = h('div', { class: 'readout' });
  const sync = (): void => {
    const f = store.project.flow;
    fluid.set(f.fluidId);
    speed.set(FLOW_SPEEDS.find((x) => Math.abs(x.speed - f.inletVelocity) < 1e-9)?.speed ?? null);
    num.set(f.inletVelocity);
    let nu = 1.5e-5;
    try {
      nu = getMaterial(f.fluidId).viscosity ?? nu;
    } catch {
      // 空気の値で代用する
    }
    const re = (f.inletVelocity * characteristicLength(store.project)) / nu;
    words.textContent = `いまの条件は「${reynoldsWords(re)}」です（レイノルズ数 Re ≈ ${formatNumber(re, 2)}）`;
  };
  ctx.onRefresh(sync);
  sync();
  const warn = h('div', { class: 'notice warn', hidden: true });
  // 計算が出す注意（毎フレーム、変わったときだけ書き換える）
  const update = (): void => {
    const ws = runner.result?.warnings ?? [];
    const sig = ws.join('\n');
    if (warn.dataset.sig === sig) return;
    warn.dataset.sig = sig;
    warn.hidden = ws.length === 0;
    clear(warn);
    if (ws.length > 0) warn.append(h('p', null, 'この条件についての注意'), ...ws.map((w) => h('p', null, w)));
  };
  card.append(fluid.root, speed.root, num.root, words, warn);
  if (!p.shapes.some((s) => s.role === 'solid')) card.append(noBodyHint());
  return { root: card, update };
});

const FLOW_SPECS: Spec[] = [
  {
    type: 'num',
    key: 'smagorinskyCs',
    label: 'Smagorinsky 定数 Cs',
    hint: '乱流の渦粘性モデル。0 で無効。大きいほど安定しますが、細かい渦がなまります',
    min: 0,
    max: 1,
    initial: 0.1,
    scalarKeys: ['smagorinskyCs'],
    autoNote: 'レイノルズ数に合わせて自動',
  },
  {
    type: 'num',
    key: 'latticeU',
    label: '格子単位の流入速度',
    hint: '0.02〜0.15。小さいほど正確ですが、同じ時間を進めるのに多くのステップが要ります',
    min: 0.005,
    max: 0.2,
    initial: 0.05,
    scalarKeys: ['latticeU'],
    autoNote: '安定に動く範囲で自動',
  },
  {
    type: 'num',
    key: 'perturbation',
    label: '初期の揺らぎ',
    hint: '渦の発生を促す、最初のわずかな乱れの強さ。0 で無し',
    min: 0,
    max: 1,
    initial: 0.01,
    autoNote: '自動（左右対称が崩れるよう小さく付与）',
  },
];

/** プロモード: 詳細設定 */
export const flowPro = proPanel({ kind: 'flow', specs: FLOW_SPECS });
