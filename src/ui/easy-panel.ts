// かんたんモードの右パネル: 解析ごとに短い質問に答えるだけで条件が決まる。
// 答えは Project（荷重・発熱・速度など）か、表示設定（安全率の目標など）に反映する。
import { getMaterial } from '../core/materials';
import type { AnalysisKind } from '../core/types';
import { clear, h, section } from './dom';
import {
  bodyMaterial,
  clampEmPoint,
  coolingIndex,
  EM_SENSORS,
  FLOW_SPEEDS,
  easyMaterialLabel,
  EASY_MATERIALS,
  findLoadShape,
  HEAT_PRESETS,
  loadKg,
  setBodyMaterial,
  setLoadKg,
  setSlabThicknessMm,
  setTotalHeatW,
  suggestEdgeRects,
  suggestHeatRect,
  totalHeatW,
  kgToNewton,
} from './easy-logic';
import { formatNumber } from './format';
import { SAFETY_CHOICES } from './modes';
import { chipRow, makeCtx, plainNumber, type PanelCtx } from './panel-kit';
import { characteristicLength, fluidMaterials } from './project-utils';
import type { Runner } from './runner';
import type { Store } from './state';
import { COOLING_LEVELS, findSlab, reynoldsWords } from './verdict';

const MM = 1000;

export function initEasyPanel(store: Store, runner: Runner, host: HTMLElement): { update: () => void } {
  const refreshers: (() => void)[] = [];
  const ctx: PanelCtx = makeCtx(store, runner, refreshers);
  let extra: (() => void) | null = null;

  /** 作図の補助: 形を置くボタン */
  const helperButton = (label: string, onClick: () => void): HTMLElement => h('button', { class: 'btn small primary', type: 'button', onclick: onClick }, label);

  const cellSize = (): number => runner.grid?.h ?? store.project.domain.width / store.project.domain.nx;

  const noBodyHint = (): HTMLElement =>
    h('div', { class: 'notice info' }, h('p', null, 'まだ部品がありません。左の「長方形」や「円」で形を描くか、上の「プリセット」から例を開きましょう。'));

  // 全物体に反映する材料の選択
  function materialPicker(label: string, hint?: string, roles?: ('solid' | 'heatSource')[]): HTMLElement {
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

  // ---------- 強度 ----------

  function stressPanel(): HTMLElement {
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
      card.append(
        h('div', { class: 'notice info' }, h('p', null, '力をかける場所がまだありません。'), helperButton('荷重を置く', () => placeEdge('load'))),
      );
    }
    if (!p.shapes.some((s) => s.role === 'support')) {
      card.append(
        h('div', { class: 'notice info' }, h('p', null, '固定する面（壁やネジ止め）がまだありません。'), helperButton('固定する面を置く', () => placeEdge('support'))),
      );
    }

    card.append(materialPicker('材料'));

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
  }

  /** 荷重・支持の面を、最初の物体の右端・左端に置く */
  function placeEdge(which: 'load' | 'support'): void {
    const rects = suggestEdgeRects(store.project, cellSize());
    if (!rects) return;
    if (which === 'load') {
      const kg = 5;
      store.addShape(rects.load, { role: 'load', name: `荷重 ${kg} kg`, force: { fx: 0, fy: -kgToNewton(kg) } });
    } else {
      store.addShape(rects.support, { role: 'support', name: '固定する面' });
    }
  }

  // ---------- 熱 ----------

  function heatPanel(): HTMLElement {
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
    card.append(amb.root, materialPicker('部品の材料（発熱体以外）', 'アルミは熱をよく逃がし、樹脂は熱がこもります', ['solid']));
    return card;
  }

  // ---------- 流れ ----------

  function flowPanel(): HTMLElement {
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
    extra = () => {
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
    return card;
  }

  // ---------- 電磁波 ----------

  function emPanel(): HTMLElement {
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
    card.append(sensor.root, ghz.root, goal.root, materialPicker('カバーの材料', '金属は電波を通さず、反射します'));

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
    return card;
  }

  function scalarPanel(): HTMLElement {
    return section(
      '対流拡散（動画の再現）',
      h('p', { class: 'hint' }, '動画と同じ「流れに運ばれて広がる量」の計算です。結果を Excel の数式ブックにして、セルの計算を自分の目で追えます。'),
      h('p', { class: 'hint' }, '流速・拡散係数を変えたいときは「標準」モードに切り替えてください。'),
    );
  }

  const builders: Record<AnalysisKind, () => HTMLElement> = { stress: stressPanel, heat: heatPanel, flow: flowPanel, em: emPanel, scalar: scalarPanel };

  function build(): void {
    clear(host);
    refreshers.length = 0;
    extra = null;
    host.hidden = store.mode !== 'easy';
    if (store.mode !== 'easy') return;
    host.append(builders[store.analysis]());
  }

  store.on('analysis', build);
  store.on('load', build);
  store.on('mode', build);
  store.on('selection', build);
  // 形の増減（荷重・発熱体を置いたなど）で出し分けが変わるときだけ作り直す。値の変更は表示だけ更新する
  let shapeSig = '';
  const sigOf = (): string => store.project.shapes.map((s) => `${s.id}:${s.role}`).join('|') + `|${store.project.em.source}`;
  store.on('project', () => {
    if (store.mode !== 'easy') return;
    const sig = sigOf();
    if (sig !== shapeSig) {
      shapeSig = sig;
      build();
    } else refreshers.forEach((fn) => fn());
  });
  shapeSig = sigOf();
  build();

  return {
    update(): void {
      if (store.mode === 'easy') extra?.();
    },
  };
}
