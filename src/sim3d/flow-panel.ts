// 3D 解析の右側のパネルのうち、流れのときだけ出す部分: 設定（流体・風の向き・速さ・まわり・計算の細かさ）、
// 結果（レイノルズ数・抗力・揚力など）、表示（色にする量・流線・風洞の枠）。
// 状態は Sim3DModel にだけ持ち、ここは表示と入力だけ（panel.ts と同じ作り）。
import { h, numField, selectField } from '../ui/dom';
import { formatNumber } from '../ui/format';
import { flowScalar, flowVerdict3D, liftScalar } from './flow-verdict';
import {
  FLOW_DIRECTIONS,
  FLOW_QUALITY_OPTIONS,
  FLOW_SPEEDS,
  FLUID_OPTIONS,
  WALL_OPTIONS,
  flowGridInfo,
  flowOf,
  flowPartSize,
  flowQualityIdFor,
  flowSpeedIndex,
} from './flow-settings';
import type { ModelResult, Sim3DModel } from './model';

const MARKS = { ok: '✓', warn: '!', ng: '✕', info: 'i' } as const;
const CHIPS = { ok: 'OK', warn: '注意', ng: 'NG', info: '目安' } as const;

/** セルの一辺（mm）を読みやすく */
const mmText = (mm: number): string => `${formatNumber(mm, 3)} mm`;

/** 押されているかを aria-pressed で示す選択ボタン（panel.ts の `.s3d-seg` と同じ） */
function segButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  return h('button', { type: 'button', class: 's3d-seg', 'aria-pressed': 'false', title, onClick }, label);
}

export interface FlowCard {
  root: HTMLElement;
  /** 設定が変わったとき（入力中の欄は書き換えない） */
  refresh(): void;
}

/** 流れの設定のカード */
export function createFlowCard(model: Sim3DModel): FlowCard {
  const fluid = selectField('流体', FLUID_OPTIONS, flowOf(model.study).fluidId, (v) => model.setFlow({ fluidId: v }));

  // 風の向き（矢印付き）
  const dirBtns = FLOW_DIRECTIONS.map((d) => segButton(`${d.arrow} ${d.label}`, d.hint, () => model.setFlow({ direction: d.id })));
  for (const b of dirBtns) b.classList.add('s3d-dir');
  const dirGroup = h('div', { class: 's3d-segs', role: 'group', 'aria-label': '風の向き' }, ...dirBtns);

  // 速さ（そよ風・扇風機・自転車・車 + 数値）
  const speedBtns = FLOW_SPEEDS.map((s) => segButton(s.label, `${s.speed} m/s`, () => model.setFlow({ inletVelocity: s.speed })));
  const speedGroup = h('div', { class: 's3d-segs', role: 'group', 'aria-label': '風の速さ' }, ...speedBtns);
  const speed = numField({
    label: '風の速さ',
    unit: 'm/s',
    value: flowOf(model.study).inletVelocity,
    min: 0.01,
    max: 340,
    step: 'any',
    digits: 4,
    hint: 'そよ風 1・扇風機 3 m/s ほど。速いほど渦が出て、力が大きくなります',
    onChange: (v) => model.setFlow({ inletVelocity: v }),
  });

  // まわり
  const wallBtns = WALL_OPTIONS.map((w) => segButton(w.label, w.hint, () => model.setFlow({ walls: w.id })));
  const wallGroup = h('div', { class: 's3d-segs', role: 'group', 'aria-label': 'まわり' }, ...wallBtns);
  const wallHint = h('span', { class: 'hint' });

  // 計算の細かさと実際の格子
  const qualityBtns = FLOW_QUALITY_OPTIONS.map((q) => segButton(q.label, q.hint, () => model.setFlowQuality(q.id)));
  const qualityGroup = h('div', { class: 's3d-segs', role: 'group', 'aria-label': '計算の細かさ' }, ...qualityBtns);
  const gridInfo = h('div', { class: 'readout s3d-note s3d-gridinfo', role: 'status' });
  const gridWarn = h('div', { class: 's3d-warn', role: 'status', hidden: true });

  const root = h(
    'section',
    { class: 'card s3d-card s3d-flowcard', 'aria-label': '流れの設定' },
    h('h3', null, '風と風洞'),
    h('p', { class: 'hint' }, '部品を風洞（直方体の空間）の中に置いて、一様な風を当てます。風洞の大きさは、部品の大きさから自動で決まります。'),
    fluid.root,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, '風の向き'), dirGroup, h('span', { class: 'hint' }, '矢印の向きへ風が流れます。3D の図にも矢印が出ます')),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'どのくらいの速さ？'), speedGroup),
    speed.root,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'まわり'), wallGroup, wallHint),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, '計算の細かさ'), qualityGroup, h('span', { class: 'hint' }, '細かいほど形や渦に忠実ですが、進みが遅くなります')),
    gridInfo,
    gridWarn,
  );

  function refresh(): void {
    const f = flowOf(model.study);
    fluid.select.value = f.fluidId;
    FLOW_DIRECTIONS.forEach((d, i) => dirBtns[i].setAttribute('aria-pressed', String(d.id === f.direction)));
    const si = flowSpeedIndex(f.inletVelocity);
    speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === si)));
    speed.set(f.inletVelocity);
    WALL_OPTIONS.forEach((w, i) => wallBtns[i].setAttribute('aria-pressed', String(w.id === f.walls)));
    wallHint.textContent = WALL_OPTIONS.find((w) => w.id === f.walls)?.hint ?? '';
    const q = flowQualityIdFor(model.study.grid?.maxCells);
    FLOW_QUALITY_OPTIONS.forEach((o, i) => qualityBtns[i].setAttribute('aria-pressed', String(o.id === q)));
    const info = flowGridInfo(model.study);
    if (!info) {
      gridInfo.textContent = '格子を決められません（形が空です）';
      gridWarn.hidden = true;
      return;
    }
    const { grid } = info;
    const part = model.bounds ? flowPartSize(model.bounds, f.direction) : null;
    gridInfo.textContent = `風洞の格子 ${grid.nx} × ${grid.ny} × ${grid.nz}（約 ${formatNumber(info.cells / 1e4, 3)} 万セル・1 セル ${mmText(info.cellMm)}）。風が当たる部品の幅 D = ${mmText(info.d * 1e3)} が ${formatNumber(info.dCells, 3)} セル${part ? `、流れの向きの長さ ${mmText(part.length * 1e3)}` : ''}`;
    if (info.dCells < 8) {
      gridWarn.hidden = false;
      gridWarn.textContent = `部品の幅が ${formatNumber(info.dCells, 2)} セルしかありません。形が粗くなり、力の値もずれます。「細かい」にするか、部品を風洞に対して大きく取れる向きに変えてください。`;
    } else {
      gridWarn.hidden = true;
    }
  }
  refresh();
  return { root, refresh };
}

