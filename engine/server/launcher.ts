// 「この名前のコマンドは、この実行ファイルに -c "<コマンドと引数>" を渡して起動する」ための設定と組み立て。
// 例: Mac の OpenFOAM.app は、環境を読み込むラッパー（zsh スクリプト）経由でしか OpenFOAM のコマンドを動かせない。
// サーバー側の設定なので信頼するが、シェルを通る部分なので、コマンド名と引数は厳しく絞る。
import { ExecError, isValidCommand } from './exec';

export interface CommandLauncher {
  /** このランチャー経由で起動するコマンド名（blockMesh など） */
  commands: string[];
  /** 画面に出す名前（例: 'OpenFOAM.app（v2606）'）。省略可 */
  label?: string;
  /** 起動する実行ファイルの絶対パス（ラッパー） */
  file: string;
  /** command と args から、file に渡す引数の配列を作る。使えない引数なら ExecError('bad-request') */
  argsFor(command: string, args: string[]): string[];
}

/** シェルに渡してよい引数の文字（空白・引用符・; $ ` 改行・日本語などは含まない） */
const SAFE_ARG_RE = /^[A-Za-z0-9._/:=,+@%-]+$/;

/** command と args を、シングルクォートで包んだ 1 本の文字列にする。安全でないものは断る */
export function joinShellCommand(command: string, args: string[]): string {
  if (!isValidCommand(command)) {
    throw new ExecError(`コマンド名「${command}」は使えません（英数字と . _ + - だけ）`, 'bad-request');
  }
  for (const a of args) {
    if (!SAFE_ARG_RE.test(a)) {
      throw new ExecError(`「${command}」の引数「${a.slice(0, 40)}」は、シェルを通す起動では使えません（英数字と . _ / : = , + @ % - だけ）`, 'bad-request');
    }
  }
  return [command, ...args.map((a) => `'${a}'`)].join(' ');
}

/** ラッパーに `-c "<連結した文字列>"` を渡す形のランチャーを作る */
export function createWrapperLauncher(o: { commands: string[]; file: string; label?: string }): CommandLauncher {
  return {
    label: o.label,
    commands: [...o.commands],
    file: o.file,
    argsFor: (command, args) => ['-c', joinShellCommand(command, args)],
  };
}
