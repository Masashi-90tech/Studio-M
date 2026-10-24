import { defaultProject } from '../core/project';
import { rasterize } from '../core/raster';
import type { Project, ResultSet, Solver } from '../core/types';
import { createStencil, sorSweep } from './linear';
import { createScalarSolver, scalarCoefficients } from './scalar';

/** 収束するまで回して結果を返す */
function solve(project: Project, maxMs = 8000): { solver: Solver; result: ResultSet; iterations: number; ms: number } {
  const solver = createScalarSolver(project, rasterize(project));
  const t0 = performance.now();
  let status = solver.step(50);
  while (!status.done && performance.now() - t0 < maxMs) status = solver.step(50);
  expect(status.done).toBe(true);
  return { solver, result: solver.result(), iterations: status.iteration, ms: performance.now() - t0 };
}

const scalar = (r: ResultSet, key: string) => r.scalars.find((s) => s.key === key)!.value;
const phiAt = (r: ResultSet, x: number, y: number) => {
  const i = Math.floor(x / r.h);
  const j = Math.floor(y / r.h);
  return r.fields[0].data[j * r.nx + i];
};

describe('スカラー解析', () => {
  it('物体がなく拡散が非常に大きいとき、φ はどこでも入口の値になる', () => {
    const p = defaultProject();
    p.shapes = [];
    p.scalar.gamma = 1e4;
    const { result } = solve(p);
    const f = result.fields[0];
    for (let c = 0; c < f.data.length; c += 37) expect(f.data[c]).toBeCloseTo(p.scalar.phiInlet, 4);
    expect(scalar(result, 'phiMin')).toBeCloseTo(1, 4);
    expect(scalar(result, 'phiMax')).toBeCloseTo(1, 4);
  });

  it('既定の四角柱: 収束し、φ は物体の値と入口の値の間に収まる', () => {
    const p = defaultProject();
    const { result, ms } = solve(p);
    const min = scalar(result, 'phiMin');
    const max = scalar(result, 'phiMax');
    expect(min).toBeGreaterThanOrEqual(p.scalar.phiBody - 1e-6);
    expect(max).toBeLessThanOrEqual(p.scalar.phiInlet + 1e-6);
    expect(scalar(result, 'iterations')).toBeGreaterThan(0);
    expect(ms).toBeLessThan(5000);
    expect(result.warnings).toEqual([]);

    // 上流の遠方 > 物体のすぐ手前 > 物体の後ろ（x=0.45〜0.65, y=0.4〜0.6 が物体）
    const far = phiAt(result, 0.1, 0.5);
    const front = phiAt(result, 0.43, 0.5);
    const behind = phiAt(result, 0.7, 0.5);
    expect(far).toBeGreaterThan(front);
    expect(far).toBeGreaterThan(behind);
    expect(far).toBeLessThan(1);
    expect(behind).toBeGreaterThan(0);

    // 物体セルはマスクされ、φ = phiBody で埋められる
    const f = result.fields[0];
    const solidCell = Math.floor(0.5 / result.h) * result.nx + Math.floor(0.55 / result.h);
    expect(f.mask![solidCell]).toBe(0);
    expect(f.data[solidCell]).toBe(p.scalar.phiBody);
    expect(result.history[0].values.length).toBeGreaterThan(2);
  });

  it('収束した解は十分に厳密に解いた解と一致する（打ち切り誤差が小さい）', () => {
    const p = defaultProject();
    const { result } = solve(p);
    const r = rasterize(p);
    const k = scalarCoefficients(p, r);
    const sys = createStencil(r.nx, r.ny);
    sys.active.set(k.unknown);
    sys.aP.set(k.aP);
    sys.aE.set(k.aE);
    sys.aW.set(k.aW);
    sys.aN.set(k.aN);
    sys.aS.set(k.aS);
    sys.b.set(k.b);
    // 収束後の解からさらに 3000 掃引して、解がどれだけ動くかを見る
    const x = Float64Array.from(result.fields[0].data);
    const exact = Float64Array.from(x);
    for (let it = 0; it < 3000; it++) sorSweep(sys, exact, 1.9);
    let maxDiff = 0;
    for (let c = 0; c < x.length; c++) if (k.unknown[c]) maxDiff = Math.max(maxDiff, Math.abs(x[c] - exact[c]));
    expect(maxDiff).toBeLessThan(5e-4);
  });

  it('pure convection に近い条件でも収束する', () => {
    const p = defaultProject();
    p.scalar.gamma = 0.01; // セルペクレ数 1
    const { result } = solve(p);
    expect(scalar(result, 'phiMax')).toBeLessThanOrEqual(1 + 1e-6);
    expect(scalar(result, 'phiMin')).toBeGreaterThanOrEqual(-1e-6);
  });

  it('セルペクレ数が大きいと警告し、それでも収束する', () => {
    const p = defaultProject();
    p.scalar.gamma = 0.001; // Pe = 10
    const { result } = solve(p);
    expect(result.warnings.length).toBe(1);
    expect(scalar(result, 'phiMax')).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('400×200 格子でも数秒以内に収束する', () => {
    const p = defaultProject();
    p.domain.nx = 400;
    const { ms, result } = solve(p, 9000);
    expect(ms).toBeLessThan(6000);
    expect(result.nx * result.ny).toBe(80000);
  });
});

describe('scalarCoefficients', () => {
  it('ハイブリッド法の係数と境界の扱いが仕様どおり', () => {
    const p = defaultProject();
    p.domain.nx = 20; // h = 0.1、ny = 10
    p.shapes = [{ id: 'b', name: '物体', role: 'solid', materialId: 'al6061', geom: { kind: 'rect', x: 0.8, y: 0.4, w: 0.2, h: 0.2 } }];
    p.scalar = { u: 1, gamma: 0.1, rho: 1, phiInlet: 1, phiBody: 0 };
    const r = rasterize(p);
    const k = scalarCoefficients(p, r);
    const F = 1 * 1 * r.h; // 0.1
    const D = 0.1;
    const nx = r.nx;
    const at = (i: number, j: number) => j * nx + i;

    // 内部の流体セル
    const c = at(5, 5);
    expect(k.unknown[c]).toBe(1);
    expect(k.aE[c]).toBeCloseTo(Math.max(-F, D - F / 2, 0), 12); // 0.05
    expect(k.aW[c]).toBeCloseTo(Math.max(F, D + F / 2, 0), 12); // 0.15
    expect(k.aN[c]).toBeCloseTo(D, 12);
    expect(k.aS[c]).toBeCloseTo(D, 12);
    expect(k.aB[c]).toBe(0);
    expect(k.aP[c]).toBeCloseTo(k.aE[c] + k.aW[c] + k.aN[c] + k.aS[c], 12);
    expect(k.b[c]).toBe(0);

    // 入口側（左端）: φ = 1 が b に入る
    const inlet = at(0, 5);
    const aIn = Math.max(F, 2 * D + F / 2, 0);
    expect(k.aW[inlet]).toBe(0);
    expect(k.aB[inlet]).toBeCloseTo(aIn, 12);
    expect(k.b[inlet]).toBeCloseTo(aIn * 1, 12);

    // 出口（右端）は東側の項なし、上下端は北・南の項なし
    expect(k.aE[at(nx - 1, 5)]).toBe(0);
    expect(k.aN[at(5, r.ny - 1)]).toBe(0);
    expect(k.aS[at(5, 0)]).toBe(0);

    // 物体の手前のセル（東隣が物体）: 壁面 2D、対流なし、phiBody = 0 なので b は 0
    const beforeBody = at(7, 5);
    expect(r.solid[at(8, 5)]).toBe(1);
    expect(k.aE[beforeBody]).toBe(0);
    expect(k.aB[beforeBody]).toBeCloseTo(2 * D, 12);
    expect(k.aP[beforeBody]).toBeCloseTo(k.aW[beforeBody] + k.aN[beforeBody] + k.aS[beforeBody] + 2 * D, 12);

    // 物体セルの行はすべて 0
    const inBody = at(8, 5);
    expect(k.unknown[inBody]).toBe(0);
    expect(k.aP[inBody]).toBe(0);
    expect(k.description.length).toBeGreaterThan(10);
  });
});

describe('スカラー解析: プロ設定（advanced）', () => {
  const coarse = (): Project => {
    const p = defaultProject();
    p.domain.nx = 20; // h = 0.1、ny = 10
    p.shapes = [{ id: 'b', name: '物体', role: 'solid', materialId: 'al6061', geom: { kind: 'rect', x: 0.8, y: 0.4, w: 0.2, h: 0.2 } }];
    p.scalar = { u: 1, gamma: 0.1, rho: 1, phiInlet: 1, phiBody: 0 };
    return p;
  };

  it('自動のときは緩和係数・セルペクレ数・収束判定を結果に報告する', () => {
    const { result } = solve(defaultProject());
    expect(scalar(result, 'relaxation')).toBe(1.9); // Pe = 0.1
    expect(scalar(result, 'cellPeclet')).toBeCloseTo(0.1, 9);
    expect(scalar(result, 'tolerance')).toBe(1e-8);
    expect(scalar(result, 'maxIterations')).toBe(200000);
  });

  it('scheme: upwind / central の係数が仕様どおり（内部セルと入口）', () => {
    const p = coarse();
    const F = 0.1;
    const D = 0.1;
    const at = (r: { nx: number }, i: number, j: number) => j * r.nx + i;

    p.scalar.advanced = { scheme: 'upwind' };
    let r = rasterize(p);
    let k = scalarCoefficients(p, r);
    expect(k.aE[at(r, 5, 5)]).toBeCloseTo(D + Math.max(-F, 0), 12);
    expect(k.aW[at(r, 5, 5)]).toBeCloseTo(D + Math.max(F, 0), 12);
    expect(k.aB[at(r, 0, 5)]).toBeCloseTo(2 * D + F, 12);
    expect(k.aP[at(r, 5, 5)]).toBeCloseTo(k.aE[at(r, 5, 5)] + k.aW[at(r, 5, 5)] + 2 * D, 12);

    p.scalar.advanced = { scheme: 'central' };
    r = rasterize(p);
    k = scalarCoefficients(p, r);
    expect(k.aE[at(r, 5, 5)]).toBeCloseTo(D - F / 2, 12);
    expect(k.aW[at(r, 5, 5)]).toBeCloseTo(D + F / 2, 12);
    expect(k.aB[at(r, 0, 5)]).toBeCloseTo(2 * D + F / 2, 12);

    // scheme 省略 = hybrid
    delete p.scalar.advanced;
    const auto = scalarCoefficients(p, rasterize(p));
    p.scalar.advanced = { scheme: 'hybrid' };
    const hyb = scalarCoefficients(p, rasterize(p));
    expect(Array.from(hyb.aE)).toEqual(Array.from(auto.aE));
    expect(Array.from(hyb.aW)).toEqual(Array.from(auto.aW));
  });

  it('Pe が大きいと upwind と hybrid の解が異なる（物体のすぐ後ろ）', () => {
    const base = defaultProject();
    base.scalar.gamma = 0.001; // Pe = 10
    const hyb = solve(base).result;
    const up = defaultProject();
    up.scalar.gamma = 0.001;
    up.scalar.advanced = { scheme: 'upwind' };
    const upRes = solve(up).result;
    // 風上差分は流れ方向にも拡散 D を足すので、ハイブリッド法とは φ の分布が違う
    let maxDiff = 0;
    for (let c = 0; c < hyb.fields[0].data.length; c++) {
      maxDiff = Math.max(maxDiff, Math.abs(hyb.fields[0].data[c] - upRes.fields[0].data[c]));
    }
    expect(maxDiff).toBeGreaterThan(1e-3);
    // 風上差分も有界
    expect(scalar(upRes, 'phiMax')).toBeLessThanOrEqual(1 + 1e-6);
    expect(scalar(upRes, 'phiMin')).toBeGreaterThanOrEqual(-1e-6);
  });

  it('Pe が小さければ central も収束し、hybrid とほぼ同じ解になる', () => {
    const a = defaultProject();
    const b = defaultProject();
    b.scalar.advanced = { scheme: 'central' };
    const ra = solve(a).result;
    const rb = solve(b).result;
    expect(rb.warnings).toEqual([]);
    expect(Math.abs(phiAt(ra, 0.7, 0.5) - phiAt(rb, 0.7, 0.5))).toBeLessThan(0.02);
  });

  it('central で Pe > 2 のときは振動の警告を出す', () => {
    const p = defaultProject();
    p.scalar.gamma = 0.001; // Pe = 10
    p.scalar.advanced = { scheme: 'central' };
    const solver = createScalarSolver(p, rasterize(p));
    const w = solver.result().warnings;
    expect(w.some((m) => m.includes('中心差分') && m.includes('振動'))).toBe(true);
  });

  it('tolerance を厳しくすると反復が増え、緩めると減る', () => {
    const loose = defaultProject();
    loose.scalar.advanced = { tolerance: 1e-4 };
    const tight = defaultProject();
    tight.scalar.advanced = { tolerance: 1e-11 };
    const a = solve(loose);
    const b = solve(defaultProject());
    const c = solve(tight);
    expect(a.iterations).toBeLessThan(b.iterations);
    expect(b.iterations).toBeLessThan(c.iterations);
    expect(scalar(c.result, 'tolerance')).toBe(1e-11);
  });

  it('maxIterations で打ち切ると警告が出る', () => {
    const p = defaultProject();
    p.scalar.advanced = { maxIterations: 10, tolerance: 1e-14 };
    const { result, iterations } = solve(p);
    expect(iterations).toBe(10);
    expect(result.warnings.some((w) => w.includes('最大反復回数（10回）'))).toBe(true);
  });

  it('relaxation を指定するとその ω を使い（自動より遅い 1.0 など）、範囲外は丸めて警告する', () => {
    const slow = defaultProject();
    slow.scalar.advanced = { relaxation: 1 };
    const a = solve(slow);
    const b = solve(defaultProject());
    expect(scalar(a.result, 'relaxation')).toBe(1);
    expect(a.iterations).toBeGreaterThan(b.iterations);

    const over = defaultProject();
    over.scalar.advanced = { relaxation: 3 };
    const w = createScalarSolver(over, rasterize(over));
    expect(scalar(w.result(), 'relaxation')).toBe(1.95);
    expect(w.result().warnings.some((m) => m.includes('丸めました'))).toBe(true);

    const under = defaultProject();
    under.scalar.advanced = { relaxation: 0.5 };
    expect(scalar(createScalarSolver(under, rasterize(under)).result(), 'relaxation')).toBe(1);
  });
});
