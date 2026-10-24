import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MATERIALS } from '../core/materials';
import { defaultProject } from '../core/project';
import { rasterize } from '../core/raster';
import type { Project, ResultSet, Shape } from '../core/types';
import { createEMSolver, slabTransmission } from './em';
import type { EMSolver } from './em';

const C = 299792458;
const F = 24e9;
const LAMBDA0 = C / F;
const EPS_PLA = 2.8;

// tanδ = 0 の PLA（解析解との比較用）
beforeAll(() => {
  MATERIALS.push({ id: 'pla-lossless', name: 'PLA(無損失)', kind: 'solid', rho: 1240, k: 0.13, cp: 1800, epsR: EPS_PLA, tanD: 0, color: '#7bc96f' });
});
afterAll(() => {
  const i = MATERIALS.findIndex((m) => m.id === 'pla-lossless');
  if (i >= 0) MATERIALS.splice(i, 1);
});

interface Opts {
  nx?: number;
  ny?: number;
  /** 1 セルの幅 [m]（省略時は空気中の 1 波長を 24 セル） */
  h?: number;
  pol?: 'TM' | 'TE';
  source?: 'plane' | 'point';
  angle?: number;
  wave?: 'cw' | 'pulse';
  pml?: number;
  courant?: number;
  px?: number;
  py?: number;
  shapes?: Shape[];
}

function makeProject(o: Opts): Project {
  const p = defaultProject();
  const nx = o.nx ?? 160;
  const ny = o.ny ?? 80;
  const h = o.h ?? LAMBDA0 / 24;
  p.domain = { width: nx * h, height: ny * h, nx, autoGrid: false };
  p.em = {
    frequencyGHz: F / 1e9,
    source: o.source ?? 'plane',
    angleDeg: o.angle ?? 0,
    pointX: o.px ?? 0.3 * nx * h,
    pointY: o.py ?? 0.5 * ny * h,
    polarization: o.pol ?? 'TM',
    mediumId: 'air',
    advanced: { waveform: o.wave ?? 'cw', pmlCells: o.pml, courant: o.courant },
  };
  p.shapes = o.shapes ?? [];
  return p;
}

/** 縦いっぱい（上下とも領域の外まで）の板。x0 から cells セル分の厚さ */
function slab(o: Opts, materialId: string, cells: number, x0Cells?: number): Shape {
  const nx = o.nx ?? 160;
  const ny = o.ny ?? 80;
  const h = o.h ?? LAMBDA0 / 24;
  return {
    id: 'slab',
    name: '板',
    role: 'solid',
    materialId,
    geom: { kind: 'rect', x: (x0Cells ?? Math.round(nx / 2)) * h, y: -h, w: cells * h, h: ny * h + 2 * h },
  };
}

function build(o: Opts): EMSolver {
  const p = makeProject(o);
  return createEMSolver(p, rasterize(p)) as EMSolver;
}

/** 定常になるまで進めて結果を返す */
function runSteady(solver: EMSolver, extraPeriods = 6): ResultSet {
  solver.advance(solver.settleSteps + extraPeriods * solver.stepsPerPeriod);
  return solver.result();
}

const scalar = (r: ResultSet, key: string): number => r.scalars.find((s) => s.key === key)!.value;
const field = (r: ResultSet, key: string) => r.fields.find((f) => f.key === key)!;
const finite = (a: Float32Array) => a.every((v) => Number.isFinite(v));

describe('slabTransmission（解析解）', () => {
  const n = Math.sqrt(EPS_PLA);

  it('無損失の半波長板は完全に透過する', () => {
    const d = LAMBDA0 / (2 * n);
    const r = slabTransmission(EPS_PLA, 0, d, F);
    expect(r.transmission).toBeCloseTo(1, 6);
    expect(r.reflection).toBeLessThan(1e-6);
    // 半波長の 2 倍でも同じ
    expect(slabTransmission(EPS_PLA, 0, 2 * d, F).transmission).toBeCloseTo(1, 6);
  });

  it('無損失の四分の一波長板の透過率は 4n²/(1+n²)²', () => {
    const d = LAMBDA0 / (4 * n);
    const r = slabTransmission(EPS_PLA, 0, d, F);
    expect(r.transmission).toBeCloseTo((4 * EPS_PLA) / (1 + EPS_PLA) ** 2, 6);
  });

  it('無損失ならエネルギー保存（T + R = 1）', () => {
    for (const eps of [1.5, 2.8, 6.5]) {
      for (const dMm of [0.3, 1.2, 1.9, 3.7, 5.5, 9]) {
        const r = slabTransmission(eps, 0, dMm * 1e-3, F);
        expect(r.transmission + r.reflection).toBeCloseTo(1, 9);
        expect(r.absorption).toBeCloseTo(0, 9);
      }
    }
  });

  it('損失があると T + R < 1 で、吸収が正になる', () => {
    const r = slabTransmission(EPS_PLA, 0.05, 3.7e-3, F);
    expect(r.absorption).toBeGreaterThan(0.01);
    expect(r.transmission + r.reflection + r.absorption).toBeCloseTo(1, 9);
    expect(r.transmission).toBeLessThan(slabTransmission(EPS_PLA, 0, 3.7e-3, F).transmission);
  });

  it('厚さ 0 なら素通り', () => {
    expect(slabTransmission(4, 0.1, 0, F).transmission).toBeCloseTo(1, 9);
  });
});

