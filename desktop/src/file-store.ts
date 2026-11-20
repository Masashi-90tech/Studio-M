// ファイルの開く・保存の、electron を使わない部分: 拡張子の補完、大きさの上限、許可パスの管理。
// ダイアログは main.ts が出し、選ばれたパスだけをここに渡す。renderer から任意のパスは読めない。
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export const PROJECT_EXT = '.studiom.json';
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** ファイル名を `.studiom.json` で終わる形にする（フォルダー部分・使えない文字は取り除く） */
export function ensureProjectName(name: string): string {
  let base = basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  if (base.toLowerCase().endsWith(PROJECT_EXT)) return base;
  base = base.replace(/\.json$/i, '').replace(/\.studiom$/i, '').replace(/\.+$/, '');
  return `${base || 'project'}${PROJECT_EXT}`;
}

export interface FileStoreOptions {
  maxBytes?: number;
}

export interface FileStore {
  /** ダイアログで選ばれたパスを読む。大きすぎれば Error。読めたらそのパスを「直前のファイル」にする */
  open(path: string): Promise<{ path: string; text: string }>;
  /** 保存ダイアログで選ばれたパスに書く（拡張子を補う）。書けたらそのパスを「直前のファイル」にする */
  saveAs(path: string, text: string): Promise<{ path: string }>;
  /** 直前に開いた・保存したパスにだけ、ダイアログなしで上書きできる。違うパスは Error */
  overwrite(path: string, text: string): Promise<{ path: string }>;
  /** ダイアログなしで上書きしてよいパスか */
  canOverwrite(path: string | undefined): boolean;
}

export function createFileStore(o: FileStoreOptions = {}): FileStore {
  const max = o.maxBytes ?? MAX_FILE_BYTES;
  const mb = Math.round(max / 1024 / 1024);
  let current: string | null = null;

  const checkText = (text: string): void => {
    if (typeof text !== 'string') throw new Error('保存する内容が文字列ではありません');
    if (Buffer.byteLength(text, 'utf8') > max) throw new Error(`ファイルが大きすぎます（上限 ${mb} MB）。内容を減らしてから保存してください`);
  };

  return {
    async open(path) {
      const p = resolve(path);
      const st = await stat(p);
      if (!st.isFile()) throw new Error('ファイルではないので開けません');
      if (st.size > max) throw new Error(`ファイルが大きすぎて開けません（上限 ${mb} MB）`);
      const text = await readFile(p, 'utf8');
      current = p;
      return { path: p, text };
    },
    async saveAs(path, text) {
      checkText(text);
      const p = join(dirname(resolve(path)), ensureProjectName(basename(path)));
      await writeFile(p, text, 'utf8');
      current = p;
      return { path: p };
    },
    async overwrite(path, text) {
      if (current === null || resolve(path) !== current) throw new Error('このファイルには上書きできません。「名前を付けて保存」で保存先を選んでください');
      checkText(text);
      await writeFile(current, text, 'utf8');
      return { path: current };
    },
    canOverwrite: (path) => path !== undefined && current !== null && resolve(path) === current,
  };
}
