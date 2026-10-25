import { describe, expect, it } from 'vitest';
import { PRESETS, beamHandCalc, halfWaveThicknessMm } from '../../ui/presets';
import { slabTransmission } from '../../solvers/em';
import type { AnalysisKind } from '../../core/types';
import { slabPower } from '../physics';
import type { Formula } from '../types';
import { MATH_PROVIDERS, getMathProvider } from './index';
import { beamParams } from './stress';
import { sectionLength } from './common';
import { flowRegime } from './flow';

const KINDS = Object.keys(MATH_PROVIDERS) as AnalysisKind[];

const baseVars = (f: Formula): Record<string, number> => Object.fromEntries(f.vars.map((v) => [v.key, v.value]));
const get = (id: string, kind: AnalysisKind, presetId: string): Formula => {
  const p = PRESETS.find((x) => x.id === presetId)!.build();
  const f = getMathProvider(kind)
    .formulas({ project: p, result: null })
    .find((x) => x.id === id);
  if (!f) throw new Error(`式が見つからない: ${id}`);
  return f;
};

describe('式の提供者: 全プリセット × 全解析', () => {
  for (const preset of PRESETS) {
    for (const kind of KINDS) {
      it(`${preset.id} / ${kind}: どの式も有限の値を返し、文字列が壊れない`, () => {
        const formulas = getMathProvider(kind).formulas({ project: preset.build(), result: null });
        expect(formulas.length).toBeGreaterThanOrEqual(3);
        expect(new Set(formulas.map((f) => f.id)).size).toBe(formulas.length);
        for (const f of formulas) {
          const base = baseVars(f);
          expect(new Set(f.vars.map((v) => v.key)).size, f.id).toBe(f.vars.length);
          expect(f.topics.length, f.id).toBeGreaterThan(0);
          expect(Number.isFinite(f.evaluate(base)), `${f.id} base`).toBe(true);
          const text = f.substituted(base);
          expect(text, f.id).not.toMatch(/NaN|undefined|Infinity/);
          for (const v of f.vars) {
            expect(Number.isFinite(v.value), `${f.id}.${v.key}`).toBe(true);
            if (v.min !== undefined) expect(v.min, `${f.id}.${v.key} min`).toBeLessThanOrEqual(v.value);
            if (v.max !== undefined) expect(v.max, `${f.id}.${v.key} max`).toBeGreaterThanOrEqual(v.value);
            if (v.log) expect(v.min, `${f.id}.${v.key} log`).toBeGreaterThan(0);
            if (v.fixed) continue;
            for (const factor of [0.5, 2]) {
              const moved = { ...base, [v.key]: v.value * factor };
              expect(Number.isFinite(f.evaluate(moved)), `${f.id}.${v.key}×${factor}`).toBe(true);
              expect(f.substituted(moved), `${f.id}.${v.key}×${factor}`).not.toMatch(/NaN|undefined|Infinity/);
              const hint = f.insight?.(moved, base);
              expect(hint === null || (typeof hint === 'string' && hint.length > 0), `${f.id} insight`).toBe(true);
            }
          }
          expect(f.insight?.(base, base) ?? null, `${f.id} 変化なし`).toBeNull();
        }
      });
    }
  }
});

