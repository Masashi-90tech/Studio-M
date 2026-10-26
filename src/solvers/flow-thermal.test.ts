// 流れ＋熱（共役伝熱）のテスト。格子は小さく（円柱の直径 10 セル）して、1 テスト数秒に収める。
import { describe, expect, it } from 'vitest';
import { getMaterial } from '../core/materials';
import { defaultProject } from '../core/project';
import { rasterize } from '../core/raster';
import type { Project, ResultSet, Shape } from '../core/types';
import { createFlowSolverWithOptions, type FlowSolver } from './flow';

const NU_AIR = 1.516e-5;
const K_AIR = getMaterial('air').k;
const PR_AIR = (NU_AIR * getMaterial('air').rho * getMaterial('air').cp) / K_AIR;

interface CylinderOpts {
  nx?: number;
  dCells?: number;
  heatW?: number;
  materialId?: string;
  inletTempC?: number;
  thermal?: boolean;
  maxTempC?: number;
  walls?: 'slip' | 'noslip';
}

/** 発熱する円柱まわりの流れ（領域 1 m × 0.5 m、直径 dCells セル、奥行き 10 mm）。Re を指定すると流速を逆算する */
function heatedCylinder(re: number, opts: CylinderOpts = {}): Project {
  const p = defaultProject();
  const nx = opts.nx ?? 100;
  const h = 1.0 / nx;
  const d = (opts.dCells ?? 10) * h;
  p.domain = { width: 1.0, height: 0.5, nx, autoGrid: false };
  p.flow = {
    fluidId: 'air',
    inletVelocity: (re * NU_AIR) / d,
    walls: opts.walls ?? 'slip',
    ...(opts.thermal === false ? {} : { thermal: { enabled: true, inletTempC: opts.inletTempC ?? 20 } }),
  };
  p.shapes = [
    {
      id: 'c',
      name: '円柱',
      role: 'heatSource',
      materialId: opts.materialId ?? 'c1100',
      heatW: opts.heatW ?? 0.05,
      geom: { kind: 'circle', cx: 0.25, cy: 0.25, r: d / 2 },
      ...(opts.maxTempC !== undefined ? { maxTempC: opts.maxTempC } : {}),
    },
  ];
  return p;
}

const scalar = (r: ResultSet, key: string): number | undefined => r.scalars.find((s) => s.key === key)?.value;
const field = (r: ResultSet, key: string) => r.fields.find((f) => f.key === key)!;

function run(p: Project, steps: number): { solver: FlowSolver; result: ResultSet } {
  const solver = createFlowSolverWithOptions(p, rasterize(p));
  solver.advance(steps);
  return { solver, result: solver.result() };
}

/** 円柱（物体のセル）の平均温度 [°C] */
function bodyMeanTemp(p: Project, r: ResultSet): number {
  const solid = rasterize(p).solid;
  const t = field(r, 'temp').data;
  let sum = 0;
  let n = 0;
  for (let c = 0; c < t.length; c++) {
    if (!solid[c]) continue;
    sum += t[c];
    n++;
  }
  return sum / n;
}

/** Churchill–Bernstein の式（円柱まわりの平均ヌセルト数） */
function churchillBernstein(re: number, pr: number): number {
  return 0.3 + (0.62 * Math.sqrt(re) * Math.cbrt(pr)) / Math.pow(1 + Math.pow(0.4 / pr, 2 / 3), 0.25) * Math.pow(1 + Math.pow(re / 282000, 5 / 8), 0.8);
}

