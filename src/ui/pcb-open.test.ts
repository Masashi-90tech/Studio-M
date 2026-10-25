import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_TOASTS, importToasts, pickKicadFile, toastMsFor } from './pcb-open';

describe('KiCad 取り込みの注意書きの toast', () => {
  it('3 件まではそのまま出す', () => {
    expect(importToasts(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(importToasts([])).toEqual([]);
  });
  it('多いときは toast を最大数に収め、最後を「ほか N 件」にする', () => {
    const out = importToasts(['a', 'b', 'c', 'd', 'e']);
    expect(out).toHaveLength(MAX_IMPORT_TOASTS);
    expect(out.slice(0, 2)).toEqual(['a', 'b']);
    expect(out[2]).toMatch(/^ほか 3 件/);
  });
  it('空の文は数えない', () => {
    expect(importToasts(['a', '  ', 'b'])).toEqual(['a', 'b']);
  });
  it('長い文ほど長く出す（上限あり）', () => {
    expect(toastMsFor('短い')).toBeLessThan(toastMsFor('長い'.repeat(60)));
    expect(toastMsFor('あ'.repeat(1000))).toBe(10000);
  });
});

describe('ドロップされたファイルの選択', () => {
  it('.kicad_pcb だけを選ぶ（大文字小文字は問わない）', () => {
    expect(pickKicadFile([{ name: 'a.json' }, { name: 'Board.KiCad_PCB' }])).toEqual({ name: 'Board.KiCad_PCB' });
    expect(pickKicadFile([{ name: 'a.json' }, { name: 'b.kicad_sch' }])).toBeUndefined();
    expect(pickKicadFile([])).toBeUndefined();
  });
});