describe('createEMSolver 平面波', () => {
  for (const pol of ['TM', 'TE'] as const) {
    it(`${pol}: 物体なし（自由空間）では透過 ≈ 100%、反射 ≈ 0、NaN なし`, () => {
      const solver = build({ pol });
      const r = runSteady(solver);
      expect(scalar(r, 'transmission')).toBeGreaterThan(97);
      expect(scalar(r, 'transmission')).toBeLessThan(103);
      expect(scalar(r, 'reflection')).toBeLessThan(1);
      for (const f of r.fields) expect(finite(f.data)).toBe(true);
      // 振幅は入射波の 1 V/m
      const amp = field(r, 'amplitude').data;
      expect(amp[40 * 160 + 80]).toBeCloseTo(1, 2);
    });

    it(`${pol}: 金属の壁（縦いっぱい）は電波を止めて、ほぼ全反射する`, () => {
      const o: Opts = { pol };
      o.shapes = [slab(o, 'al6061', 4)];
      const r = runSteady(build(o));
      expect(scalar(r, 'transmission')).toBeLessThan(2);
      expect(scalar(r, 'reflection')).toBeGreaterThan(90);
      expect(scalar(r, 'reflection')).toBeLessThan(110);
    });

    it(`${pol}: 無損失の誘電体板（半波長・四分の一波長）が解析解と 5 ポイント以内で一致`, () => {
      const h = LAMBDA0 / 24;
      const nHalf = Math.round(LAMBDA0 / (2 * Math.sqrt(EPS_PLA)) / h); // 7 セル
      const nQuarter = Math.round(LAMBDA0 / (4 * Math.sqrt(EPS_PLA)) / h); // 4 セル（3.6 → 四分の一波長に近い）
      const results: number[] = [];
      for (const cells of [nHalf, nQuarter]) {
        const o: Opts = { pol };
        o.shapes = [slab(o, 'pla-lossless', cells)];
        const r = runSteady(build(o));
        const a = slabTransmission(EPS_PLA, 0, cells * h, F);
        const t = scalar(r, 'transmission');
        const rf = scalar(r, 'reflection');
        expect(Math.abs(t - 100 * a.transmission)).toBeLessThan(5);
        expect(Math.abs(rf - 100 * a.reflection)).toBeLessThan(5);
        results.push(t);
      }
      // 半波長板はほぼ透明、四分の一波長板は目に見えて落ちる
      expect(results[0]).toBeGreaterThan(95);
      expect(results[1]).toBeLessThan(92);
      expect(results[1]).toBeGreaterThan(65);
    });
  }

  it('PLA（tanδ = 0.01）の損失込みでも解析解に合う', () => {
    const h = LAMBDA0 / 24;
    const cells = 7;
    const o: Opts = {};
    o.shapes = [slab(o, 'pla', cells)];
    const r = runSteady(build(o));
    const a = slabTransmission(EPS_PLA, 0.01, cells * h, F);
    expect(Math.abs(scalar(r, 'transmission') - 100 * a.transmission)).toBeLessThan(5);
    expect(Math.abs(scalar(r, 'reflection') - 100 * a.reflection)).toBeLessThan(5);
  });

  it('レーダーカバーのプリセットと同じ配置（120×80 mm、縦 64 mm の板が上下の PML から離れている）で T + R ≈ 100%・解析解と 5 ポイント以内', () => {
    // 有限の高さの板は縁で回折する。遠くで測ると 100% を超えるので、測定線は物体のすぐ近くに置く
    const h = 0.12 / 322;
    for (const [tMm, materialId, tanD] of [
      [3.7, 'pla-lossless', 0],
      [1.9, 'pla-lossless', 0],
    ] as const) {
      const cells = Math.round(tMm * 1e-3 / h);
      const p = makeProject({ nx: 322, ny: 215, h });
      p.shapes = [
        { id: 's', name: 'カバー', role: 'solid', materialId, geom: { kind: 'rect', x: Math.round(0.05 / h) * h - (cells * h) / 2, y: 0.008, w: cells * h, h: 0.064 } },
      ];
      const solver = createEMSolver(p, rasterize(p)) as EMSolver;
      const r = runSteady(solver);
      const a = slabTransmission(EPS_PLA, tanD, cells * h, F);
      const t = scalar(r, 'transmission');
      const rf = scalar(r, 'reflection');
      expect(Math.abs(t - 100 * a.transmission)).toBeLessThan(5);
      expect(Math.abs(rf - 100 * a.reflection)).toBeLessThan(5);
      // 無損失なら T + R ≈ 100%
      if (tanD === 0) expect(Math.abs(t + rf - 100)).toBeLessThan(5);
    }
  });

  it('斜め入射（30°、TM）の板の透過率が解析解（斜入射のファブリ・ペロー）に近い', () => {
    const h = LAMBDA0 / 24;
    const cells = 6;
    const o: Opts = { nx: 260, ny: 260, angle: 30 };
    o.shapes = [slab(o, 'pla-lossless', cells)];
    const r = runSteady(build(o));
    // s 偏光（TM）の斜入射: δ = k0·n·d·cosθ2、R1 = ((cosθ1 − n cosθ2)/(cosθ1 + n cosθ2))²
    const n = Math.sqrt(EPS_PLA);
    const c1 = Math.cos(Math.PI / 6);
    const c2 = Math.sqrt(1 - (Math.sin(Math.PI / 6) / n) ** 2);
    const R1 = ((c1 - n * c2) / (c1 + n * c2)) ** 2;
    const delta = ((2 * Math.PI * cells * h) / LAMBDA0) * n * c2;
    const tAnalytic = 1 / (1 + ((4 * R1) / (1 - R1) ** 2) * Math.sin(delta) ** 2);
    expect(Math.abs(scalar(r, 'transmission') - 100 * tAnalytic)).toBeLessThan(6);
    for (const f of r.fields) expect(finite(f.data)).toBe(true);
  });

  it('パルス波形でも透過率が解析解に合い、通過後に done になる', () => {
    const h = LAMBDA0 / 24;
    const cells = 4;
    const o: Opts = { wave: 'pulse' };
    o.shapes = [slab(o, 'pla-lossless', cells)];
    const solver = build(o);
    let st = solver.step(50);
    for (let i = 0; i < 400 && !st.done; i++) st = solver.step(50);
    expect(st.done).toBe(true);
    expect(st.progress).toBe(1);
    const r = solver.result();
    const a = slabTransmission(EPS_PLA, 0, cells * h, F);
    expect(Math.abs(scalar(r, 'transmission') - 100 * a.transmission)).toBeLessThan(8);
    expect(finite(field(r, 'field').data)).toBe(true);
  });
});

