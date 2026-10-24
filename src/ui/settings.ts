// 右パネルの「解析の設定」。選んでいる解析ごとに project.flow / heat / stress / scalar を編集する。
import { getMaterial } from '../core/materials';
import { gridSize } from '../core/raster';
import type { AnalysisKind, EdgeBC, HeatSettings } from '../core/types';
import { checkField, clear, fieldRow, h, numField, section, selectField } from './dom';
import { formatNumber, formatQuantity } from './format';
import { characteristicLength, fluidMaterials } from './project-utils';
import type { Store } from './state';

const MM = 1000;

export function initSettings(store: Store, host: HTMLElement): void {
  let derived: (() => void)[] = [];

  /** 値を書き換えて通知する。同じ欄の連続入力は 1 回の「元に戻す」にまとめる */
  const change = (key: string, apply: () => void): void => {
    store.checkpoint(`set:${key}`, 800);
    apply();
    store.touch('settings');
  };

  function domainCard(): HTMLElement {
    const p = store.project;
    const gridText = h('div', { class: 'readout' });
    const nxOut = h('output', null, String(p.domain.nx));
    const slider = h('input', { type: 'range', min: 50, max: 400, step: 10, value: p.domain.nx });
    slider.addEventListener('input', () => {
      change('nx', () => (store.project.domain.nx = Number(slider.value)));
      nxOut.textContent = slider.value;
    });
    const updateGrid = (): void => {
      const g = gridSize(store.project);
      gridText.textContent = `格子 ${g.nx} × ${g.ny}（1セル ${formatQuantity(g.h, 'm')}）。細かいほどきれいですが、計算は重くなります`;
      slider.value = String(store.project.domain.nx);
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
      fieldRow('格子の細かさ（横のセル数）', h('div', { class: 'slider' }, slider, nxOut), undefined),
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

  function flowCard(): HTMLElement {
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
    derived.push(updateRe);
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
  }

  function edgeRow(label: string, side: keyof HeatSettings['edges']): HTMLElement {
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

  function heatCard(): HTMLElement {
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
      edgeRow('左', 'left'),
      edgeRow('右', 'right'),
      edgeRow('上', 'top'),
      edgeRow('下', 'bottom'),
    );
  }

  function stressCard(): HTMLElement {
    const s = store.project.stress;
    return section(
      '強度の設定',
      checkField('自重を考える', s.selfWeight, (v) => change('sw', () => (store.project.stress.selfWeight = v)), '重力は下向きにかかります。大きな部品や、軽い荷重のときに'),
      h(
        'p',
        { class: 'hint' },
        '使い方: 部品の形を描き、固定する面に役割「支持」、力をかける場所に役割「荷重」の図形を重ねます。応力は降伏応力（材料の限界）と比べて見ます。',
      ),
    );
  }

  function scalarCard(): HTMLElement {
    const s = store.project.scalar;
    const pe = h('div', { class: 'readout' });
    const updatePe = (): void => {
      const p = store.project;
      const cell = p.domain.width / p.domain.nx;
      const Pe = (p.scalar.rho * Math.abs(p.scalar.u) * cell) / p.scalar.gamma;
      pe.textContent = `セルペクレ数 Pe = ρ·u·h/Γ ≈ ${formatNumber(Pe, 2)}。2 を超えると上流差分の数値拡散が目立ちます`;
    };
    derived.push(updatePe);
    updatePe();
    const num = (label: string, unit: string, hint: string, key: 'u' | 'gamma' | 'rho' | 'phiInlet' | 'phiBody', min?: number) =>
      numField({
        label,
        unit,
        hint,
        value: s[key],
        min,
        digits: 4,
        onChange: (v) => change(`sc:${key}`, () => (store.project.scalar[key] = v)),
      }).root;
    return section(
      '対流拡散の設定（動画と同じ）',
      num('流速 u', 'm/s', 'x方向の一様な流れ。大きいほど下流へ運ばれます', 'u'),
      num('拡散係数 Γ', 'kg/(m·s)', '大きいほどじわっと広がります（0 にはできません）', 'gamma', 1e-9),
      num('密度 ρ', 'kg/m³', '動画では 1', 'rho', 1e-9),
      num('流入側の φ', '', '左から入ってくる量（濃度・温度など）', 'phiInlet'),
      num('物体表面の φ', '', '物体の表面で固定する値', 'phiBody'),
      pe,
    );
  }

  function build(): void {
    clear(host);
    derived = [];
    const k: AnalysisKind = store.analysis;
    host.append(k === 'flow' ? flowCard() : k === 'heat' ? heatCard() : k === 'stress' ? stressCard() : scalarCard(), domainCard());
  }

  store.on('analysis', build);
  store.on('load', build);
  store.on('project', () => derived.forEach((fn) => fn()));
  build();
}
