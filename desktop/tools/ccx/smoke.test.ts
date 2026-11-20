// smoke.mjs の純粋な関数のテスト（ccx も electron もなくても通る）
import { describe, expect, it } from 'vitest';
// @ts-expect-error 型宣言のない .mjs（ビルド用の道具）
import { allSame, buildBeamInp, parseTipDeflection, relError, theoryDeflection } from './smoke.mjs';

describe('smoke.mjs', () => {
  it('理論値は PL^3/(3EI)（100 N・100 mm・10 mm 角・210 GPa で約 0.1905 mm）', () => {
    expect(theoryDeflection()).toBeCloseTo(0.190476, 5);
  });

  it('.inp に節点 9・要素 8 と荷重が入る', () => {
    const inp = buildBeamInp();
    expect(inp).toContain('*ELEMENT, TYPE=B31');
    expect(inp).toContain('9, 100.000000, 0., 0.');
    expect(inp).toContain('NTIP, 2, 100.');
  });

  it('.dat から先端の y 変位の絶対値を読む', () => {
    const dat = ' displacements (vx,vy,vz) for set NTIP and time  0.1000000E+01\n\n         9  0.000000E+00 -1.904762E-01  0.000000E+00\n';
    expect(parseTipDeflection(dat)).toBeCloseTo(0.1904762, 6);
  });

  it('変位がなければ、日本語の説明つきで失敗する', () => {
    expect(() => parseTipDeflection('nothing')).toThrow('変位が出ていません');
  });

  it('相対差と一致の判定', () => {
    expect(relError(1.02, 1)).toBeCloseTo(0.02, 10);
    expect(allSame([1, 1, 1])).toBe(true);
    expect(allSame([1, 1, 1.01])).toBe(false);
    expect(allSame([])).toBe(false);
  });
});
