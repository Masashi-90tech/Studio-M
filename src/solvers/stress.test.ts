import { defaultProject } from '../core/project';
import { rasterize } from '../core/raster';
import type { Project, ResultSet, Shape } from '../core/types';
import { createStressSolver, createStressSolverDetailed } from './stress';

const rect = (x: number, y: number, w: number, h: number) => ({ kind: 'rect' as const, x, y, w, h });

function shape(role: Shape['role'], geom: Shape['geom'], extra: Partial<Shape> = {}): Shape {
  return { id: `${role}-${Math.random()}`, name: role, role, materialId: 'ss400', geom, ...extra };
}

function makeProject(width: number, height: number, nx: number, thickness: number, shapes: Shape[]): Project {
  const p = defaultProject();
  p.domain = { width, height, nx };
  p.thickness = thickness;
  p.shapes = shapes;
  p.stress = { selfWeight: false };
  return p;
}

/** 収束するまで回す */
function solve(project: Project) {
  const raster = rasterize(project);
  const solver = createStressSolverDetailed(project, raster);
  let status = solver.step(50);
  for (let guard = 0; !status.done && guard < 2000; guard++) status = solver.step(50);
  return { solver, status, raster, result: solver.result() };
}

const scalar = (r: ResultSet, key: string) => r.scalars.find((s) => s.key === key)?.value as number;
const field = (r: ResultSet, key: string) => r.fields.find((f) => f.key === key)!;

describe('stress solver', () => {
  // 細長い片持ち梁: L = 1 m, H = 0.1 m（L/H = 10, 高さ方向 10 セル）
  const L = 1.0;
  const H = 0.1;
  const T = 0.01;
  const P = 100; // [N]
  const E = 206e9; // SS400
  const beam = () =>
    makeProject(L, H, 100, T, [
      shape('solid', rect(0, 0, L, H)),
      shape('support', rect(0, 0, 0.01, H)), // 左端 1 セル列を固定
      shape('load', rect(0.99, 0, 0.01, H), { force: { fx: 0, fy: -P } }), // 右端 1 セル列に下向き荷重
    ]);

  it('片持ち梁の先端たわみがオイラー・ベルヌーイ梁と 10% 以内で一致し、反力が荷重と釣り合う', () => {
    const { solver, status, result } = solve(beam());
    expect(status.done).toBe(true);
    expect(status.residual).toBeLessThan(1e-8);

    // 先端（x = L）の節点 uy の平均
    const d = solver.displacements();
    let tip = 0;
    for (let j = 0; j <= 10; j++) tip += d.uy[j * d.nodesX + 100];
    tip = Math.abs(tip / 11);

    const I = (T * H ** 3) / 12;
    const Leff = 0.995; // 固定は x = 0.01 まで、荷重の重心は x ≈ 0.995
    const euler = (P * (Leff - 0.01) ** 3) / (3 * E * I);
    expect(Math.abs(tip - euler) / euler).toBeLessThan(0.1);

    expect(scalar(result, 'maxDisplacement')).toBeGreaterThanOrEqual(tip * 0.99);
    expect(scalar(result, 'reaction')).toBeCloseTo(P, 3);
    expect(scalar(result, 'mass')).toBeCloseTo(7850 * L * H * T, 6);
    // 曲げ応力は固定端付近で最大: σ ≈ M c / I
    expect(scalar(result, 'maxVonMises')).toBeGreaterThan(0.5 * ((P * 0.98 * (H / 2)) / I));
    expect(result.history[0].values.length).toBeGreaterThan(1);
    expect(result.warnings.some((w) => w.includes('2D平面応力'))).toBe(true);
  });

  it('結果のフィールドが仕様どおりのキー・マスクで返る', () => {
    const { result, raster } = solve(beam());
    const keys = result.fields.map((f) => f.key);
    for (const k of ['vonMises', 'displacement', 'sxx', 'syy', 'sxy', 'safety', 'ux', 'uy']) expect(keys).toContain(k);
    expect(field(result, 'sxx').diverging).toBe(true);
    for (const f of result.fields) {
      expect(f.data.length).toBe(raster.nx * raster.ny);
      expect(f.mask).toBeDefined();
    }
    // 下向き荷重 → 自由端側のセルは下向きに動く
    expect(field(result, 'uy').data[5 * 100 + 95]).toBeLessThan(0);
  });

  it('一様引張の棒では中央部の σx ≈ F / (H t)', () => {
    const len = 0.2;
    const hgt = 0.04;
    const t = 0.005;
    const F = 2000;
    const p = makeProject(len, hgt, 100, t, [
      shape('solid', rect(0, 0, len, hgt), { materialId: 'al6061' }),
      shape('support', rect(0, 0, 0.002, hgt)),
      shape('load', rect(len - 0.002, 0, 0.002, hgt), { force: { fx: F, fy: 0 } }),
    ]);
    const { result, raster } = solve(p);
    const expected = F / (hgt * t);
    const sxx = field(result, 'sxx').data;
    const syy = field(result, 'syy').data;
    // 中央付近（両端から十分離れた位置）の全高さ
    for (let j = 2; j < raster.ny - 2; j++) {
      const c = j * raster.nx + 50;
      expect(Math.abs(sxx[c] - expected) / expected).toBeLessThan(0.02);
      expect(Math.abs(syy[c])).toBeLessThan(0.05 * expected);
    }
    expect(scalar(result, 'reaction')).toBeCloseTo(F, 3);
    // 伸び = F L / (E A)（支持の 1 セル列を除く）
    expect(scalar(result, 'maxDisplacement')).toBeGreaterThan(0);
  });

  it('自重のみ: 反力 = 質量 × g', () => {
    const p = beam();
    p.shapes = p.shapes.filter((s) => s.role !== 'load');
    p.stress.selfWeight = true;
    const { result } = solve(p);
    expect(scalar(result, 'reaction')).toBeCloseTo(scalar(result, 'mass') * 9.80665, 3);
    expect(scalar(result, 'maxDisplacement')).toBeGreaterThan(0);
  });

  it('支持がない場合は警告を出し、ゼロの結果で完了する（落ちない）', () => {
    const p = beam();
    p.shapes = p.shapes.filter((s) => s.role !== 'support');
    const raster = rasterize(p);
    const solver = createStressSolver(p, raster);
    const status = solver.step(20);
    expect(status.done).toBe(true);
    const r = solver.result();
    expect(r.warnings.some((w) => w.includes('支持'))).toBe(true);
    expect(scalar(r, 'maxVonMises')).toBe(0);
    expect(scalar(r, 'maxDisplacement')).toBe(0);
    expect(field(r, 'vonMises').data.every((v) => v === 0)).toBe(true);
  });

  it('荷重も自重もない場合は自明な結果であることを警告する', () => {
    const p = beam();
    p.shapes = p.shapes.filter((s) => s.role !== 'load');
    const { status, result } = solve(p);
    expect(status.done).toBe(true);
    expect(result.warnings.some((w) => w.includes('荷重'))).toBe(true);
    expect(scalar(result, 'maxVonMises')).toBe(0);
  });

  it('支持されていない部品を警告し、除外しても収束する', () => {
    const p = beam();
    // 離れた場所に浮いた小片（荷重つき）
    p.domain = { width: L, height: 0.3, nx: 100 };
    p.shapes.push(shape('solid', rect(0.4, 0.2, 0.1, 0.05)));
    p.shapes.push(shape('load', rect(0.4, 0.2, 0.1, 0.05), { force: { fx: 0, fy: -50 } }));
    const { status, result, raster } = solve(p);
    expect(status.done).toBe(true);
    expect(status.residual).toBeLessThan(1e-8);
    expect(result.warnings.some((w) => w.includes('支持されていない部品があります'))).toBe(true);
    // 浮いた小片は結果に表示されない
    const floating = 22 * raster.nx + 45;
    expect(raster.solid[floating]).toBe(1);
    expect(field(result, 'vonMises').mask![floating]).toBe(0);
    // 反力は梁の荷重だけと釣り合う
    expect(scalar(result, 'reaction')).toBeCloseTo(P, 3);
  });

  it('降伏応力を超える荷重で警告が出る', () => {
    const p = beam();
    const load = p.shapes.find((s) => s.role === 'load')!;
    load.force = { fx: 0, fy: -1e5 };
    const { result } = solve(p);
    expect(scalar(result, 'minSafety')).toBeLessThan(1);
    expect(result.warnings.some((w) => w.includes('降伏応力を超えています'))).toBe(true);
  });

  it('200×100 セルの部品が数秒で解ける', () => {
    const p = makeProject(2.0, 1.0, 200, 0.01, [
      shape('solid', rect(0, 0, 2, 1), { materialId: 'al6061' }),
      shape('hole', { kind: 'circle', cx: 1.0, cy: 0.5, r: 0.2 }),
      shape('support', rect(0, 0, 0.02, 1)),
      shape('load', rect(1.98, 0.4, 0.02, 0.2), { force: { fx: 0, fy: -1000 } }),
    ]);
    const t0 = performance.now();
    const { status, result } = solve(p);
    const sec = (performance.now() - t0) / 1000;
    expect(status.done).toBe(true);
    expect(status.residual).toBeLessThan(1e-8);
    expect(scalar(result, 'reaction')).toBeCloseTo(1000, 2);
    expect(sec).toBeLessThan(10);
  }, 20000);
});

