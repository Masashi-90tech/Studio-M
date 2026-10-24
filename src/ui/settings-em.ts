// 電磁波（標準モード）の設定カード: 周波数・波源・偏波・背景。
import { getMaterial } from '../core/materials';
import { h, numField, section, selectField } from './dom';
import { clampEmPoint } from './easy-logic';
import { formatQuantity } from './format';
import type { PanelCtx } from './panel-kit';
import { fluidMaterials } from './project-utils';

const MM = 1000;
const C0 = 299_792_458;

/** 背景の媒質中の波長 [m] */
export function wavelengthM(freqGHz: number, epsR: number): number {
  return C0 / (freqGHz * 1e9 * Math.sqrt(Math.max(1, epsR)));
}

export function emCard(ctx: PanelCtx): HTMLElement {
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
