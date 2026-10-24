// Studio M Lite のエントリーポイント: 状態・計算ループ・各パネルをつなぐ。
import './style.css';
import { downloadBlob, toast } from './ui/dom';
import { Editor } from './ui/editor';
import { formatNumber, formatQuantity } from './ui/format';
import { initHeader } from './ui/header';
import { PRESETS } from './ui/presets';
import { initProps } from './ui/props';
import { CanvasView, hasVectorFields, probeField } from './ui/render';
import { initResults } from './ui/results';
import { Runner } from './ui/runner';
import { initSettings } from './ui/settings';
import { Store } from './ui/state';
import { loadSaved, scheduleSave } from './ui/storage';
import { initStageBar, initTabs, initToolRail } from './ui/toolrail';
import { safeFileName } from './ui/project-utils';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const saved = loadSaved();
const store = new Store(saved?.project ?? PRESETS[0].build());
store.analysis = saved?.analysis ?? 'flow';

const runner = new Runner(store);
const canvas = $<HTMLCanvasElement>('view');
const view = new CanvasView(canvas, $('canvasWrap'));
const editor = new Editor(store, view, $('draftBar'));

initHeader(store, runner);
initTabs(store, $('tabs'));
initToolRail(store, $('rail'));
initStageBar(store, $('stageBar'));
initProps(store, $('props'));
initSettings(store, $('settings'));
const results = initResults(store, runner, $('results'));

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
for (const ev of ['project', 'load', 'analysis', 'selection', 'tool', 'view'] as const) {
  store.on(ev, () => {
    view.invalid = true;
    if (ev !== 'view' && ev !== 'selection' && ev !== 'tool') scheduleSave(() => ({ project: store.project, analysis: store.analysis }));
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
    const v = probeField(runner.result, f, w[0], w[1]);
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
Object.assign(window, { studioM: { store, runner, editor } });
