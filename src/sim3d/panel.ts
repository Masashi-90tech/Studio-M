// 3D 解析の右側のパネル: 設定、面の条件、計算の細かさと実行、結果、断面。
// 状態は Sim3DModel にだけ持ち、ここは表示と入力だけ（値を変えたらモデルに伝え、モデルが変わったら表示を合わせる）。
import { MATERIALS, getMaterial } from '../core/materials';
import type { Region3D, Region3DRole, ResultSet3D } from '../core/types';
import { clear, fieldRow, h, numField, selectField, toast } from '../ui/dom';
import { formatNumber } from '../ui/format';
import { facesArea } from './faces';
import type { ModelEvent, Sim3DModel } from './model';
import { HEAT_ROLES, ROLE_INFO, regionValueText, valueKeyOf } from './regions';
import { RESULT_COLORMAP, fieldRange3D, hasValues, legendStops, resultField } from './result-view';
import type { Sim3DRunner } from './runner';
import { COOLING_OPTIONS, QUALITY_OPTIONS, coolingIdFor, previewGrid, qualityIdFor } from './settings';
import { heatVerdict3D } from './verdict';
import { AXIS_NAMES, type Axis } from '../mesh3d/types';

const MARKS = { ok: '✓', warn: '!', ng: '✕', info: 'i' } as const;
const SLIDER_STEPS = 1000;
const CHIPS = { ok: 'OK', warn: '注意', ng: 'NG', info: '目安' } as const;

const cm2 = (m2: number): string => `${formatNumber(m2 * 1e4, 3)} cm²`;
const mm = (m: number): string => `${formatNumber(m * 1e3, 4)} mm`;
const AXIS_HINT = ['X（横から）', 'Y（前から）', 'Z（上から）'] as const;

export interface PanelResult {
  root: HTMLElement;
  /** モデルが変わったとき */
  refresh(e: ModelEvent): void;
}

