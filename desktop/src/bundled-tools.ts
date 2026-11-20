// 同梱の解析ソフトの場所を探す（electron を import しない純粋な関数。テストできるよう分けてある）。
import { readdirSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface FindBundledCcxOptions {
  /** 同梱の ccx を置いたフォルダー（絶対パス） */
  dir: string;
  platform: NodeJS.Platform;
  /** フォルダーの中身の取得（テスト用。省略時は実際のフォルダーを読む。読めなければ空） */
  listDir?: (dir: string) => DirEntry[];
}

function defaultListDir(dir: string): DirEntry[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch {
    return [];
  }
}

/** '2.23' → [2, 23]（版の大小は、数字を . で区切って左から順に比べる） */
function versionParts(v: string): number[] {
  return v.split('.').map((s) => Number(s));
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * dir の中から ccx の実行ファイルを探して、絶対パスを返す。なければ null。
 * 名前は macOS / Linux が `ccx` か `ccx_<版>`、Windows が `ccx.exe` か `ccx_<版>.exe`。
 * 版つきが複数あれば新しい版を選ぶ（ccx_2.23 は ccx_2.9 より新しい）。版つきがなければ版なしの `ccx`。
 * 拡張子つきのファイル（.dll など）とフォルダーは対象外。
 */
export function findBundledCcx(o: FindBundledCcxOptions): string | null {
  const win = o.platform === 'win32';
  const re = win ? /^ccx(?:_(\d+(?:\.\d+)*))?\.exe$/i : /^ccx(?:_(\d+(?:\.\d+)*))?$/;
  let best: { name: string; version: number[] } | null = null;
  for (const e of (o.listDir ?? defaultListDir)(o.dir)) {
    if (e.isDirectory) continue;
    const m = re.exec(e.name);
    if (!m) continue;
    // 版なしの ccx は、版つきがあればそちらに負ける
    const version = m[1] ? versionParts(m[1]) : [-1];
    if (!best || compareVersions(version, best.version) > 0) best = { name: e.name, version };
  }
  return best ? (win ? win32 : posix).join(o.dir, best.name) : null;
}