/** 流れの結果の中身（判定・数値）。res は表示中の結果、flowThroughs・running は計算の状態 */
export function flowResultBody(opts: { model: Sim3DModel; res: ModelResult; flowThroughs?: number; running: boolean; detailsOpen: boolean; onDetails: (open: boolean) => void }): HTMLElement[] {
  const { res } = opts;
  const v = flowVerdict3D({ result: res.data, flowThroughs: opts.flowThroughs, running: opts.running });
  const out: HTMLElement[] = [
    h(
      'div',
      { class: `verdict ${v.level} s3d-verdict`, role: 'status' },
      h('div', { class: 'verdict-top' }, h('span', { class: 'vchip' }, h('span', { 'aria-hidden': 'true' }, MARKS[v.level]), ` ${CHIPS[v.level]}`)),
      h('p', { class: 'verdict-head' }, v.title),
      v.lines.length > 0 ? h('ul', { class: 'verdict-lines' }, ...v.lines.map((l) => h('li', null, l))) : null,
    ),
  ];
  const lift = liftScalar(res.data);
  const main: [string, string][] = [];
  const row = (label: string, key: string, unit: string, sig = 4): void => {
    const val = flowScalar(res.data, key);
    if (val !== undefined) main.push([label, `${formatNumber(val, sig)}${unit ? ` ${unit}` : ''}`]);
  };
  row('レイノルズ数 Re', 'Re', '', 3);
  row('抗力', 'drag', 'N');
  row('抗力係数 Cd', 'Cd', '', 3);
  if (lift) main.push([lift.label, `${formatNumber(lift.value, 4)} N`]);
  row('経過時間', 'time', 's', 3);
  const shown = new Set(['Re', 'drag', 'Cd', 'time']);
  const rest = res.data.scalars.filter((s) => !shown.has(s.key) && !(lift && /^lift/i.test(s.key)) && Number.isFinite(s.value));
  const kv = (label: string, value: string): HTMLElement => h('div', { class: 's3d-kv' }, h('span', null, label), h('strong', null, value));
  out.push(h('div', { class: 's3d-kvs' }, ...main.map(([l, val]) => kv(l, val))));
  if (rest.length > 0) {
    const details = h('details', { class: 's3d-details', open: opts.detailsOpen }, h('summary', null, '計算の内部の値'), h('div', { class: 's3d-kvs' }, ...rest.map((s) => kv(s.label, `${formatNumber(s.value, 4)}${s.unit ? ` ${s.unit}` : ''}`))));
    details.addEventListener('toggle', () => opts.onDetails(details.open));
    out.push(details);
  }
  return out;
}

export interface FlowViewControls {
  root: HTMLElement;
  refresh(): void;
}

/** 表示の切り替え（色にする量・流線・風洞の枠）。流れのときだけ出す */
export function createFlowViewControls(model: Sim3DModel): FlowViewControls {
  const fieldBtns = [
    segButton('圧力', '部品の表面と断面を、圧力で色づけします（風が当たるところが高く、うしろが低い）', () => model.setView({ flowField: 'pressure' })),
    segButton('流速', '部品の表面と断面を、風の速さで色づけします', () => model.setView({ flowField: 'speed' })),
  ];
  const fieldGroup = h('div', { class: 's3d-segs', role: 'group', 'aria-label': '色にする量' }, ...fieldBtns);
  const streamBox = h('input', { type: 'checkbox', checked: true });
  streamBox.addEventListener('change', () => model.setView({ streamlines: streamBox.checked }));
  const tunnelBox = h('input', { type: 'checkbox', checked: true });
  tunnelBox.addEventListener('change', () => model.setView({ showTunnel: tunnelBox.checked }));
  const root = h(
    'div',
    { class: 's3d-flowview' },
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, '色にする量（表面・断面）'), fieldGroup),
    h('label', { class: 's3d-check' }, streamBox, h('span', null, '流線を描く（風の通り道。色は流速）')),
    h('label', { class: 's3d-check' }, tunnelBox, h('span', null, '風洞の枠と風の向きの矢印を出す')),
  );
  function refresh(): void {
    const v = model.view;
    fieldBtns.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0 ? 'pressure' : 'speed') === v.flowField)));
    streamBox.checked = v.streamlines;
    tunnelBox.checked = v.showTunnel;
  }
  refresh();
  return { root, refresh };
}