describe('createEMSolver 点波源', () => {
  for (const pol of ['TM', 'TE'] as const) {
    it(`${pol}: 物体なしで NaN が出ず、散乱波は 0、観測点の振幅は ≈ 1`, () => {
      const solver = build({ pol, source: 'point' });
      const r = runSteady(solver);
      for (const f of r.fields) expect(finite(f.data)).toBe(true);
      expect(Math.max(...field(r, 'scattered').data)).toBe(0);
      // 波源の右 5 セルの振幅は 1 より大きい（近いほど強い）
      const nx = 160;
      const amp = field(r, 'amplitude').data;
      const j = 40;
      const i0 = Math.floor(0.3 * nx);
      expect(amp[j * nx + i0 + 6]).toBeGreaterThan(amp[j * nx + i0 + 30]);
      expect(amp[j * nx + i0 + 30]).toBeGreaterThan(0.2);
      // 平面波用の指標は出さない
      expect(r.scalars.find((s) => s.key === 'transmission')).toBeUndefined();
    });
  }

  it('金属の円柱を置くと散乱波が出る', () => {
    const h = LAMBDA0 / 24;
    const o: Opts = { source: 'point' };
    o.shapes = [{ id: 'c', name: '円柱', role: 'solid', materialId: 'al6061', geom: { kind: 'circle', cx: 100 * h, cy: 40 * h, r: 5 * h } }];
    const r = runSteady(build(o));
    for (const f of r.fields) expect(finite(f.data)).toBe(true);
    expect(Math.max(...field(r, 'scattered').data)).toBeGreaterThan(0.05);
    // 円柱の中は表示しない
    expect(field(r, 'amplitude').mask![40 * 160 + 100]).toBe(0);
  });
});

