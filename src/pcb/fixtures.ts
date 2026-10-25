// テスト用の基板ファイルを読む（fixtures/ の手書きの .kicad_pcb）。テスト以外からは使わない。
import { readFileSync } from 'node:fs';

export function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

/** 最小の KiCad 8 形式の基板を作る（外形は 0〜20 × 0〜10 mm）。body には要素を足す */
export function miniBoard(body: string, opts: { outline?: boolean; header?: string } = {}): string {
  const outline =
    opts.outline === false
      ? ''
      : `(gr_rect (start 0 0) (end 20 10) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))`;
  return `(kicad_pcb (version 20240108) (generator "pcbnew") ${opts.header ?? '(general (thickness 1.6))'} ${outline} ${body})`;
}