describe('stress solver: プロ設定（advanced）', () => {
  const beam = (adv?: { tolerance?: number; maxIterations?: number }) => {
    const p = makeProject(1.0, 0.1, 100, 0.01, [
      shape('solid', rect(0, 0, 1.0, 0.1)),
      shape('support', rect(0, 0, 0.01, 0.1)),
      shape('load', rect(0.99, 0, 0.01, 0.1), { force: { fx: 0, fy: -100 } }),
    ]);
    if (adv) p.stress.advanced = adv;
    return p;
  };

  it('自動のときは既定の収束判定と反復上限を結果に報告する', () => {
    const { result } = solve(beam());
    expect(scalar(result, 'tolerance')).toBe(1e-8);
    expect(scalar(result, 'maxIterations')).toBe(Math.max(2000, 20 * (100 + 10)));
  });

  it('tolerance を厳しくすると反復回数が増える', () => {
    const loose = solve(beam({ tolerance: 1e-3 }));
    const auto = solve(beam());
    const tight = solve(beam({ tolerance: 1e-11 }));
    expect(loose.status.iteration).toBeLessThan(auto.status.iteration);
    expect(auto.status.iteration).toBeLessThan(tight.status.iteration);
    expect(tight.status.residual!).toBeLessThan(1e-11);
  });

  it('maxIterations で打ち切ると警告が出る', () => {
    const { status, result } = solve(beam({ maxIterations: 5 }));
    expect(status.iteration).toBe(5);
    expect(scalar(result, 'maxIterations')).toBe(5);
    expect(result.warnings.some((w) => w.includes('反復の上限（5回）'))).toBe(true);
  });
});