describe('片持ち梁: 手計算との照合', () => {
  const hand = beamHandCalc();
  it('プロジェクトから P, L, h を正しく読み取る', () => {
    const p = PRESETS.find((x) => x.id === 'cantilever')!.build();
    const b = beamParams(p);
    expect(b.P).toBeCloseTo(100, 9);
    expect(b.L).toBeCloseTo(0.2, 9);
    expect(b.h).toBeCloseTo(0.01, 9);
    expect(b.t).toBeCloseTo(0.01, 9);
    expect(b.fromShapes).toBe(true);
    expect(b.axis).toBe('x');
  });
  it('たわみ δ が手計算と 1% 以内', () => {
    const f = get('stress-deflection', 'stress', 'cantilever');
    const mm = f.evaluate(baseVars(f)) * 1000;
    expect(Math.abs(mm / hand.deflectionMm - 1)).toBeLessThan(0.01);
    expect(f.expression).toContain('L³');
  });
  it('曲げ応力 σ が手計算と 1% 以内', () => {
    const f = get('stress-bending', 'stress', 'cantilever');
    const mpa = f.evaluate(baseVars(f)) / 1e6;
    expect(Math.abs(mpa / hand.stressMPa - 1)).toBeLessThan(0.01);
    expect(mpa).toBeCloseTo(120, 3);
  });
  it('安全率 = 降伏応力 ÷ 応力（A6061: 276 / 120 = 2.3）', () => {
    const f = get('stress-safety', 'stress', 'cantilever');
    expect(f.evaluate(baseVars(f))).toBeCloseTo(276 / 120, 6);
  });
  it('バネ 2 本の最小 FEM は梁の式と同じたわみになる', () => {
    const d = get('stress-deflection', 'stress', 'cantilever');
    const s = get('stress-springs', 'stress', 'cantilever');
    expect(s.evaluate(baseVars(s))).toBeCloseTo(d.evaluate(baseVars(d)), 9);
  });
  it('フックの法則: 根元のひずみから応力に戻る', () => {
    const f = get('stress-hooke', 'stress', 'cantilever');
    expect(f.evaluate(baseVars(f)) / 1e6).toBeCloseTo(120, 3);
  });
  it('結果があれば FEM の値を比較用に載せ、なければ載せない', () => {
    const p = PRESETS.find((x) => x.id === 'cantilever')!.build();
    const none = getMathProvider('stress').formulas({ project: p, result: null });
    expect(none.every((f) => f.simulation === undefined)).toBe(true);
    const result = {
      analysis: 'stress' as const,
      nx: 1,
      ny: 1,
      h: 1,
      fields: [],
      history: [],
      warnings: [],
      scalars: [
        { key: 'maxDisplacement', label: '', unit: 'm', value: 0.005 },
        { key: 'maxVonMises', label: '', unit: 'Pa', value: 130e6 },
        { key: 'minSafety', label: '', unit: '', value: 2.1 },
      ],
    };
    const withSim = getMathProvider('stress').formulas({ project: p, result });
    expect(withSim.find((f) => f.id === 'stress-deflection')!.simulation?.value).toBe(0.005);
    expect(withSim.find((f) => f.id === 'stress-bending')!.simulation?.value).toBe(130e6);
    expect(withSim.find((f) => f.id === 'stress-safety')!.simulation?.value).toBe(2.1);
    expect(withSim.find((f) => f.id === 'stress-deflection')!.approx).toBeTruthy();
  });
  it('L 字ブラケットは梁の長さを固定面から荷重まで、高さを腕の厚みから読む', () => {
    const b = beamParams(PRESETS.find((x) => x.id === 'l-bracket')!.build());
    expect(b.P).toBeCloseTo(50, 9);
    expect(b.L).toBeCloseTo(0.065, 6);
    expect(b.h).toBeCloseTo(0.01, 6);
  });
});

describe('insight（元の値との比べ方）', () => {
  it('L を 2 倍にすると δ は 8 倍（3 乗だから）', () => {
    const f = get('stress-deflection', 'stress', 'cantilever');
    const base = baseVars(f);
    const text = f.insight!({ ...base, L: base.L * 2 }, base)!;
    expect(text).toBe('L が 2 倍 → δ は 8 倍（3 乗だから）');
  });
  it('高さ h を 2 倍にすると応力は 1/4', () => {
    const f = get('stress-bending', 'stress', 'cantilever');
    const base = baseVars(f);
    expect(f.insight!({ ...base, h: base.h * 2 }, base)).toContain('0.25 倍（1/4）');
  });
  it('複数動かすと合計の倍率を言う', () => {
    const f = get('stress-deflection', 'stress', 'cantilever');
    const base = baseVars(f);
    const text = f.insight!({ ...base, L: base.L * 2, E: base.E * 2 }, base)!;
    expect(text).toContain('全部で');
    expect(text).toContain('4 倍');
  });
  it('dB: 電力 2 倍は約 +3 dB', () => {
    const f = get('em-db-power', 'em', 'radar-cover');
    const base = baseVars(f);
    expect(f.insight!({ ratio: base.ratio * 2 }, base)).toContain('+3.01 dB');
  });
});

