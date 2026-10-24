// Studio M Lite のエントリーポイント: 状態・計算ループ・各パネルをつなぐ。
import './style.css';
import { MATERIALS } from './core/materials';
import { downloadBlob, toast } from './ui/dom';
import { initEasyPanel } from './ui/easy-panel';
import { Editor } from './ui/editor';
import { attachEmMarker, drawEmSource } from './ui/em-marker';
import { formatNumber, formatQuantity } from './ui/format';
import { initHeader } from './ui/header';
import { openImageImport } from './ui/image-import';
import { initModeSwitch } from './ui/mode-switch';
import { initialMode, loadUiState } from './ui/modes';
import { PRESETS } from './ui/presets';
import { drawProbes, drawSection } from './ui/pro-overlay';
import { initProTools } from './ui/pro-tools';
import { ProState, sampleNearest } from './ui/probes';
import { initProps } from './ui/props';
import { CanvasView, hasVectorFields } from './ui/render';
import { initResults } from './ui/results';
import { Runner } from './ui/runner';
import { initSettings } from './ui/settings';
import { Store } from './ui/state';
import { loadSaved, scheduleSave } from './ui/storage';
import { initStageBar, initTabs, initToolRail } from './ui/toolrail';
import { initVerdictCard } from './ui/verdict-card';
import { safeFileName } from './ui/project-utils';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const saved = loadSaved();
const store = new Store(saved?.project ?? PRESETS[0].build());
store.analysis = saved?.analysis ?? 'flow';
// 表示モード: 初めての人は「かんたん」、保存済みのプロジェクトがある人は「標準」から
const ui = loadUiState();
store.mode = initialMode(ui.mode, saved !== null);
store.prefs = ui.prefs;

const runner = new Runner(store);
const canvas = $<HTMLCanvasElement>('view');
const view = new CanvasView(canvas, $('canvasWrap'));
// 波源のドラッグは、Editor より先にイベントを受け取る
attachEmMarker(store, view);
const editor = new Editor(store, view, $('draftBar'));
editor.cellProvider = () => runner.grid?.h;

const pro = new ProState();
view.overlays.push(
  (p) => drawEmSource(p, store),
  (p) => store.mode === 'pro' && drawProbes(p, pro),
  (p) => store.mode === 'pro' && drawSection(p, pro),
);

initHeader(store, runner);
initModeSwitch(store, $('modeSwitch'), $<HTMLButtonElement>('modeBadge'));
initTabs(store, $('tabs'));
initToolRail(store, $('rail'));
initStageBar(store, $('stageBar'));
initProps(store, $('props'));
const settings = initSettings(store, runner, $('settings'));
const easy = initEasyPanel(store, runner, $('easy'));
const results = initResults(store, runner, $('results'));
const verdict = initVerdictCard(store, runner, $('verdict'));
const proTools = initProTools(store, runner, view, pro, $('proTools'));

// 画像から形を作る
const importBtn = document.createElement('button');
importBtn.type = 'button';
importBtn.className = 'btn small';
importBtn.textContent = '画像から作る';
importBtn.addEventListener('click', () => {
  openImageImport({
    domain: { width: store.project.domain.width, height: store.project.domain.height },
    materials: MATERIALS.filter((m) => m.kind === 'solid').map((m) => ({ id: m.id, name: m.name })),
    defaultMaterialId: store.newMaterialId,
    onImport: (shapes) => {
      store.addShapes(shapes);
      toast(`画像から ${shapes.length} 個の図形を取り込みました`);
    },
  });
});
$('stageBar').append(importBtn);

// 画像として保存
const shot = document.createElement('button');
shot.type = 'button';
shot.className = 'btn small';
shot.textContent = '画像保存';
shot.addEventListener('click', () => {
  canvas.toBlob((b) => {
    if (b) downloadBlob(b, `${safeFileName(store.project.name)}.png`);
    else toast('画像を作れませんでした', 'error');
  });
});
$('stageBar').append(shot);

// 変更があったら再描画し、プロジェクトを自動保存する
for (const ev of ['project', 'load', 'analysis', 'selection', 'tool', 'view', 'mode'] as const) {
  store.on(ev, () => {
    view.invalid = true;
    if (ev !== 'view' && ev !== 'selection' && ev !== 'tool' && ev !== 'mode') scheduleSave(() => ({ project: store.project, analysis: store.analysis }));
  });
}
document.addEventListener('visibilitychange', () => {
  view.invalid = true;
});

runner.rebuild();

// ---------- 描画ループ ----------

const footCoord = $('footCoord');
const footHelp = $('footHelp');
let lastVersion = -1;
let lastFoot = 0;

function render(): void {
  view.render({
    project: store.project,
    raster: runner.raster,
    result: runner.result,
    field: runner.currentField(),
    analysis: runner.analysis,
    opts: store.view,
    selectedId: store.selectedId,
    hoverId: editor.hoverId,
    draft: editor.draft,
    draftCloseNear: editor.closeNear,
    touch: editor.touch,
    running: runner.running,
    generation: runner.generation,
  });
}

function updateFoot(): void {
  const w = editor.lastWorld;
  if (w) {
    let t = `x ${formatNumber(w[0] * 1000, 4)} mm　y ${formatNumber(w[1] * 1000, 4)} mm`;
    const f = runner.currentField();
    const v = runner.result && f ? sampleNearest(runner.result, f, w[0], w[1]) : null;
    if (f && v !== null) t += `　${f.label} ${formatQuantity(v, f.unit)}`;
    footCoord.textContent = t;
  } else {
    footCoord.textContent = '';
  }
  footHelp.textContent = editor.helpText();
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const stepped = runner.tick();
  results.update();
  verdict.update();
  settings.update();
  easy.update();
  proTools.update();
  const animating = runner.analysis === 'flow' && store.view.particles && runner.running && hasVectorFields(runner.result);
  if (stepped || animating || view.invalid || runner.resultVersion !== lastVersion) {
    lastVersion = runner.resultVersion;
    render();
  }
  if (now - lastFoot > 100) {
    lastFoot = now;
    updateFoot();
  }
}
requestAnimationFrame(frame);

// 開発者向け: コンソールから状態を覗けるようにする
Object.assign(window, { studioM: { store, runner, editor, pro } });
