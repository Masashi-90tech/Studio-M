// 「このアプリについて」の文面づくり（electron を import しない純粋な関数。テストできるよう分けてある）。
// GPL の約束（docs/DESKTOP.md）: 同梱の CalculiX のライセンスと、ソースの入手先をアプリに表示する。
import { basename } from 'node:path';

export interface AboutInput {
  /** Studio M Pro の版（app.getVersion()） */
  appVersion: string;
  /** 同梱の ccx の実行ファイルのパス（なければ null） */
  ccxPath: string | null;
  /** THIRD-PARTY-LICENSES/ccx/SOURCE.txt の中身（読めなければ null） */
  sourceText: string | null;
  /** ライセンス文のフォルダー（表示用） */
  licenseDir: string;
}

/** `ccx_2.23` / `ccx_2.23.exe` → '2.23'。版のない名前は null */
export function ccxVersionFromPath(path: string): string | null {
  const m = /^ccx_(\d+(?:\.\d+)*)(?:\.exe)?$/i.exec(basename(path.replace(/\\/g, '/')));
  return m ? m[1] : null;
}

/** SOURCE.txt のうち最初の http(s) の URL（ソースの入手先）。なければ null */
export function sourceUrlFromText(text: string): string | null {
  const m = /https?:\/\/[^\s（）()、。]+/.exec(text);
  return m ? m[0] : null;
}

/** SOURCE.txt の「版 2.23」から版を読む（実行ファイルの名前に版がないときの予備） */
function ccxVersionFromText(text: string): string | null {
  const m = /版\s+(\d+(?:\.\d+)+)/.exec(text);
  return m ? m[1] : null;
}

export interface AboutText {
  title: string;
  message: string;
  detail: string;
}

export function buildAboutText(i: AboutInput): AboutText {
  const version = (i.ccxPath ? ccxVersionFromPath(i.ccxPath) : null) ?? (i.sourceText ? ccxVersionFromText(i.sourceText) : null);
  const url = i.sourceText ? sourceUrlFromText(i.sourceText) : null;
  const lines = [
    'Studio M Pro は MIT ライセンスのソフトです。',
    '',
    i.ccxPath
      ? `同梱の解析ソフト: CalculiX CrunchiX（ccx）${version ? ` ${version}` : ''}\nライセンス: GPL-2.0。別の実行ファイルとして同梱し、Studio M とはコマンドとファイルでだけやり取りします（CalculiX のコードはリンクしていません）。`
      : '同梱の解析ソフト（CalculiX）は、この環境では見つかりませんでした。',
    '',
    url ? `ソースの入手先: ${url}` : `ソースの入手先: ${i.licenseDir} の中の ccx/SOURCE.txt を見てください（THIRD-PARTY-LICENSES フォルダーです）。`,
    `ライセンス文（全文）: ${i.licenseDir}`,
  ];
  return { title: 'Studio M Pro について', message: `Studio M Pro ${i.appVersion}`, detail: lines.join('\n') };
}