describe('熱', () => {
  it('ΔT = P/(hA): 面積を 2 倍にすると半分', () => {
    const f = get('heat-convection', 'heat', 'heatsink');
    const base = baseVars(f);
    expect(base.P).toBe(10);
    expect(base.h).toBe(10);
    expect(f.evaluate({ ...base, A: base.A * 2 })).toBeCloseTo(f.evaluate(base) / 2, 9);
    expect(f.insight!({ ...base, A: base.A * 2 }, base)).toContain('半分');
  });
  it('放熱面積は周囲 × 奥行き + 表裏の面（ヒートシンク）', () => {
    const f = get('heat-convection', 'heat', 'heatsink');
    const A = baseVars(f).A;
    expect(A).toBeGreaterThan(0.01);
    expect(A).toBeLessThan(0.06);
  });
  it('熱抵抗 R = L/(kA): 銅にすると FR-4 より桁違いに小さい', () => {
    const f = get('heat-conduction', 'heat', 'board');
    const base = baseVars(f);
    expect(f.evaluate({ ...base, k: 391 })).toBeCloseTo(f.evaluate({ ...base, k: 0.3 }) * (0.3 / 391), 9);
  });
  it('時間 t = τ で最終値の 63.2%、t が大きいと 100% に近づく', () => {
    const f = get('heat-transient', 'heat', 'heatsink');
    const base = baseVars(f);
    const final = base.P / (base.h * base.A);
    expect(f.evaluate(base) / final).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(f.evaluate({ ...base, t: base.t * 20 }) / final).toBeGreaterThan(0.999);
  });
  it('熱のつり合い: ΔT を上の式の答えにすると Q = P', () => {
    const f = get('heat-balance', 'heat', 'heatsink');
    expect(f.evaluate(baseVars(f))).toBeCloseTo(10, 6);
  });
});

describe('流れ', () => {
  it('Re は流速に対して単調に増える', () => {
    const f = get('flow-reynolds', 'flow', 'karman');
    const base = baseVars(f);
    let prev = -Infinity;
    for (const k of [0.1, 0.5, 1, 2, 10]) {
      const re = f.evaluate({ ...base, U: base.U * k });
      expect(re).toBeGreaterThan(prev);
      prev = re;
    }
    expect(f.evaluate(base)).toBeCloseTo(150, 0);
  });
  it('抗力は流速の 2 乗に比例', () => {
    const f = get('flow-drag', 'flow', 'karman');
    const base = baseVars(f);
    expect(f.evaluate({ ...base, U: base.U * 3 }) / f.evaluate(base)).toBeCloseTo(9, 9);
    expect(f.insight!({ ...base, U: base.U * 2 }, base)).toContain('2 乗');
  });
  it('ストローハル: f = St·U/L', () => {
    const f = get('flow-strouhal', 'flow', 'karman');
    const b = baseVars(f);
    expect(f.evaluate(b)).toBeCloseTo((b.St * b.U) / b.L, 12);
  });
  it('レイノルズ数の言葉', () => {
    expect(flowRegime(10)).toContain('なめらか');
    expect(flowRegime(150)).toContain('渦');
    expect(flowRegime(5000)).toContain('乱');
  });
  it('Re の境目をまたぐと言葉が変わったと伝える', () => {
    const f = get('flow-reynolds', 'flow', 'karman');
    const base = baseVars(f);
    expect(f.insight!({ ...base, U: base.U * 10 }, base)).toContain('乱れた流れ');
  });
});

