import { describe, expect, it } from 'vitest';
import { defaultProject } from '../core/project';
import { rasterize } from '../core/raster';
import type { Project, ResultSet } from '../core/types';
import { createFlowSolver, createFlowSolverWithOptions } from './flow';

/** 円柱まわりの流れ（格子 nx × nx/2、直径 10 格子分）。Re を指定すると流速を逆算する */
function cylinderProject(re: number, opts: { nx?: number; walls?: 'slip' | 'noslip'; fluidId?: string } = {}): Project {
  const p = defaultProject();
  const nx = opts.nx ?? 100;
  const h = 1.0 / nx;
  const d = 10 * h;
  const fluidId = opts.fluidId ?? 'air';
  const nu = fluidId === 'air' ? 1.516e-5 : 1.004e-6;
  p.domain = { width: 1.0, height: 0.5, nx };
  p.flow = { fluidId, inletVelocity: (re * nu) / d, walls: opts.walls ?? 'slip' };
  p.shapes = [{ id: 'c', name: '円柱', role: 'solid', materialId: 'al6061', geom: { kind: 'circle', cx: 0.25, cy: 0.25, r: d / 2 } }];
  return p;
}

const scalar = (r: ResultSet, key: string): number | undefined => r.scalars.find((s) => s.key === key)?.value;
const field = (r: ResultSet, key: string) => r.fields.find((f) => f.key === key)!;