describe('flow の温度（thermal）', () => {
  it('thermal を省略した結果は、enabled: false と同じで、温度の場・数値・履歴・部品ごとの結果がない', () => {
    const omitted = run(heatedCylinder(80, { thermal: false, maxTempC: 60 }), 300).result;
    const off = heatedCylinder(80, { maxTempC: 60 });
    off.flow.thermal = { enabled: false };
    const disabled = run(off, 300).result;
    expect(omitted.fields.map((f) => f.key)).toEqual(['speed', 'ux', 'uy', 'pressure', 'vorticity']);
    expect(omitted.scalars.map((s) => s.key)).not.toContain('maxTemp');
    expect(omitted.history.map((h) => h.key)).toEqual(['drag', 'lift']);
    expect(omitted.perShape).toBeUndefined();
    expect(disabled.fields.map((f) => f.key)).toEqual(omitted.fields.map((f) => f.key));
    for (const f of omitted.fields) expect(Array.from(field(disabled, f.key).data)).toEqual(Array.from(f.data));
    expect(disabled.scalars).toEqual(omitted.scalars);
    expect(disabled.warnings).toEqual(omitted.warnings);
  });

  it('温度を有効にしても、流れの結果（速度・圧力・抗力）は変わらない', () => {
    const base = run(heatedCylinder(80, { thermal: false }), 300).result;
    const hot = run(heatedCylinder(80), 300).result;
    for (const key of ['speed', 'ux', 'uy', 'pressure', 'vorticity']) {
      expect(Array.from(field(hot, key).data)).toEqual(Array.from(field(base, key).data));
    }
    expect(scalar(hot, 'drag')).toBe(scalar(base, 'drag'));
  });

  it('結果に温度の場（mask なし）・最高温度・流出熱・発熱・履歴・部品ごとの結果が出る', () => {
    const { result: r, solver } = run(heatedCylinder(40, { maxTempC: 60 }), 600);
    expect(solver.thermal).toBe(true);
    expect(r.fields.map((f) => f.key)).toEqual(['speed', 'ux', 'uy', 'pressure', 'vorticity', 'temp']);
    const temp = field(r, 'temp');
    expect(temp.label).toBe('温度');
    expect(temp.unit).toBe('°C');
    expect(temp.mask).toBeUndefined();
    expect(temp.data.length).toBe(r.nx * r.ny);
    for (const key of ['maxTemp', 'heatOut', 'heatIn']) expect(scalar(r, key), key).toBeDefined();
    expect(scalar(r, 'heatIn')!).toBeCloseTo(0.05, 6);
    expect(scalar(r, 'heatFixed')).toBeUndefined(); // 温度固定の図形がないときは出さない
    const hist = r.history.find((h) => h.key === 'maxTemp')!;
    expect(hist.values.length).toBeGreaterThan(5);
    expect(hist.t.length).toBe(hist.values.length);
    // 部品ごとの結果は熱解析（heat.ts）と同じ key・同じ並び
    expect(r.perShape).toHaveLength(1);
    const part = r.perShape![0];
    expect(part.label).toBe('円柱');
    expect(part.values.map((v) => v.key)).toEqual(['maxTemp', 'avgTemp', 'heatW', 'limitC', 'marginC']);
    const get = (key: string) => part.values.find((v) => v.key === key)!.value;
    expect(get('maxTemp')).toBeCloseTo(scalar(r, 'maxTemp')!, 6);
    expect(get('heatW')).toBeCloseTo(0.05, 6);
    expect(get('limitC')).toBe(60);
    expect(get('marginC')).toBeCloseTo(60 - get('maxTemp'), 6);
    // 注意書き: 2D の断面で表裏の放熱がないこと、固体の熱容量を扱わないこと
    expect(r.warnings.some((w) => w.includes('表裏'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('実時間'))).toBe(true);
  });

  it('発熱が 0 なら、温度はどこでも流入温度（±0.01 °C）', () => {
    const { result: r } = run(heatedCylinder(80, { heatW: 0, inletTempC: 30 }), 1200);
    const t = field(r, 'temp').data;
    let worst = 0;
    for (let c = 0; c < t.length; c++) worst = Math.max(worst, Math.abs(t[c] - 30));
    expect(worst).toBeLessThan(0.01);
    expect(scalar(r, 'maxTemp')!).toBeCloseTo(30, 2);
    expect(scalar(r, 'heatOut')!).toBeCloseTo(0, 6);
  });

  it('熱収支: 十分に進めると、流出口から風が運び出す熱が発熱の ±10% 以内になる', () => {
    const { result: r } = run(heatedCylinder(40), 5500);
    const out = scalar(r, 'heatOut')!;
    const inn = scalar(r, 'heatIn')!;
    expect(Math.abs(out - inn) / inn).toBeLessThan(0.1);
  });

  it('風速を上げると、同じ形・同じ発熱で最高温度が下がる', () => {
    const slow = scalar(run(heatedCylinder(20), 3000).result, 'maxTemp')!;
    const fast = scalar(run(heatedCylinder(40), 3000).result, 'maxTemp')!;
    expect(slow).toBeGreaterThan(20);
    expect(fast).toBeLessThan(slow);
    expect((fast - 20) / (slow - 20)).toBeLessThan(0.9);
  });

  it('円柱まわりの強制対流の平均ヌセルト数が、Churchill–Bernstein の式と 30% 以内で合う（Re = 20, 40）', () => {
    for (const re of [20, 40]) {
      const p = heatedCylinder(re);
      const { result: r } = run(p, 4000);
      const qPerDepth = scalar(r, 'heatIn')! / p.thickness; // 奥行き 1 m あたりの発熱 [W/m]
      const rise = bodyMeanTemp(p, r) - 20;
      const nu = qPerDepth / (Math.PI * K_AIR * rise); // Nu = h D / k = (q' / (π D ΔT)) D / k
      const ref = churchillBernstein(re, PR_AIR);
      expect(Math.abs(nu - ref) / ref, `Re=${re}: Nu=${nu.toFixed(2)}, 参考値 ${ref.toFixed(2)}`).toBeLessThan(0.3);
    }
  });

  it('銅（C1100）のように熱伝導率が高い材料でも発散せず、温度が流入温度を下回らない', () => {
    const p = heatedCylinder(100, { materialId: 'c1100', heatW: 0.1 });
    const { result: r } = run(p, 2500);
    const t = field(r, 'temp').data;
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = 0; c < t.length; c++) {
      expect(Number.isFinite(t[c])).toBe(true);
      lo = Math.min(lo, t[c]);
      hi = Math.max(hi, t[c]);
    }
    expect(lo).toBeGreaterThan(20 - 0.05);
    expect(hi).toBeLessThan(200);
    expect(r.warnings.some((w) => w.includes('温度の計算が不安定'))).toBe(false);
  });

  it('風が極端に遅く拡散が支配的でも（拡散数が大きくなっても）、サブステップと熱の時計の遅れで安定する', () => {
    const p = heatedCylinder(0.02, { nx: 40, dCells: 4 });
    const { result: r } = run(p, 300);
    const t = field(r, 'temp').data;
    let lo = Infinity;
    for (let c = 0; c < t.length; c++) {
      expect(Number.isFinite(t[c])).toBe(true);
      lo = Math.min(lo, t[c]);
    }
    expect(lo).toBeGreaterThan(20 - 0.05);
    expect(r.warnings.some((w) => w.includes('遅らせています'))).toBe(true);
  });
});