describe('Solver の動作と結果の形', () => {
  it('step() は進捗を返し、CW は定常後も done=false で動き続ける', () => {
    const o: Opts = {};
    o.shapes = [slab(o, 'pla', 7)];
    const solver = build(o);
    const s1 = solver.step(20);
    const s2 = solver.step(20);
    expect(solver.analysis).toBe('em');
    expect(s1.done).toBe(false);
    expect(s2.iteration).toBeGreaterThan(s1.iteration);
    expect(s1.progress).toBeLessThan(1);
    solver.advance(solver.settleSteps);
    const s3 = solver.step(10);
    expect(s3.done).toBe(false);
    expect(s3.progress).toBe(1);
    expect(s3.message).toBe('定常に達しました');

    const r = solver.result();
    expect(r.analysis).toBe('em');
    expect(r.nx).toBe(160);
    expect(r.ny).toBe(80);
    expect(r.fields.map((f) => f.key)).toEqual(['field', 'amplitude', 'scattered', 'intensity']);
    expect(field(r, 'field').diverging).toBe(true);
    for (const key of ['frequency', 'wavelength', 'cellsPerWavelength', 'transmission', 'reflection', 'time']) {
      expect(r.scalars.find((s) => s.key === key)).toBeDefined();
    }
    expect(scalar(r, 'frequency')).toBeCloseTo(24, 9);
    expect(scalar(r, 'wavelength')).toBeCloseTo((LAMBDA0 * 1e3) / Math.sqrt(1.0006), 2);
    expect(r.history.map((x) => x.key)).toEqual(['transmission', 'reflection']);
    expect(r.history[0].t.length).toBeGreaterThan(3);
    expect(r.history[0].t.length).toBe(r.history[0].values.length);
    // dB は −40 以上
    expect(Math.min(...field(r, 'intensity').data)).toBeGreaterThanOrEqual(-40);
  });

  it('金属はマスクされ、金属の注意と 2D の注意が出る', () => {
    const o: Opts = {};
    o.shapes = [slab(o, 'al6061', 4, 60)];
    const r = runSteady(build(o), 1);
    expect(field(r, 'field').mask![40 * 160 + 61]).toBe(0);
    expect(field(r, 'field').mask![40 * 160 + 20]).toBe(1);
    expect(r.warnings.some((w) => w.includes('金属は完全導体として扱います'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('断面'))).toBe(true);
  });

  it('粗い格子・PML にかかる形状・クーラン数の超過を警告する', () => {
    const o: Opts = { h: LAMBDA0 / 6, nx: 40, ny: 24, courant: 0.9 };
    o.shapes = [slab(o, 'pla', 2, 1)];
    const p = makeProject(o);
    const solver = createEMSolver(p, rasterize(p)) as EMSolver;
    const w = solver.result().warnings;
    expect(w.some((x) => x.includes('格子が粗い') && x.includes('格子を細かく'))).toBe(true);
    expect(w.some((x) => x.includes('PML'))).toBe(true);
    expect(w.some((x) => x.includes('クーラン数'))).toBe(true);
    expect(solver.courant).toBeLessThan(0.71);
    // 十分細かければ解像度の警告は出ない
    const fine = build({}).result().warnings;
    expect(fine.some((x) => x.includes('格子が粗い'))).toBe(false);
    expect(solver.cellsPerWavelength).toBeLessThan(10);
  });

  it('1 周期が整数ステップになるよう dt を調整し、クーラン数は上限以下', () => {
    const solver = build({ courant: 0.5 });
    expect(solver.dt * solver.stepsPerPeriod * F).toBeCloseTo(1, 9);
    expect(solver.courant).toBeLessThanOrEqual(0.5);
    expect(solver.courant).toBeGreaterThan(0.45);
  });

  it('PML を使わない設定（0 セル）でも動く', () => {
    const o: Opts = { pml: 0 };
    o.shapes = [slab(o, 'pla', 6)];
    const r = runSteady(build(o), 2);
    for (const f of r.fields) expect(finite(f.data)).toBe(true);
  });

  it('400×300 の TM で十分な速さ（目標 300 ステップ/秒。CI の負荷を見込んで 120 以上を要求）', () => {
    const h = LAMBDA0 / 24;
    const o: Opts = { nx: 400, ny: 300 };
    o.shapes = [{ id: 'c', name: '円', role: 'solid', materialId: 'pla', geom: { kind: 'circle', cx: 150 * h, cy: 150 * h, r: 20 * h } }];
    const solver = build(o);
    solver.advance(40);
    const t0 = performance.now();
    solver.advance(300);
    const rate = (300 / (performance.now() - t0)) * 1000;
    expect(rate).toBeGreaterThan(120);
  });
});