export function createPanel(opts: { model: Sim3DModel; runner: Sim3DRunner }): PanelResult {
  const { model, runner } = opts;

  // ---------- 設定 ----------
  const solids = MATERIALS.filter((m) => m.kind === 'solid');
  const materialNote = h('div', { class: 'readout s3d-note' });
  const materialSel = selectField('材料', solids.map((m) => ({ value: m.id, label: m.name })), model.study.materialId, (v) => model.setMaterial(v));
  const updateMaterialNote = (): void => {
    const m = getMaterial(model.study.materialId);
    materialNote.textContent = `熱伝導率 ${formatNumber(m.k, 3)} W/(m·K)・${m.maxTempC !== undefined ? `耐熱の目安 ${m.maxTempC}°C` : '耐熱温度の目安は入っていません'}${m.note ? `。${m.note}` : ''}`;
  };
  updateMaterialNote();
  materialSel.select.addEventListener('change', updateMaterialNote);
  const ambient = numField({ label: '周囲の温度', unit: '°C', value: model.study.heat.ambientC, min: -60, max: 1000, step: 'any', digits: 3, onChange: (v) => model.setAmbient(v) });
  const hField = numField({
    label: '熱伝達率 h',
    unit: 'W/(m²·K)',
    value: model.study.heat.surfaceH,
    min: 0.1,
    max: 10000,
    step: 'any',
    digits: 3,
    hint: '条件を置いていない面すべての熱の逃げやすさ（自然放置でおよそ 5〜10、ファンで 20〜100）',
    onChange: (v) => {
      model.setSurfaceH(v);
      coolingSel.select.value = coolingIdFor(v);
    },
  });
  const coolingSel = selectField(
    'まわりの冷え方',
    COOLING_OPTIONS.map((o) => ({ value: o.id, label: o.label })),
    coolingIdFor(model.study.heat.surfaceH),
    (id) => {
      const o = COOLING_OPTIONS.find((x) => x.id === id);
      if (o?.h !== undefined) {
        model.setSurfaceH(o.h);
        hField.input.value = String(o.h);
        hField.input.classList.remove('invalid');
      } else {
        hField.input.focus();
        hField.input.select();
      }
    },
  );
  const bodyHeat = numField({
    label: '部品全体の発熱（任意）',
    unit: 'W',
    value: model.study.heat.bodyHeatW ?? 0,
    min: 0,
    max: 100000,
    step: 'any',
    digits: 3,
    hint: '部品の中が均等に発熱するとき。面から入れる熱は、下の「面の条件」で足します',
    onChange: (v) => model.setBodyHeat(v),
  });
  const settingsCard = h('section', { class: 'card s3d-card' }, h('h3', null, '材料とまわりの環境'), materialSel.root, materialNote, h('div', { class: 's3d-two' }, ambient.root, coolingSel.root), hField.root, bodyHeat.root);

  // ---------- 面の条件 ----------
  const selInfo = h('div', { class: 'readout s3d-selinfo', role: 'status', 'aria-live': 'polite' });
  const addBtns = HEAT_ROLES.map((role) =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn small s3d-add',
        title: ROLE_INFO[role].hint,
        disabled: true,
        'data-role': role,
        onClick: () => addFromSelection(role),
      },
      h('span', { class: 's3d-dot', style: `background:${ROLE_INFO[role].css}`, 'aria-hidden': 'true' }),
      ROLE_INFO[role].label,
    ),
  );
  const regionList = h('ul', { class: 's3d-regions', 'aria-label': '面の条件の一覧' });
  const regionsCard = h(
    'section',
    { class: 'card s3d-card' },
    h('h3', null, '面の条件'),
    h('p', { class: 'hint' }, '3D の図で面をクリックして選び（Shift / Ctrl を押しながらで足す）、条件を足します。何も足さなければ、全体が「周囲の温度」と熱の逃げやすさ h だけで決まります。'),
    selInfo,
    h('div', { class: 'btn-row s3d-adds' }, ...addBtns),
    regionList,
  );

  function addFromSelection(role: Region3DRole): void {
    try {
      const r = model.addRegionFromSelection(role);
      if (r.removed.length > 0) toast(`面が新しい条件に移ったので、「${r.removed.join('」「')}」は削除しました。`);
    } catch (e) {
      toast(e instanceof Error ? e.message : '条件を足せませんでした', 'error');
    }
  }

  let regionsKey = '';
  function renderRegions(): void {
    const sel = model.selection.size;
    const area = sel > 0 ? facesArea(model.study.mesh, [...model.selection]) : 0;
    selInfo.textContent = sel > 0 ? `選択中: ${sel.toLocaleString('ja-JP')} 面・面積 ${cm2(area)}` : '面が選ばれていません（3D の図で面をクリック）';
    for (const b of addBtns) b.disabled = sel === 0;
    const key = model.study.regions.map((r) => `${r.id}:${r.role}`).join(',') + `|${model.activeRegionId}`;
    if (key === regionsKey) {
      // 値や名前の入力中に作り直さない。面の数の表示だけ合わせる
      return;
    }
    regionsKey = key;
    clear(regionList);
    if (model.study.regions.length === 0) {
      regionList.append(h('li', { class: 'hint s3d-empty' }, 'まだ条件がありません'));
      return;
    }
    for (const r of model.study.regions) regionList.append(regionRow(r));
  }

  function regionRow(r: Region3D): HTMLElement {
    const info = ROLE_INFO[r.role];
    const active = model.activeRegionId === r.id;
    const name = h('input', { type: 'text', class: 's3d-name', value: r.name, 'aria-label': `${info.label}の条件の名前`, maxlength: '40' });
    name.addEventListener('input', () => model.editRegion(r.id, { name: name.value }));
    name.addEventListener('click', (e) => e.stopPropagation());
    const key = valueKeyOf(r.role);
    let valueEl: HTMLElement;
    if (key) {
      const input = h('input', { type: 'number', inputmode: 'decimal', step: 'any', class: 's3d-val', value: String(r[key] ?? 0), 'aria-label': `${r.name}の値（${info.unit}）` });
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        const ok = Number.isFinite(v) && (key !== 'h' || v > 0) && (key !== 'heatW' || v >= 0);
        input.classList.toggle('invalid', !ok);
        if (ok) model.editRegion(r.id, { value: v });
      });
      input.addEventListener('click', (e) => e.stopPropagation());
      valueEl = h('span', { class: 's3d-valbox' }, input, h('span', { class: 'unit' }, info.unit));
    } else {
      valueEl = h('span', { class: 'unit s3d-valbox' }, regionValueText(r));
    }
    const faces = r.faces.length;
    return h(
      'li',
      { class: `s3d-region${active ? ' active' : ''}`, 'aria-current': active ? 'true' : 'false' },
      h(
        'div',
        { class: 's3d-region-main', onClick: () => model.setActiveRegion(active ? null : r.id) },
        h('span', { class: 's3d-dot', style: `background:${info.css}`, 'aria-hidden': 'true' }),
        name,
        h('span', { class: 's3d-role' }, info.label),
        valueEl,
        h('button', { type: 'button', class: 'btn small s3d-del', 'aria-label': `${r.name}を削除`, title: '削除', onClick: (e: Event) => {
          e.stopPropagation();
          model.deleteRegion(r.id);
        } }, '削除'),
      ),
      h('div', { class: 'hint s3d-region-meta' }, `${faces.toLocaleString('ja-JP')} 面・面積 ${cm2(facesArea(model.study.mesh, r.faces))}`),
    );
  }

  // ---------- 計算の細かさ・実行 ----------
  const gridInfo = h('div', { class: 'readout s3d-note', role: 'status' });
  const qualityBtns = QUALITY_OPTIONS.map((q) =>
    h('button', { type: 'button', class: 's3d-seg', 'aria-pressed': 'false', title: q.hint, onClick: () => model.setQuality(q.id) }, q.label),
  );
  const qualityGroup = h('div', { class: 's3d-segs', role: 'group', 'aria-label': '計算の細かさ' }, ...qualityBtns);
  const runBtn = h('button', { type: 'button', class: 'btn primary s3d-run', onClick: () => runner.start() }, '計算する');
  const cancelBtn = h('button', { type: 'button', class: 'btn s3d-cancel', hidden: true, onClick: () => runner.cancel() }, '中止');
  const progress = h('progress', { class: 's3d-progress', max: '1', value: '0', hidden: true, 'aria-label': '計算の進み具合' });
  const runInfo = h('div', { class: 'readout s3d-runinfo', role: 'status', 'aria-live': 'polite', hidden: true });
  const runCard = h(
    'section',
    { class: 'card s3d-card' },
    h('h3', null, '計算'),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, '計算の細かさ'), qualityGroup, h('span', { class: 'hint' }, '細かいほど形に忠実ですが、時間とメモリがかかります')),
    gridInfo,
    h('div', { class: 'btn-row' }, runBtn, cancelBtn),
    progress,
    runInfo,
  );

  function renderQuality(): void {
    const id = qualityIdFor(model.study.grid?.maxCells);
    qualityBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(QUALITY_OPTIONS[i].id === id)));
    const g = previewGrid(model.bounds, model.study.grid);
    gridInfo.textContent = g
      ? `格子 ${g.nx} × ${g.ny} × ${g.nz}（約 ${formatNumber((g.nx * g.ny * g.nz) / 1e4, 3)} 万セル・1 セル ${formatNumber(g.h * 1e3, 3)} mm）`
      : '格子を決められません（形が空です）';
  }

  function renderRun(): void {
    const run = model.run;
    const busy = run.kind === 'loading' || run.kind === 'running';
    runBtn.disabled = busy;
    runBtn.textContent = model.result ? '計算し直す' : '計算する';
    cancelBtn.hidden = !busy;
    progress.hidden = !busy;
    runInfo.hidden = run.kind === 'idle';
    runInfo.classList.toggle('error', run.kind === 'error');
    if (run.kind === 'loading') {
      runInfo.textContent = '解析エンジンを準備しています…';
      progress.removeAttribute('value');
    } else if (run.kind === 'running') {
      progress.value = Math.max(0, Math.min(1, run.progress));
      const secs = (performance.now() - run.startedAt) / 1000;
      runInfo.textContent = `反復 ${run.iteration.toLocaleString('ja-JP')}${run.residual !== undefined ? `・残差 ${run.residual.toExponential(2)}` : ''}・${formatNumber(secs, 3)} 秒${run.message ? `・${run.message}` : ''}`;
    } else if (run.kind === 'error') {
      runInfo.textContent = run.message;
    } else if (run.kind === 'cancelled') {
      runInfo.textContent = '計算を中止しました。前の結果はそのまま残っています。';
    }
  }

  // ---------- 結果 ----------
  const resultCard = h('section', { class: 'card s3d-card s3d-result', hidden: true, 'aria-label': '計算の結果' });

  function scalarRows(rs: ResultSet3D): HTMLElement[] {
    return rs.scalars
      .filter((s) => Number.isFinite(s.value))
      .map((s) => h('div', { class: 's3d-kv' }, h('span', null, s.label), h('strong', null, `${formatNumber(s.value, 4)} ${s.unit}`)));
  }

  function perRegionTable(rs: ResultSet3D): HTMLElement | null {
    const rows = rs.perRegion ?? [];
    if (rows.length === 0) return null;
    const val = (r: (typeof rows)[number], key: string): string => {
      const v = r.values.find((x) => x.key === key);
      return v && Number.isFinite(v.value) ? `${formatNumber(v.value, 4)} ${v.unit}` : '—';
    };
    return h(
      'table',
      { class: 's3d-table' },
      h('thead', null, h('tr', null, h('th', null, '条件'), h('th', null, '最高'), h('th', null, '平均'))),
      h(
        'tbody',
        null,
        ...rows.map((r) => {
          const reg = model.study.regions.find((x) => x.id === r.shapeId);
          return h('tr', null, h('td', null, reg?.name ?? r.label), h('td', null, val(r, 'maxTemp')), h('td', null, val(r, 'avgTemp')));
        }),
      ),
    );
  }

  function renderResult(): void {
    const res = model.result;
    resultCard.hidden = !res;
    if (!res) return;
    const stale = model.stale;
    clear(resultCard);
    resultCard.classList.toggle('stale', stale);
    const v = heatVerdict3D({ result: res.data, study: model.study });
    resultCard.append(h('h3', null, '結果', h('span', { class: 'unit' }, ` ${res.data.label ?? 'Lite（ブラウザの中の計算）'}`)));
    if (stale) resultCard.append(h('div', { class: 's3d-stale', role: 'status' }, '条件や設定を変えました。いまの表示は前の結果です。もう一度「計算し直す」を押してください。'));
    resultCard.append(
      h(
        'div',
        { class: `verdict ${v.level} s3d-verdict`, role: 'status' },
        h('div', { class: 'verdict-top' }, h('span', { class: 'vchip' }, h('span', { 'aria-hidden': 'true' }, MARKS[v.level]), ` ${CHIPS[v.level]}`)),
        h('p', { class: 'verdict-head' }, v.title),
        v.lines.length > 0 ? h('ul', { class: 'verdict-lines' }, ...v.lines.map((l) => h('li', null, l))) : null,
      ),
      h('div', { class: 's3d-kvs' }, ...scalarRows(res.data)),
    );
    const t = perRegionTable(res.data);
    if (t) resultCard.append(h('h4', null, '条件ごとの温度'), t);
    if (res.data.warnings.length > 0) {
      resultCard.append(h('div', { class: 's3d-warn', role: 'status' }, ...res.data.warnings.map((w) => h('div', null, w))));
    }
  }

  // ---------- 断面 ----------
  const sectionOn = h('input', { type: 'checkbox' });
  const sectionRow = h('label', { class: 's3d-check' }, sectionOn, h('span', null, '切って中を見る（断面）'));
  sectionOn.addEventListener('change', () => model.setSection({ on: sectionOn.checked }));
  const axisBtns = ([0, 1, 2] as Axis[]).map((a) => h('button', { type: 'button', class: 's3d-seg', 'aria-pressed': 'false', onClick: () => model.setSection({ axis: a }) }, AXIS_HINT[a]));
  const axisGroup = h('div', { class: 's3d-segs', role: 'group', 'aria-label': '切る軸' }, ...axisBtns);
  const slider = h('input', { type: 'range', class: 's3d-slider', min: '0', max: String(SLIDER_STEPS), step: '1', value: String(SLIDER_STEPS / 2), 'aria-label': '切る位置' });
  const posInfo = h('div', { class: 'readout s3d-note', role: 'status' });
  const flipBox = h('input', { type: 'checkbox' });
  const flipRow = h('label', { class: 's3d-check' }, flipBox, h('span', null, '切る向きを反対にする（隠す側を入れ替える）'));
  flipBox.addEventListener('change', () => model.setSection({ flip: flipBox.checked }));
  const b = model.bounds;
  slider.addEventListener('input', () => {
    if (!b) return;
    const a = model.section.axis;
    const t = Number(slider.value) / SLIDER_STEPS;
    model.setSection({ position: b.min[a] + t * (b.max[a] - b.min[a]) });
  });
  const resultToggle = h('input', { type: 'checkbox', checked: true });
  resultToggle.addEventListener('change', () => model.setView({ showResult: resultToggle.checked }));
  const regionToggle = h('input', { type: 'checkbox', checked: true });
  regionToggle.addEventListener('change', () => model.setView({ showRegions: regionToggle.checked }));
  const sectionBody = h('div', { class: 's3d-section-body' }, axisGroup, fieldRow('切る位置', slider), posInfo, flipRow);
  const sectionCard = h(
    'section',
    { class: 'card s3d-card' },
    h('h3', null, '断面と表示'),
    sectionRow,
    sectionBody,
    h('label', { class: 's3d-check' }, resultToggle, h('span', null, '結果の色を表面に出す')),
    h('label', { class: 's3d-check' }, regionToggle, h('span', null, '条件を置いた面を色で見せる')),
  );

  function renderSection(): void {
    const s = model.section;
    sectionOn.checked = s.on;
    sectionBody.classList.toggle('off', !s.on);
    axisBtns.forEach((btn, i) => btn.setAttribute('aria-pressed', String(i === s.axis)));
    for (const el of [slider, flipBox, ...axisBtns]) (el as HTMLInputElement).disabled = !s.on;
    if (b) {
      const t = b.max[s.axis] > b.min[s.axis] ? (s.position - b.min[s.axis]) / (b.max[s.axis] - b.min[s.axis]) : 0.5;
      if (document.activeElement !== slider) slider.value = String(Math.round(t * SLIDER_STEPS));
    }
    posInfo.textContent = `${AXIS_NAMES[s.axis]} = ${mm(s.position)} の面で切ります`;
    flipBox.checked = s.flip;
  }

  // ---------- 全体 ----------
  const warnings = model.warnings.length > 0 ? h('div', { class: 's3d-warn', role: 'status' }, ...model.warnings.map((w) => h('div', null, w))) : null;
  const root = h('div', { class: 's3d-cards' }, warnings, settingsCard, regionsCard, runCard, resultCard, sectionCard);

  function refresh(e: ModelEvent): void {
    if (e === 'selection' || e === 'study') renderRegions();
    if (e === 'study') {
      renderQuality();
      renderResult(); // 古い結果の表示・判定の再計算
      renderRun();
    }
    if (e === 'run') renderRun();
    if (e === 'result') {
      renderResult();
      renderRun();
    }
    if (e === 'section') renderSection();
  }
  renderRegions();
  renderQuality();
  renderRun();
  renderResult();
  renderSection();
  return { root, refresh };
}