describe('flow の温度: 固体の中の伝導', () => {
  /** 銅の棒（長さ 40 mm × 高さ 8 mm）の左端を 50 °C に固定し、棒の中で一様に発熱させる。風は 0（熱はほぼ棒の中だけを伝わる） */
  function barProject(): { p: Project; q: number; length: number; t0: number } {
    const p = defaultProject();
    p.domain = { width: 0.06, height: 0.03, nx: 60, autoGrid: false };
    p.flow = { fluidId: 'air', inletVelocity: 0, walls: 'slip', thermal: { enabled: true, inletTempC: 25 } };
    const bar: Shape = { id: 'bar', name: '棒', role: 'heatSource', materialId: 'c1100', heatW: 78.1, geom: { kind: 'rect', x: 0.012, y: 0.011, w: 0.04, h: 0.008 } };
    const wall: Shape = { id: 'fix', name: '固定温度', role: 'fixedTemp', materialId: 'c1100', tempC: 50, geom: { kind: 'rect', x: 0.008, y: 0.011, w: 0.004, h: 0.008 } };
    p.shapes = [bar, wall];
    const volume = 0.04 * 0.008 * p.thickness;
    return { p, q: 78.1 / volume, length: 0.04, t0: 50 };
  }

  it('1 次元の熱伝導の手計算 T(x) = T0 + (q/k)(L x − x²/2) と 2% 以内で一致し、熱が固定温度へ流れ込む', () => {
    const { p, q, length, t0 } = barProject();
    const raster = rasterize(p);
    const { result: r } = run(p, 1500);
    const k = getMaterial('c1100').k;
    const rise = (q * length * length) / (2 * k); // 先端の温度上昇
    expect(rise).toBeGreaterThan(40);
    const temp = field(r, 'temp').data;
    const row = 15; // 棒の中心の 2 行（セル 11〜18 の真ん中）の平均をとる
    for (const i of [14, 24, 36, 51]) {
      const x = (i + 0.5) * raster.h - 0.012;
      const exact = t0 + (q / k) * (length * x - (x * x) / 2);
      const sim = (temp[14 * raster.nx + i] + temp[row * raster.nx + i]) / 2;
      expect(Math.abs(sim - exact) / rise, `i=${i}: ${sim.toFixed(2)} vs ${exact.toFixed(2)}`).toBeLessThan(0.02);
    }
    // 棒の最高温度は先端
    expect(scalar(r, 'maxTemp')!).toBeGreaterThan(t0 + 0.9 * rise);
    // 発熱はすべて固定温度の端から出ていく（風は 0）
    expect(scalar(r, 'heatFixed')! / scalar(r, 'heatIn')!).toBeGreaterThan(0.98);
    expect(scalar(r, 'heatFixed')! / scalar(r, 'heatIn')!).toBeLessThan(1.02);
  });
});
