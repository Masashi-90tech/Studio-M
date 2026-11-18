// 実証実験 4 用の最小の Electron アプリ（Mac 用。Linux ではビルドも起動もしない）。
// 測るもの: 起動からの経過時間（app ready・画面表示・エンジンの応答）と、同梱した処理の各段の時間。
//   --measure         測定が終わったら結果を JSON に書いて自動で終了する
//   --work <フォルダー>  処理の作業フォルダー（既定は一時フォルダー）
//   --out <ファイル>    結果の JSON の書き出し先（既定は作業フォルダーの measure.json）
//   --runs <回数>      処理を流す回数（既定 2。1 回目がコールド、2 回目以降がウォーム）
'use strict';

const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// 起動からの経過ミリ秒（プロセスの開始から）
const since = () => Math.round(process.uptime() * 1000);
const marks = { main_js_loaded: since() };

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const measureMode = process.argv.includes('--measure');
const workDir = argValue('--work') ?? path.join(os.tmpdir(), 'studio-m-probe');
const outFile = argValue('--out') ?? path.join(workDir, 'measure.json');
const runs = Number(argValue('--runs') ?? 2);

// 同梱物の場所: 配布した .app では Contents/Resources の下。開発中（npx electron .）は build/ の下
const packaged = app.isPackaged;
const payloadDir = packaged ? path.join(process.resourcesPath, 'payload') : path.resolve(__dirname, '..', 'build', 'payload');
const engineJs = packaged ? path.join(process.resourcesPath, 'dist-engine', 'main.js') : path.resolve(__dirname, '..', '..', '..', 'dist-engine', 'main.js');

/** 同梱の Studio M Engine を ELECTRON_RUN_AS_NODE で起動して、状態の API が答えるまでを測る */
async function measureEngine() {
  if (!fs.existsSync(engineJs)) return { skipped: `${engineJs} がありません（ルートで npm run build:engine を実行してから packager をやり直してください）` };
  const port = 47896;
  const token = 'exp4-probe-token-0123456789';
  // エンジンは起動のたびに ~/.studio-m/engine-token を書き換えるので、あとで元に戻す
  const tokenFile = path.join(os.homedir(), '.studio-m', 'engine-token');
  let backup = null;
  try { backup = fs.readFileSync(tokenFile); } catch { /* なければそのまま */ }
  const t0 = since();
  const child = spawn(process.execPath, [engineJs, '--port', String(port)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', STUDIO_M_ENGINE_TOKEN: token },
    stdio: 'ignore',
  });
  let spawnError = null;
  child.on('error', (e) => { spawnError = e; });
  let result = { error: 'タイムアウト（30 秒）。エンジンが起動しませんでした' };
  for (let i = 0; i < 300 && !spawnError; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status?refresh=1`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const s = await res.json();
        result = {
          started_at_ms: t0,
          responded_at_ms: since(),
          startup_ms: since() - t0,
          version: s.version,
          engines: (s.engines ?? []).map((e) => ({ id: e.id, available: e.available, via: e.via })),
        };
        break;
      }
    } catch { /* まだ起動中 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (spawnError) result = { error: `エンジンを起動できません: ${spawnError.message}` };
  child.kill();
  try {
    if (backup) fs.writeFileSync(tokenFile, backup, { mode: 0o600 });
    else fs.rmSync(tokenFile, { force: true });
  } catch { /* 戻せなくても測定は続ける */ }
  return result;
}

async function measureAll(win) {
  const report = { electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch,
    packaged, payloadDir, workDir, marks };
  fs.mkdirSync(workDir, { recursive: true });
  report.engine = await measureEngine();
  marks.engine_done = since();
  try {
    // 同じモジュールを、Electron の外からも（node run-pipeline.mjs で）呼べる
    const mod = await import(pathToFileURL(path.join(payloadDir, 'pipeline', 'run-pipeline.mjs')).href);
    report.pipeline = await mod.runPipeline({ payloadDir, workDir: path.join(workDir, 'pipeline'), runs, meshSize: 10 });
  } catch (e) {
    report.pipeline_error = e.message;
  }
  marks.pipeline_done = since();
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  const text = JSON.stringify(report, null, 2);
  try { await win.webContents.executeJavaScript(`document.getElementById('out').textContent = ${JSON.stringify(text)}`); } catch { /* 画面がなくても結果は書いてある */ }
  return report;
}

app.whenReady().then(async () => {
  marks.app_ready = since();
  const win = new BrowserWindow({ width: 760, height: 640, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  marks.window_created = since();
  win.webContents.once('did-finish-load', () => { marks.did_finish_load = since(); });
  await win.loadFile(path.join(__dirname, 'index.html'));
  marks.load_file_resolved = since();
  const report = await measureAll(win);
  if (measureMode) {
    app.exit(report.pipeline && report.pipeline.every((r) => r.ok) ? 0 : 3);
  }
});

app.on('window-all-closed', () => app.quit());
