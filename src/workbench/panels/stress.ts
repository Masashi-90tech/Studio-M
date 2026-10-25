// 強度のパネル: 標準モードの設定カード、かんたんモードの質問、プロモードの詳細設定。
// ワークベンチ（modules/stress.ts）が遅延 import で読み込む。
import { kgToNewton } from '../../core/units';
import { checkField, h, section } from '../../ui/dom';
import { cellSize, helperButton, materialPicker, noBodyHint } from '../../ui/easy-kit';
import { findLoadShape, loadKg, setLoadKg, suggestEdgeRects } from '../../ui/easy-logic';
import { formatNumber } from '../../ui/format';
import { SAFETY_CHOICES } from '../../ui/modes';
import { cardPanel, chipRow, plainNumber, type PanelCtx } from '../../ui/panel-kit';
import { ITERATIVE_SPECS, proPanel } from '../../ui/pro-panel';

const MM = 1000;

/** 標準モード: 強度の設定 */
export const stressSettings = cardPanel((ctx) => {
  const s = ctx.store.project.stress;
  return section(
    '強度の設定',
    checkField('自重を考える', s.selfWeight, (v) => ctx.change('sw', () => (ctx.store.project.stress.selfWeight = v)), '重力は下向きにかかります。大きな部品や、軽い荷重のときに'),
    h(
      'p',
      { class: 'hint' },
      '使い方: 部品の形を描き、固定する面に役割「支持」、力をかける場所に役割「荷重」の図形を重ねます。応力は降伏応力（材料の限界）と比べて見ます。',
    ),
  );
});

/** 荷重・支持の面を、最初の物体の右端・左端に置く */
function placeEdge(ctx: PanelCtx, which: 'load' | 'support'): void {
  const { store } = ctx;
  const rects = suggestEdgeRects(store.project, cellSize(ctx));
  if (!rects) return;
  if (which === 'load') {
    const kg = 5;
    store.addShape(rects.load, { role: 'load', name: `荷重 ${kg} kg`, force: { fx: 0, fy: -kgToNewton(kg) } });
  } else {
    store.addShape(rects.support, { role: 'support', name: '固定する面' });
  }
}

/** かんたんモード: 壊れない？ どれだけ曲がる？ */
export const stressEasy = cardPanel((ctx) => {
  const { store } = ctx;
  const p = store.project;
  const card = section('強度をかんたんに調べる');
  const goal = chipRow(
    '何を知りたい？',
    [
      { value: 'safe', label: '壊れない？' },
      { value: 'bend', label: 'どれだけ曲がる？' },
    ],
    (v) => {
      store.setPrefs({ stressGoal: v });
      goal.set(v);
    },
  );
  goal.set(store.prefs.stressGoal);
  card.append(goal.root);

  if (!p.shapes.some((s) => s.role === 'solid')) {
    card.append(noBodyHint());
    return card;
  }

  // 荷重（重さ kg）
  const load = findLoadShape(p, store.selectedId);
  if (load) {
    const kg = plainNumber({
      label: 'かける重さ',
      unit: 'kg',
      hint: `荷重「${load.name}」の大きさ。1 kg = ${formatNumber(kgToNewton(1), 3)} N に換算します（向きはそのまま）`,
      value: Number(loadKg(load).toPrecision(4)),
      min: 0,
      onChange: (v) => ctx.change('easy:kg', () => setLoadKg(load, v)),
    });
    ctx.onRefresh(() => kg.set(Number(loadKg(load).toPrecision(4))));
    card.append(kg.root);
  } else {
    card.append(h('div', { class: 'notice info' }, h('p', null, '力をかける場所がまだありません。'), helperButton('荷重を置く', () => placeEdge(ctx, 'load'))));
  }
  if (!p.shapes.some((s) => s.role === 'support')) {
    card.append(
      h('div', { class: 'notice info' }, h('p', null, '固定する面（壁やネジ止め）がまだありません。'), helperButton('固定する面を置く', () => placeEdge(ctx, 'support'))),
    );
  }

  card.append(materialPicker(ctx, '材料'));

  const safety = chipRow(
    'どのくらい余裕がほしい？（安全率）',
    SAFETY_CHOICES.map((c) => ({ value: c.value, label: `${c.label}　${c.hint.split('（')[0]}`, hint: c.hint })),
    (v) => {
      store.setPrefs({ safetyTarget: v });
      safety.set(v);
    },
    '安全率 2 = 壊れる力の半分まで使う、という意味です',
  );
  safety.set(store.prefs.safetyTarget);
  card.append(safety.root);

  const depth = plainNumber({
    label: '部品の奥行き（厚み）',
    unit: 'mm',
    hint: '断面を奥行きのある板として扱います。厚くすると強くなります',
    value: p.thickness * MM,
    min: 0.01,
    onChange: (v) => ctx.change('easy:depth', () => (store.project.thickness = v / MM)),
  });
  ctx.onRefresh(() => depth.set(store.project.thickness * MM));
  card.append(depth.root);
  return card;
});

/** プロモード: 詳細設定（反復の収束判定など） */
export const stressPro = proPanel({ kind: 'stress', specs: ITERATIVE_SPECS });
