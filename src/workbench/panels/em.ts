// 電磁波のパネル: 標準モードの設定カード（周波数・波源・偏波・背景）、かんたんモードの質問、プロモードの詳細設定。
// ワークベンチ（modules/em.ts）が遅延 import で読み込む。
import { getMaterial } from '../../core/materials';
import { h, numField, section, selectField } from '../../ui/dom';
import { helperButton, materialPicker, noBodyHint } from '../../ui/easy-kit';
import { clampEmPoint, EM_SENSORS, setSlabThicknessMm } from '../../ui/easy-logic';
import { formatQuantity } from '../../ui/format';
import { cardPanel, chipRow, plainNumber, type PanelCtx } from '../../ui/panel-kit';
import { proPanel, type Spec } from '../../ui/pro-panel';
import { fluidMaterials } from '../../ui/project-utils';
import { findSlab } from '../verdicts/em';

const MM = 1000;
const C0 = 299_792_458;

/** 背景の媒質中の波長 [m] */
export function wavelengthM(freqGHz: number, epsR: number): number {
  return C0 / (freqGHz * 1e9 * Math.sqrt(Math.max(1, epsR)));
}

function emCard(ctx: PanelCtx): HTMLElement {
  const { store, change } = ctx;
  const e0 = store.project.em;

  const readout = h('div', { class: 'readout' });
  const update = (): void => {
    const p = store.project;
    let eps = 1;
    try {
      eps = getMaterial(p.em.mediumId).epsR ?? 1;
    } catch {
      // 材料が見つからなければ空気として扱う
    }
    const lam = wavelengthM(p.em.frequencyGHz, eps);
    readout.textContent = `波長 λ ≈ ${formatQuantity(lam, 'm')}（背景の中）。領域の幅は λ の約 ${(p.domain.width / lam).toFixed(1)} 倍です`;
    planeGroup.hidden = p.em.source !== 'plane';
    pointGroup.hidden = p.em.source !== 'point';
    polHint.textContent = p.em.polarization === 'TM' ? TM_HINT : TE_HINT;
    xField.set(p.em.pointX * MM);
    yField.set(p.em.pointY * MM);
  };
  ctx.onRefresh(update);

  const TM_HINT = 'TM: 電場が紙面に垂直（紙面を突き抜ける向き）。紙面に垂直に立てたアンテナ線の波に当たります';
  const TE_HINT = 'TE: 磁場が紙面に垂直で、電場は紙面の中を向きます。金属板の縁での回り込み方が TM と変わります';
  const polHint = h('span', { class: 'hint' });

  const xField = numField({
    label: '波源の位置 x',
    unit: 'mm',
    hint: 'キャンバス上の ● をドラッグしても動かせます',
    value: e0.pointX * MM,
    digits: 1,
    onChange: (v) => change('em:px', () => (store.project.em.pointX = v / MM)),
  });
  const yField = numField({
    label: '波源の位置 y',
    unit: 'mm',
    value: e0.pointY * MM,
    digits: 1,
    onChange: (v) => change('em:py', () => (store.project.em.pointY = v / MM)),
  });
  const planeGroup = h(
    'div',
    { class: 'group' },
    numField({
      label: '電波の来る向き',
      unit: '°',
      hint: '0° = 左から右へ進む、90° = 下から上へ進む',
      value: e0.angleDeg,
      digits: 1,
      onChange: (v) => change('em:ang', () => (store.project.em.angleDeg = v)),
    }).root,
  );
  const pointGroup = h('div', { class: 'row2' }, xField.root, yField.root);

  const polField = selectField(
    '偏波',
    [
      { value: 'TM', label: 'TM（電場が紙面に垂直）' },
      { value: 'TE', label: 'TE（磁場が紙面に垂直）' },
    ],
    e0.polarization,
    (v) => change('em:pol', () => (store.project.em.polarization = v === 'TE' ? 'TE' : 'TM')),
  );
  polField.root.querySelector('.hint')?.remove();
  polField.root.append(polHint);

  const card = section(
    '電磁波の設定',
    numField({
      label: '周波数',
      unit: 'GHz',
      hint: 'Wi-Fi 2.4 / 5、人感センサー 24、車載レーダー 77 など',
      value: e0.frequencyGHz,
      min: 0.01,
      max: 1000,
      digits: 3,
      onChange: (v) => change('em:f', () => (store.project.em.frequencyGHz = v)),
    }).root,
    readout,
    selectField(
      '波源',
      [
        { value: 'plane', label: '平面波（遠くのレーダーから来る波）' },
        { value: 'point', label: '点波源（アンテナ）' },
      ],
      e0.source,
      (v) =>
        change('em:src', () => {
          store.project.em.source = v === 'point' ? 'point' : 'plane';
          if (v === 'point') {
            // 領域の外にあるときは見える位置に置き直す
            const q = clampEmPoint(store.project);
            store.project.em.pointX = q.x;
            store.project.em.pointY = q.y;
          }
        }),
    ).root,
    planeGroup,
    pointGroup,
    polField.root,
    selectField(
      '背景',
      fluidMaterials().map((m) => ({ value: m.id, label: `${m.name}（εr ${m.epsR ?? 1}）` })),
      e0.mediumId,
      (v) => change('em:med', () => (store.project.em.mediumId = v)),
      '物体のない部分を満たす媒質。水中では波長が短くなり、損失も大きくなります',
    ).root,
    h('p', { class: 'hint' }, '物体の材料は、キャンバス上部の「材料」か、図形を選んで変えます。金属は電場 0 の壁（完全導体）として扱います。吸収境界（PML）が外周にあるので、物体は外周から少し離して置きます。'),
  );
  update();
  return card;
}