describe('電磁波', () => {
  it('PLA・24 GHz の半波長の厚みは約 3.7 mm（プリセットの計算と一致）', () => {
    const f = get('em-halfwave', 'em', 'radar-cover');
    const b = baseVars(f);
    expect(b.f).toBeCloseTo(24e9, 0);
    expect(b.epsR).toBeCloseTo(2.8, 9);
    const mm = f.evaluate(b) * 1000;
    expect(mm).toBeGreaterThan(3.65);
    expect(mm).toBeLessThan(3.8);
    expect(mm).toBeCloseTo(halfWaveThicknessMm(24, 2.8), 9);
  });
  it('波長 λ = c/f（24 GHz で 12.5 mm、2.4 GHz で 125 mm）', () => {
    const f = get('em-wavelength', 'em', 'radar-cover');
    const b = baseVars(f);
    expect(f.evaluate(b) * 1000).toBeCloseTo(12.49, 2);
    expect(f.evaluate({ ...b, f: 2.4e9 }) * 1000).toBeCloseTo(124.9, 1);
  });
  it('物質の中の波長は 1/√εr', () => {
    const f = get('em-wavelength-material', 'em', 'radar-cover');
    const b = baseVars(f);
    expect(f.evaluate({ ...b, epsR: 4 }) / f.evaluate({ ...b, epsR: 1 })).toBeCloseTo(0.5, 9);
  });
  it('透過率は 3.7 mm でほぼ 100%、半分の厚みでは下がる（ソルバーの式と一致）', () => {
    const f = get('em-slab', 'em', 'radar-cover');
    const b = baseVars(f);
    expect(f.evaluate(b)).toBeGreaterThan(95);
    const thin = f.evaluate({ ...b, d: b.d / 2 });
    expect(thin).toBeLessThan(f.evaluate(b));
    expect(f.evaluate({ ...b, d: 1.9e-3 })).toBeCloseTo(slabTransmission(b.epsR, b.tanD, 1.9e-3, b.f).transmission * 100, 9);
    expect(f.insight!({ ...b, d: b.d / 2 }, b)).toContain('透過は');
  });
  it('学びモード内の slabPower はソルバーの slabTransmission と同じ', () => {
    for (const [eps, tan, d, f] of [
      [2.8, 0.01, 3.7e-3, 24e9],
      [2.8, 0.01, 1.9e-3, 24e9],
      [5.5, 0.05, 0.1, 2.4e9],
      [78, 0.12, 2e-3, 2.4e9],
      [1, 0, 1e-3, 10e9],
    ]) {
      const a = slabPower(eps, tan, d, f);
      const b = slabTransmission(eps, tan, d, f);
      expect(a.transmission).toBeCloseTo(b.transmission, 12);
      expect(a.reflection).toBeCloseTo(b.reflection, 12);
    }
  });
  it('dB: 電力 1/2 → −3 dB、振幅 2 倍 → +6 dB、10 倍 → +10 / +20 dB', () => {
    const p = get('em-db-power', 'em', 'radar-cover');
    expect(p.evaluate({ ratio: 0.5 })).toBeCloseTo(-3.0103, 3);
    expect(p.evaluate({ ratio: 10 })).toBeCloseTo(10, 9);
    const a = get('em-db-amplitude', 'em', 'radar-cover');
    expect(a.evaluate({ ratio: 2 })).toBeCloseTo(6.0206, 3);
    expect(a.evaluate({ ratio: 10 })).toBeCloseTo(20, 9);
  });
  it('距離 2 倍で約 +6 dB', () => {
    const f = get('em-fspl', 'em', 'wifi-room');
    const b = baseVars(f);
    expect(f.evaluate({ ...b, dist: b.dist * 2 }) - f.evaluate(b)).toBeCloseTo(6.0206, 3);
  });
  it('斜め入射: 0° では厚みのまま、角度が増えると道のりが伸びる', () => {
    const f = get('em-oblique', 'em', 'radar-cover');
    const b = baseVars(f);
    expect(f.evaluate({ ...b, theta: 0 })).toBeCloseTo(b.d, 12);
    expect(f.evaluate({ ...b, theta: 60 })).toBeGreaterThan(f.evaluate({ ...b, theta: 30 }));
  });
  it('回折: sinθ = λ/D（10 GHz、70 mm で約 25°）', () => {
    const f = get('em-diffraction', 'em', 'metal-shadow');
    const b = baseVars(f);
    expect(b.D).toBeCloseTo(0.07, 9);
    expect(f.evaluate(b)).toBeCloseTo((Math.asin(0.0299792458 / 0.07) * 180) / Math.PI, 6);
  });
});

