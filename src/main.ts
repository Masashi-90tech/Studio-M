// Studio M Lite のエントリーポイント: 状態・計算ループ・各パネルをつなぐ。
import './style.css';
import { DEFAULT_ANALYSIS } from './core/analyses';
import { MATERIALS } from './core/materials';
import { getWorkbench } from './workbench';
import { downloadBlob, toast } from './ui/dom';
import { initEasyPanel } from './ui/easy-panel';
import { Editor } from './ui/editor';
import { initEngineUi } from './ui/engine-open';
import { formatNumber, formatQuantity } from './ui/format';
import { initHeader } from './ui/header';
import { initLearnDrawer } from './ui/learn-drawer';
import { createLearnSwitch, loadLearnEnabled, saveLearnEnabled, takeLearnHint } from './ui/learn-pref';
import { withLoading } from './ui/lazy';
import { initMathCard } from './ui/math-card';
import { initModeSwitch } from './ui/mode-switch';
import { initialMode, loadUiState } from './ui/modes';
import { initOverlayHost } from './ui/overlay-host';
import { initKicadDrop } from './ui/pcb-open';
import { initPrefsPopover } from './ui/prefs-popover';
import { PRESETS } from './ui/presets';
import { sampleNearest } from './ui/probes';
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
store.analysis = saved?.analysis ?? DEFAULT_ANALYSIS;
// 表示モード: 初めての人は「かんたん」、保存済みのプロジェクトがある人は「標準」から
const ui = loadUiState();
store.mode = initialMode(ui.mode, saved !== null);
store.prefs = ui.prefs;

const runner = new Runner(store);
const canvas = $<HTMLCanvasElement>('view');
const view = new CanvasView(canvas, $('canvasWrap'));
const editor = new Editor(store, view, $('draftBar'));
editor.cellProvider = () => runner.grid?.h;

// 解析ごとの重ね描き（電磁波の波源の印など）はワークベンチが持つ。タブに合わせて付け替える
initOverlayHost(store, view);

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
// 学習機能（数学の窓・学ぶ）の表示設定。既定は OFF で、OFF のあいだは学びモードを読み込まない
const learn = createLearnSwitch({ initial: loadLearnEnabled() });
learn.subscribe(saveLearnEnabled);
// PC のエンジン（本計算）。設定（⚙）に接続の欄、結果の下に本計算カード。使うときまで何も読み込まない
const engine = initEngineUi({ store, runner, resultsHost: $('engine') });
initPrefsPopover({ button: $('btnPrefs'), panel: $('prefsPopover'), learn, engine });
// 数学の窓（判定カードの下）と「学ぶ」ドロワー。中身の学びモードは開いたときに遅延 import する
const mathCard = initMathCard({ store, runner, host: $('mathWindow'), learn });
const learnDrawer = initLearnDrawer({ store, runner, math: mathCard, drawer: $('learnDrawer'), button: $<HTMLButtonElement>('btnLearn'), chipHost: $('learnChip'), learn });
// 以前に学んだ記録がある人には、OFF になっていることを 1 回だけ知らせる
if (takeLearnHint({ enabled: learn.get() })) toast('学習機能は設定（⚙）から表示できます');

// KiCad 基板ファイルを作図エリアにドロップしたら、取り込みダイアログを開く
initKicadDrop({ target: $('canvasWrap'), store });

// プロ専用の道具は、プロモードを初めて開くときに読み込む
let proSuite: { update(): void } | null = null;
let proLoading = false;
function ensureProSuite(): void {
  if (proSuite || proLoading || store.mode !== 'pro') return;
  proLoading = true;
  void withLoading({ label: 'プロ用の測定ツール', task: import('./ui/pro-suite') }).then((m) => {
    proLoading = false;
    if (!m) return;
    const suite = m.initProSuite({ store, runner, view, host: $('proTools') });
    proSuite = suite;
    Object.assign((window as unknown as { studioM: object }).studioM, { pro: suite.state });
    view.invalid = true;
  });
}
store.on('mode', ensureProSuite);

// 画像から形を作る
const importBtn = document.createElement('button');
importBtn.type = 'button';
importBtn.className = 'btn small';
importBtn.textContent = '画像から作る';
importBtn.addEventListener('click', async () => {
  // 画像取り込みのダイアログは、押されたときに初めて読み込む
  const mod = await withLoading({ label: '画像取り込み', task: import('./ui/image-import') });
  if (!mod) return;
  mod.openImageImport({
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
    traits: getWorkbench(runner.analysis)?.viewTraits,
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
  engine.update();
  mathCard.update();
  learnDrawer.update();
  settings.update();
  easy.update();
  proSuite?.update();
  const animating = !!getWorkbench(runner.analysis)?.viewTraits?.particles && store.view.particles && runner.running && hasVectorFields(runner.result);
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
Object.assign(window, { studioM: { store, runner, editor } });
ensureProSuite();