/** 標準モード: 電磁波の設定 */
export const emSettings = cardPanel(emCard);

/** かんたんモード: どんな電波か・知りたいこと・カバーの材料と厚み */
export const emEasy = cardPanel((ctx) => {
  const { store } = ctx;
  const p = store.project;
  const card = section('電波をかんたんに調べる');
  if (!p.shapes.some((s) => s.role === 'solid')) {
    card.append(noBodyHint());
  }
  const sensor = chipRow(
    'どんな電波？',
    EM_SENSORS.map((x) => ({ value: x.ghz, label: x.label, hint: x.hint })),
    (v) => ctx.change('easy:ghz', () => (store.project.em.frequencyGHz = v)),
  );
  const ghz = plainNumber({
    label: '周波数',
    unit: 'GHz',
    value: p.em.frequencyGHz,
    min: 0.01,
    max: 1000,
    onChange: (v) => ctx.change('easy:ghz', () => (store.project.em.frequencyGHz = v)),
  });
  const goal = chipRow(
    '知りたいこと',
    [
      { value: 'cover', label: 'カバーで電波が弱くならない？' },
      { value: 'reflect', label: 'どこに反射する？' },
    ],
    (v) => {
      store.setPrefs({ emGoal: v });
      // 「反射」は散乱波（物体が作る波）を、「カバー」は電波そのものを見せる
      store.fieldKeys.em = v === 'reflect' ? 'scattered' : 'field';
      goal.set(v);
      store.emit('view');
    },
  );
  goal.set(store.prefs.emGoal);
  const sync = (): void => {
    const f = store.project.em.frequencyGHz;
    sensor.set(EM_SENSORS.find((x) => Math.abs(x.ghz - f) < 1e-9)?.ghz ?? null);
    ghz.set(f);
  };
  ctx.onRefresh(sync);
  sync();
  card.append(sensor.root, ghz.root, goal.root, materialPicker(ctx, 'カバーの材料', '金属は電波を通さず、反射します'));

  const slab = findSlab(p);
  if (slab) {
    const t = plainNumber({
      label: 'カバーの厚み',
      unit: 'mm',
      hint: '電波の波長に合う厚みだと、ほとんど素通りします。判定の「おすすめの厚み」も参考に',
      value: Number((slab.thicknessM * MM).toPrecision(4)),
      min: 0.1,
      onChange: (v) =>
        ctx.change('easy:slab', () => {
          const s = findSlab(store.project);
          if (s) setSlabThicknessMm(s.shape, v);
        }),
    });
    ctx.onRefresh(() => {
      const s = findSlab(store.project);
      if (s) t.set(Number((s.thicknessM * MM).toPrecision(4)));
    });
    card.append(t.root);
  }
  if (p.em.source === 'point') {
    const q = clampEmPoint(p);
    if (q.x !== p.em.pointX || q.y !== p.em.pointY) {
      card.append(
        h('div', { class: 'notice info' }, h('p', null, 'アンテナ（点波源）が領域の外にあります。'), helperButton('見える場所に置く', () => ctx.change('easy:pt', () => {
          const r = clampEmPoint(store.project);
          store.project.em.pointX = r.x;
          store.project.em.pointY = r.y;
        }))),
      );
    }
  }
  // 点波源か平面波かで「アンテナが領域の外」の案内が変わるので、変わったら作り直してもらう
  return { root: card, structureKey: () => store.project.em.source };
});

const EM_SPECS: Spec[] = [
  {
    type: 'num',
    key: 'cellsPerWavelength',
    label: '1波長あたりのセル数',
    unit: 'セル',
    hint: '媒質中の最短波長に対する分割数。大きいほど正確ですが、重くなります',
    min: 4,
    max: 200,
    initial: 20,
    scalarKeys: ['cellsPerWavelength'],
    autoNote: '既定 20',
  },
  {
    type: 'num',
    key: 'pmlCells',
    label: '吸収境界（PML）の厚さ',
    unit: 'セル',
    hint: '外周で電波を吸い込む層。薄いと端で反射が戻ります',
    min: 4,
    max: 60,
    initial: 12,
    scalarKeys: ['pmlCells'],
    autoNote: '既定 12',
  },
  {
    type: 'num',
    key: 'courant',
    label: 'クーラン数',
    hint: '時間刻みの大きさ。2D の安定限界は 0.707。小さいほど安全で遅くなります',
    min: 0.05,
    max: 0.7071,
    initial: 0.5,
    scalarKeys: ['courant'],
    autoNote: '既定 0.5',
  },
  {
    type: 'enum',
    key: 'waveform',
    label: '波形',
    hint: '連続波は定常状態の分布、パルスは過渡的な伝わり方を見ます',
    options: [
      { value: 'cw', label: '連続波（cw）' },
      { value: 'pulse', label: 'ガウスパルス' },
    ],
    initial: 'cw',
    autoNote: '連続波',
  },
];

/** プロモード: 詳細設定 */
export const emPro = proPanel({ kind: 'em', specs: EM_SPECS });