describe('createFlowSolver', () => {
  it('step() は常に done=false で、反復回数が増え、結果の形が仕様どおり', () => {
    const p = cylinderProject(100);
    const solver = createFlowSolver(p, rasterize(p));
    const s1 = solver.step(20);
    const s2 = solver.step(20);
    expect(solver.analysis).toBe('flow');
    expect(s1.done).toBe(false);
    expect(s1.iteration).toBeGreaterThan(0);
    expect(s2.iteration).toBeGreaterThan(s1.iteration);

    const r = solver.result();
    expect(r.analysis).toBe('flow');
    expect(r.nx).toBe(100);
    expect(r.ny).toBe(50);
    expect(r.fields.map((f) => f.key)).toEqual(['speed', 'ux', 'uy', 'pressure', 'vorticity']);
    expect(field(r, 'pressure').diverging).toBe(true);
    expect(field(r, 'vorticity').diverging).toBe(true);
    for (const key of ['Re', 'drag', 'lift', 'Cd', 'Cl', 'time']) expect(scalar(r, key)).toBeDefined();
    expect(r.history.map((h) => h.key)).toEqual(['drag', 'lift']);
    // 物体セルはマスクで除外される
    const speed = field(r, 'speed');
    const solid = rasterize(p).solid;
    for (let c = 0; c < solid.length; c++) expect(speed.mask![c]).toBe(solid[c] ? 0 : 1);
  });

  it('既定プロジェクト（四角柱）が数千ステップ NaN なしで動き、上流で流速が流入速度に近い', () => {
    const p = defaultProject();
    p.domain.nx = 100;
    const raster = rasterize(p);
    const solver = createFlowSolverWithOptions(p, raster);
    solver.advance(2000);
    const r = solver.result();
    for (const f of r.fields) {
      for (let c = 0; c < f.data.length; c++) {
        if (f.mask![c]) expect(Number.isFinite(f.data[c])).toBe(true);
      }
    }
    expect(r.warnings).toEqual([]);
    expect(scalar(r, 'drag')!).toBeGreaterThan(0);
    // 上流側（物体の手前、中央高さ）の流速は流入速度の近く
    const speed = field(r, 'speed').data;
    const probe = speed[Math.floor(raster.ny / 2) * raster.nx + 5];
    expect(Math.abs(probe - p.flow.inletVelocity) / p.flow.inletVelocity).toBeLessThan(0.15);
  });

  it('円柱の抗力は +x 向きで正、Cd が妥当な範囲、時間軸は物理秒', () => {
    const p = cylinderProject(100);
    const solver = createFlowSolverWithOptions(p, rasterize(p));
    solver.advance(2500);
    const r = solver.result();
    expect(scalar(r, 'drag')!).toBeGreaterThan(0);
    const cd = scalar(r, 'Cd')!;
    expect(cd).toBeGreaterThan(0.5);
    expect(cd).toBeLessThan(4);
    expect(scalar(r, 'time')!).toBeCloseTo(2500 * solver.dt, 9);
    const hist = r.history[0];
    expect(hist.t.length).toBeGreaterThan(10);
    expect(hist.t.length).toBe(hist.values.length);
    expect(hist.values[hist.values.length - 1]).toBeGreaterThan(0);
  });

  it('擾乱なし・対称な条件では揚力が抗力に比べてほぼ 0', () => {
    const p = cylinderProject(100);
    const solver = createFlowSolverWithOptions(p, rasterize(p), { perturbation: 0 });
    solver.advance(800);
    const r = solver.result();
    const drag = scalar(r, 'drag')!;
    const lift = scalar(r, 'lift')!;
    expect(drag).toBeGreaterThan(0);
    expect(Math.abs(lift)).toBeLessThan(1e-3 * drag);
  });

  it('質量がおおむね保存される（流入出があるので数%以内）', () => {
    const p = cylinderProject(100);
    const solver = createFlowSolverWithOptions(p, rasterize(p));
    const m0 = solver.totalMass();
    solver.advance(1500);
    const m1 = solver.totalMass();
    expect(Math.abs(m1 - m0) / m0).toBeLessThan(0.03);
  });

  it('壁面（noslip）でも安定して動き、壁際の流速は中央より小さい', () => {
    const p = cylinderProject(100, { walls: 'noslip' });
    const raster = rasterize(p);
    const solver = createFlowSolverWithOptions(p, raster);
    solver.advance(1500);
    const r = solver.result();
    expect(scalar(r, 'drag')!).toBeGreaterThan(0);
    const speed = field(r, 'speed').data;
    const nx = raster.nx;
    // 物体より上流の x = 15 で、最下行と中央を比べる
    expect(speed[0 * nx + 15]).toBeLessThan(speed[Math.floor(raster.ny / 2) * nx + 15]);
    expect(Number.isFinite(speed[0 * nx + 15])).toBe(true);
  });

  it('格子に対して Re が高すぎるときは Japanese の警告を出し、それでも発散しない', () => {
    // 水・約 1 m/s・直径 0.1 m → Re ≈ 10 万。nx=100 では到底解像できない
    const p = cylinderProject(1e5, { fluidId: 'water' });
    const solver = createFlowSolverWithOptions(p, rasterize(p));
    expect(solver.rePhysical).toBeGreaterThan(5e4);
    expect(solver.reEffective).toBeLessThan(solver.rePhysical);
    solver.advance(1500);
    const r = solver.result();
    expect(r.warnings.some((w) => w.includes('格子が粗い'))).toBe(true);
    for (const f of r.fields) {
      for (let c = 0; c < f.data.length; c++) {
        if (f.mask![c]) expect(Number.isFinite(f.data[c])).toBe(true);
      }
    }
  });

  it('Re が十分低ければ「格子が粗い」警告は出ない', () => {
    const p = cylinderProject(100);
    const solver = createFlowSolverWithOptions(p, rasterize(p));
    expect(solver.result().warnings.some((w) => w.includes('格子が粗い'))).toBe(false);
    expect(solver.reEffective).toBeCloseTo(solver.rePhysical, 6);
  });

  it('カルマン渦が立ち上がり、ストローハル数が検出される', () => {
    const p = cylinderProject(150);
    const solver = createFlowSolver(p, rasterize(p));
    // 数千ステップ単位で進め、検出できたら打ち切る
    let st: number | undefined;
    for (let k = 0; k < 40 && st === undefined; k++) {
      solver.step(250);
      st = scalar(solver.result(), 'strouhal');
    }
    expect(st).toBeDefined();
    expect(st!).toBeGreaterThan(0.1);
    expect(st!).toBeLessThan(0.4);
    // 揚力が正負に振れている
    const lift = solver.result().history[1].values;
    expect(Math.max(...lift)).toBeGreaterThan(0);
    expect(Math.min(...lift)).toBeLessThan(0);
  }, 30000);

  it('履歴は最大約 2000 サンプルに収まる', () => {
    const p = cylinderProject(100, { nx: 60 });
    const solver = createFlowSolverWithOptions(p, rasterize(p));
    solver.advance(20000);
    const r = solver.result();
    expect(r.history[0].t.length).toBeLessThanOrEqual(2200);
    expect(r.history[0].t.length).toBeGreaterThanOrEqual(2000);
  });
});

