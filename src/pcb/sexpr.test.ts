import { describe, expect, it } from 'vitest';
import { atomArgs, child, childNum, childStr, childXY, children, headOf, numAt, parseSexpr, pointsOf, SexprError, strAt } from './sexpr';

describe('parseSexpr', () => {
  it('入れ子のリスト・数値・記号を読む', () => {
    const r = parseSexpr('(kicad_pcb (version 20240108) (at 10.5 -2 90) (layer F.Cu))');
    expect(r).toEqual(['kicad_pcb', ['version', 20240108], ['at', 10.5, -2, 90], ['layer', 'F.Cu']]);
  });

  it('引用符つきの文字列とエスケープを読む', () => {
    const r = parseSexpr('(a "he said \\"hi\\"\\\\ ok" "line1\\nline2" "")');
    expect(r[1]).toBe('he said "hi"\\ ok');
    expect(r[2]).toBe('line1\nline2');
    expect(r[3]).toBe('');
  });

  it('引用符つきの数字は文字列のまま、引用符なしは数値になる', () => {
    const r = parseSexpr('(pad "1" smd 2 1e-3 -.5 +3)');
    expect(r.slice(1)).toEqual(['1', 'smd', 2, 0.001, -0.5, 3]);
  });

  it('文字列の中の括弧や空白に惑わされない', () => {
    const r = parseSexpr('(property "Value" "R (10k) 1%")');
    expect(r).toEqual(['property', 'Value', 'R (10k) 1%']);
  });

  it('改行・タブ・BOM つきでも読める', () => {
    const r = parseSexpr('﻿(a\r\n\t(b 1)\r\n\t(c 2)\r\n)\r\n');
    expect(children(r, 'b')).toHaveLength(1);
    expect(childNum(r, 'c')).toBe(2);
  });

  it('深い入れ子でも落ちない', () => {
    const depth = 20000;
    const r = parseSexpr('('.repeat(depth) + 'x' + ')'.repeat(depth));
    expect(Array.isArray(r)).toBe(true);
  });

  it('括弧の不一致は SexprError', () => {
    expect(() => parseSexpr('(a (b 1)')).toThrow(SexprError);
    expect(() => parseSexpr('(a))')).toThrow(SexprError);
    expect(() => parseSexpr('(a "abc)')).toThrow(SexprError);
    expect(() => parseSexpr('')).toThrow(SexprError);
    expect(() => parseSexpr('atom')).toThrow(SexprError);
    expect(() => parseSexpr('(a) (b)')).toThrow(SexprError);
  });
});

describe('問い合わせの道具', () => {
  const root = parseSexpr(`(fp "R_0603" (layer "F.Cu") (at 10 20 90) (pad "1" (at -1 0)) (pad "2" (at 1 0))
    (pts (xy 0 0) (xy 1 0) (xy 1 1)) (layers "F.Cu" "F.Paste") (thickness 1.6) (name "abc"))`);

  it('head / child / children', () => {
    expect(headOf(root)).toBe('fp');
    expect(children(root, 'pad')).toHaveLength(2);
    expect(child(root, 'layer')).toEqual(['layer', 'F.Cu']);
    expect(child(root, 'nothing')).toBeUndefined();
  });

  it('数値・文字列の取り出し', () => {
    expect(childNum(root, 'thickness')).toBe(1.6);
    expect(childNum(root, 'missing', 7)).toBe(7);
    expect(childStr(root, 'name')).toBe('abc');
    expect(strAt(root, 1)).toBe('R_0603');
    expect(numAt(child(root, 'at'), 3)).toBe(90);
    expect(numAt(child(root, 'at'), 9, -1)).toBe(-1);
    expect(childXY(root, 'at')).toEqual([10, 20]);
    expect(childXY(root, 'name')).toBeUndefined();
  });

  it('点列と引数の列', () => {
    expect(pointsOf(root)).toEqual([[0, 0], [1, 0], [1, 1]]);
    expect(atomArgs(child(root, 'layers')!)).toEqual(['F.Cu', 'F.Paste']);
  });
});