/** 凡例（カラーバー）。結果があれば描き、なければ隠す。古い結果には「前の結果」と添える */
export function createLegend(model: Sim3DModel): { root: HTMLElement; refresh(): void } {
  const bar = h('div', { class: 's3d-legend-bar', 'aria-hidden': 'true' });
  const max = h('span', { class: 's3d-legend-max' });
  const min = h('span', { class: 's3d-legend-min' });
  const unit = h('span', { class: 's3d-legend-unit' });
  const tag = h('span', { class: 's3d-legend-stale', hidden: true }, '前の結果');
  const root = h('div', { class: 's3d-legend', hidden: true, role: 'img' }, unit, tag, max, bar, min);
  bar.style.background = `linear-gradient(to top, ${legendStops(RESULT_COLORMAP, 16).join(', ')})`;
  return {
    root,
    refresh() {
      const res = model.result;
      const f = res ? resultField(res.data) : undefined;
      root.hidden = !res || !f || !model.view.showResult || !hasValues(f);
      if (!res || !f || !hasValues(f)) return;
      const r = fieldRange3D(f);
      max.textContent = formatNumber(r.max, 4);
      min.textContent = formatNumber(r.min, 4);
      unit.textContent = `${f.label} [${f.unit}]`;
      tag.hidden = !model.stale;
      root.setAttribute('aria-label', `${f.label}の凡例。${formatNumber(r.min, 4)} から ${formatNumber(r.max, 4)} ${f.unit}`);
    },
  };
}