describe('対流拡散（動画の再現）', () => {
  it('ペクレ数と、ハイブリッド法の切り替わり（Pe = 2）', () => {
    const pe = get('scalar-peclet', 'scalar', 'square-column');
    const b = baseVars(pe);
    expect(pe.evaluate(b)).toBeCloseTo((b.rho * b.u * b.dx) / b.gamma, 12);
    const aw = get('scalar-hybrid-aw', 'scalar', 'square-column');
    const ae = get('scalar-hybrid-ae', 'scalar', 'square-column');
    // Pe = 1: 中心差分と同じ
    expect(aw.evaluate({ F: 1, D: 1 })).toBeCloseTo(1.5, 12);
    expect(ae.evaluate({ F: 1, D: 1 })).toBeCloseTo(0.5, 12);
    // Pe = 4: 風上（東の係数は 0）
    expect(aw.evaluate({ F: 4, D: 1 })).toBe(4);
    expect(ae.evaluate({ F: 4, D: 1 })).toBe(0);
  });
  it('ガウス・ザイデルの更新式は、同じ値の隣だけなら同じ値になる', () => {
    const gs = get('scalar-gauss-seidel', 'scalar', 'square-column');
    const b = baseVars(gs);
    const same = { ...b, phiE: 0.7, phiW: 0.7, phiN: 0.7, phiS: 0.7 };
    expect(gs.evaluate(same)).toBeCloseTo(0.7, 12);
    const aP = b.aE + b.aW + b.aN + b.aS;
    expect(gs.evaluate(b)).toBeCloseTo((b.aE * b.phiE + b.aW * b.phiW + b.aN * b.phiN + b.aS * b.phiS) / aP, 12);
  });
  it('収束までの回数: ρ が 1 に近いほど急に増える', () => {
    const f = get('scalar-convergence', 'scalar', 'square-column');
    const b = baseVars(f);
    const k = (rate: number) => f.evaluate({ ...b, rate });
    expect(k(0.999) / k(0.99)).toBeGreaterThan(9);
    expect(k(0.99)).toBeCloseTo(Math.log(b.tol / b.r0) / Math.log(0.99), 6);
  });
});

describe('断面の計算', () => {
  it('穴を含む断面は、穴の長さを引く', () => {
    const p = PRESETS.find((x) => x.id === 'l-bracket')!.build();
    // ボルト穴（x = 21 mm, r = 2.5 mm）を通る縦の線: 脚の高さ 60 mm から穴の直径 5 mm を引く
    expect(sectionLength(p, 'x', 0.021)).toBeCloseTo(0.055, 6);
    expect(sectionLength(p, 'x', 0.047)).toBeCloseTo(0.01, 6);
  });
  it('円の弦', () => {
    const p = PRESETS.find((x) => x.id === 'karman')!.build();
    const g = p.shapes[0].geom;
    if (g.kind !== 'circle') throw new Error('円のはず');
    expect(sectionLength(p, 'x', g.cx)).toBeCloseTo(2 * g.r, 9);
    expect(sectionLength(p, 'y', g.cy)).toBeCloseTo(2 * g.r, 9);
    expect(sectionLength(p, 'x', g.cx + g.r * 1.01)).toBe(0);
  });
});
