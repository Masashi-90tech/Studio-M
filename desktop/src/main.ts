// Studio M Pro の main プロセス。画面を読み込み、Studio M Engine を同じプロセスで動かし、IPC でつなぐ。
// electron を import してよいのは、この main.ts と preload.ts だけ。
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAdapters } from '../../engine/server/adapters';
import { generateToken } from '../../engine/server/auth';
import { createWrapperLauncher } from '../../engine/server/launcher';
import { findOpenFoamApp, OPENFOAM_APP_COMMANDS } from '../../engine/server/openfoam-app';
import { createEngineService, type EngineService } from '../../engine/server/service';
import type { OpenedFile, SaveRequest } from './api';
import { findBundledCcx } from './bundled-tools';
import { createEngineBridge, type EngineBridge } from './engine-bridge';
import { createFileStore, ensureProjectName } from './file-store';
import { IPC } from './ipc-channels';

const here = dirname(fileURLToPath(import.meta.url)); // desktop/dist

let service: EngineService | null = null;
let bridge: EngineBridge | null = null;
const files = createFileStore();

/**
 * 読み込む画面。STUDIO_M_DESKTOP_URL があればそれ（開発用）、なければリポジトリの dist/index.html。
 * パッケージ後の置き場所（resources など）の解決はインストーラーの作業（v0.6 の 6 番）で足す。
 */
function resolveAppUrl(): string | null {
  const dev = process.env.STUDIO_M_DESKTOP_URL;
  if (dev) return dev;
  const index = resolve(here, '../../dist/index.html');
  return existsSync(index) ? pathToFileURL(index).toString() : null;
}

/** IPC を受けてよい送り元（自分が読み込んだ画面）か */
let appOrigin = '';
function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  return appOrigin.startsWith('file:') ? url.startsWith('file:') : url.startsWith(appOrigin);
}

/**
 * 同梱の解析ソフトを置いたフォルダー。パッケージ後は resources、開発中は STUDIO_M_BUNDLED_DIR（あれば）。
 * ccx は `<そこ>/ccx/` に置く（`ccx_2.23` のように版つきの名前でもよい）。
 */
function bundledBase(): string | null {
  if (app.isPackaged) return process.resourcesPath;
  return process.env.STUDIO_M_BUNDLED_DIR || null;
}

async function startEngine(): Promise<void> {
  const token = generateToken(); // main の中だけに持つ。renderer には渡さない
  const base = bundledBase();
  // 見つからなければ今までどおり（PATH の ccx を使う）
  const ccx = base ? findBundledCcx({ dir: resolve(base, 'ccx'), platform: process.platform }) : null;
  // Mac: OpenFOAM.app が入っていれば、そのラッパー経由で OpenFOAM を動かす（見つからなければ今までどおり）
  const foamApp = findOpenFoamApp();
  const commandLaunchers = foamApp ? createWrapperLauncher({ commands: OPENFOAM_APP_COMMANDS, file: foamApp.wrapper, label: `OpenFOAM.app（${foamApp.version}）` }) : undefined;
  service = createEngineService({ adapters: loadAdapters(), token, port: 0, commandPaths: ccx ? { ccx } : undefined, commandLaunchers });
  const port = await service.listen();
  bridge = createEngineBridge({ baseUrl: `http://127.0.0.1:${port}`, token });
}

function registerIpc(): void {
  ipcMain.handle(IPC.engineRequest, (e, req: unknown) => {
    if (!isTrustedSender(e) || !bridge) throw new Error('エンジンに接続できません');
    return bridge.request(req as Parameters<EngineBridge['request']>[0]);
  });

  ipcMain.handle(IPC.fileOpen, async (e): Promise<OpenedFile | null> => {
    if (!isTrustedSender(e)) throw new Error('許可されていない画面からの要求です');
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = await dialog.showOpenDialog(win!, { title: 'プロジェクトを開く', properties: ['openFile'], filters: [{ name: 'Studio M プロジェクト', extensions: ['json'] }] });
    if (r.canceled || r.filePaths.length === 0) return null;
    return files.open(r.filePaths[0]);
  });

  ipcMain.handle(IPC.fileSave, async (e, req: SaveRequest): Promise<{ path: string } | null> => {
    if (!isTrustedSender(e)) throw new Error('許可されていない画面からの要求です');
    if (typeof req !== 'object' || req === null || typeof req.text !== 'string') throw new Error('保存の要求の形が正しくありません');
    if (files.canOverwrite(req.path)) return files.overwrite(req.path as string, req.text);
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = await dialog.showSaveDialog(win!, {
      title: 'プロジェクトを保存',
      defaultPath: ensureProjectName(typeof req.suggestedName === 'string' ? req.suggestedName : ''),
      filters: [{ name: 'Studio M プロジェクト', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    return files.saveAs(r.filePath, req.text);
  });
}

function openExternalIfWeb(url: string): void {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(url);
  } catch {
    // 開けない URL は無視する
  }
}

function createWindow(appUrl: string): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Studio M Pro',
    webPreferences: {
      preload: resolve(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // アプリ以外への遷移は止める（外部リンクは既定のブラウザで開く。http/https だけ）
  const inApp = (url: string): boolean => (appOrigin.startsWith('file:') ? url.startsWith('file:') : url.startsWith(appOrigin));
  win.webContents.on('will-navigate', (ev, url) => {
    if (inApp(url)) return;
    ev.preventDefault();
    openExternalIfWeb(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfWeb(url);
    return { action: 'deny' };
  });
  void win.loadURL(appUrl);
}

async function boot(): Promise<void> {
  const appUrl = resolveAppUrl();
  if (!appUrl) {
    dialog.showErrorBox('Studio M Pro を開けません', '画面（dist/index.html）が見つかりません。先に `npm run build`（または `npm run desktop:build`）を実行してから、もう一度起動してください。');
    app.quit();
    return;
  }
  appOrigin = appUrl.startsWith('file:') ? 'file:' : new URL(appUrl).origin;
  try {
    await startEngine();
  } catch (e) {
    dialog.showErrorBox('Studio M Engine を始められませんでした', `${e instanceof Error ? e.message : String(e)}\n\nアプリを再起動してください。直らないときは、ほかのソフトを閉じてからもう一度試してください。`);
    app.quit();
    return;
  }
  registerIpc();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { role: 'editMenu' as const },
      { role: 'viewMenu' as const },
      { role: 'windowMenu' as const },
    ]),
  );
  createWindow(appUrl);
}

let closing = false;
app.on('before-quit', (ev) => {
  if (closing || !service) return;
  ev.preventDefault();
  closing = true;
  void service.close().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  const url = resolveAppUrl();
  if (BrowserWindow.getAllWindows().length === 0 && url && bridge) createWindow(url);
});

void app.whenReady().then(boot);