describe('flow のプロ設定（advanced）', () => {
  it('自動のときは latticeU=0.08・Cs=0.1 を結果に報告する', () => {
    const p = cylinderProject(100);
    const r = createFlowSolver(p, rasterize(p)).result();
    expect(scalar(r, 'latticeU')).toBe(0.08);
    expect(scalar(r, 'smagorinskyCs')).toBe(0.1);
    expect(scalar(r, 'tau')!).toBeGreaterThan(0.5);
  });

  it('latticeU を指定するとそれを使い、τ もそれに合わせて変わる', () => {
    const p = cylinderProject(100);
    const auto = createFlowSolverWithOptions(p, rasterize(p));
    p.flow.advanced = { latticeU: 0.04 };
    const solver = createFlowSolverWithOptions(p, rasterize(p));
    expect(solver.uLat).toBe(0.04);
    expect(solver.tau).toBeLessThan(auto.tau);
    expect(scalar(solver.result(), 'latticeU')).toBe(0.04);
    expect(solver.result().warnings.some((w) => w.includes('丸めました'))).toBe(false);
  });

  it('latticeU が範囲外なら [0.01, 0.2] に丸めて警告する', () => {
    const p = cylinderProject(100);
    p.flow.advanced = { latticeU: 0.5 };
    const hi = createFlowSolverWithOptions(p, rasterize(p));
    expect(hi.uLat).toBe(0.2);
    expect(hi.result().warnings.some((w) => w.includes('丸めました'))).toBe(true);
    p.flow.advanced = { latticeU: 0.001 };
    const lo = createFlowSolverWithOptions(p, rasterize(p));
    expect(lo.uLat).toBe(0.01);
    expect(lo.result().warnings.some((w) => w.includes('丸めました'))).toBe(true);
  });

  it('Cs=0（LES 無効）でも低 Re なら安定して動く', () => {
    const p = cylinderProject(100);
    p.flow.advanced = { smagorinskyCs: 0 };
    const solver = createFlowSolverWithOptions(p, rasterize(p));
    solver.advance(800);
    const r = solver.result();
    expect(scalar(r, 'smagorinskyCs')).toBe(0);
    expect(scalar(r, 'drag')!).toBeGreaterThan(0);
    expect(Number.isFinite(scalar(r, 'drag')!)).toBe(true);
  });

  it('perturbation=0 では初期に縦方向の流れが生じない。opts が advanced より優先される', () => {
    const maxUy = (s: ReturnType<typeof createFlowSolverWithOptions>) =>
      Math.max(...Array.from(field(s.result(), 'uy').data, Math.abs));
    const p = cylinderProject(100);
    p.flow.advanced = { perturbation: 0 };
    const none = createFlowSolverWithOptions(p, rasterize(p));
    expect(maxUy(none)).toBeLessThan(1e-9);
    // advanced=0 でも opts=1 なら擾乱あり
    const forced = createFlowSolverWithOptions(p, rasterize(p), { perturbation: 1 });
    expect(maxUy(forced)).toBeGreaterThan(1e-9);
    // advanced=2 は標準の 2 倍
    p.flow.advanced = { perturbation: 2 };
    const strong = createFlowSolverWithOptions(p, rasterize(p));
    delete p.flow.advanced;
    const std = createFlowSolverWithOptions(p, rasterize(p));
    expect(maxUy(strong)).toBeGreaterThan(maxUy(std) * 1.9);
  });
});
