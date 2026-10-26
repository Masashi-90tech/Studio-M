// 取り込み（KiCad 基板・3D モデル）で気づいたことを toast で知らせるときの共通の処理。

/** 取り込みで出す toast の最大数（「ほか N 件」を含む） */
export const MAX_IMPORT_TOASTS = 3;

/** 注意書き → toast に出す文。多いときは先頭を残して、最後を「ほか N 件」にまとめる */
export function importToasts(warnings: string[], max: number = MAX_IMPORT_TOASTS): string[] {
  const list = warnings.map((w) => w.trim()).filter((w) => w !== '');
  if (list.length <= max) return list;
  const shown = list.slice(0, Math.max(0, max - 1));
  return [...shown, `ほか ${list.length - shown.length} 件の注意があります（取り込む前の画面の注意書きと同じ内容です）`];
}

/** 文の長さに合わせて toast を出しておく時間 [ms]（読み切れる長さにする） */
export function toastMsFor(text: string): number {
  return Math.min(10000, 3500 + text.length * 60);
}
