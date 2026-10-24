import { defaultProject } from '../core/project';
import { rasterize } from '../core/raster';
import type { Project, ResultSet, Solver } from '../core/types';
import { createHeatSolver } from './heat';

/** 収束するまで回して結果を返す */
function solve(project: Project): { solver: Solver; result: ResultSet; iterations: number } {
  const solver = createHeatSolver(project, rasterize(project));
  let status = solver.step(50);
  const t0 = performance.now();
  while (!status.done && performance.now() - t0 < 8000) status = solver.step(50);
  expect(status.done).toBe(true);
  return { solver, result: solver.result(), iterations: status.iteration };
}

const scalar = (r: ResultSet, key: string) => r.scalars.find((s) => s.key === key)!.value;
const field = (r: ResultSet, key: string) => r.fields.find((f) => f.key === key)!;

/** 幅 1 m × 100 セルの細い棒（高さ 2 セル）を作る。両端のセル列は固定温度用に空けておく */
function rodProject(): Project {
  const p = defaultProject();
  p.domain = { width: 1, height: 0.1, nx: 100 }; // h = 0.01, ny = 10
  p.thickness = 0.01;
  p.shapes = [];
  p.heat.surfaceH = 0;
  p.heat.faceCooling = false;
  return p;
}

describe('熱解析: 棒の1次元熱伝導', () => {
  it('両端固定温度・断熱の棒で温度が直線分布になる', () => {
    const p = rodProject();
    p.shapes = [
      { id: 'rod', name: '棒', role: 'solid', materialId: 'al6061', geom: { kind: 'rect', x: 0, y: 0.04, w: 1, h: 0.02 } },
      { id: 'tl', name: '高温端', role: 'fixedTemp', materialId: '', tempC: 100, geom: { kind: 'rect', x: 0, y: 0.04, w: 0.01, h: 0.02 } },
      { id: 'tr', name: '低温端', role: 'fixedTemp', materialId: '', tempC: 20, geom: { kind: 'rect', x: 0.99, y: 0.04, w: 0.01, h: 0.02 } },
    ];
    const { result } = solve(p);
    const t = field(result, 'temperature').data;
    const nx = 100;
    // セル i=0 が 100°C、i=99 が 20°C のとき、セル中心間で直線
    for (const i of [10, 30, 50, 70, 90]) {
      const expected = 100 - (80 * i) / 99;
      expect(Math.abs(t[5 * nx + i] - expected) / 80).toBeLessThan(0.01);
    }
    expect(scalar(result, 'maxTemp')).toBeCloseTo(100, 3);
    expect(scalar(result, 'minTemp')).toBeCloseTo(20, 3);
    // 熱流束は解析解 k·ΔT/L（k = 167、セル中心間の距離 0.99 m）に一致する
    const q = field(result, 'heatFlux').data[5 * nx + 50];
    expect(Math.abs(q - (167 * 80) / 0.99) / ((167 * 80) / 0.99)).toBeLessThan(0.01);
  });

  it('材料の境目では熱伝導率の調和平均が使われる（直列熱抵抗と一致）', () => {
    const p = rodProject();
    // 左半分 アルミ(k=167)、右半分 PLA(k=0.13)
    p.shapes = [
      { id: 'a', name: 'アルミ', role: 'solid', materialId: 'al6061', geom: { kind: 'rect', x: 0, y: 0.04, w: 0.5, h: 0.02 } },
      { id: 'b', name: 'PLA', role: 'solid', materialId: 'pla', geom: { kind: 'rect', x: 0.5, y: 0.04, w: 0.5, h: 0.02 } },
      { id: 'tl', name: '高温端', role: 'fixedTemp', materialId: '', tempC: 100, geom: { kind: 'rect', x: 0, y: 0.04, w: 0.01, h: 0.02 } },
      { id: 'tr', name: '低温端', role: 'fixedTemp', materialId: '', tempC: 20, geom: { kind: 'rect', x: 0.99, y: 0.04, w: 0.01, h: 0.02 } },
    ];
    const { result } = solve(p);
    const t = field(result, 'temperature').data;
    const nx = 100;
    const kA = 167;
    const kB = 0.13;
    // セル 0..49 がアルミ、50..99 が PLA。リンク抵抗（A·h⁻¹ を省略）
    const rA = 1 / kA;
    const rB = 1 / kB;
    const rInterface = 1 / ((2 * kA * kB) / (kA + kB)); // 調和平均の1リンク
    const rTotal = 49 * rA + rInterface + 49 * rB;
    // セル 49（境界のアルミ側）と 50（PLA 側）の温度
    const t49 = 100 - (80 * 49 * rA) / rTotal;
    const t50 = 100 - (80 * (49 * rA + rInterface)) / rTotal;
    expect(Math.abs(t[5 * nx + 49] - t49)).toBeLessThan(0.8);
    expect(Math.abs(t[5 * nx + 50] - t50)).toBeLessThan(0.8);
    // ほとんどの温度降下は熱抵抗の大きい PLA 側で起きる
    expect(t[5 * nx + 49]).toBeGreaterThan(99);
    expect(t[5 * nx + 50]).toBeGreaterThan(99);
    expect(t[5 * nx + 60]).toBeLessThan(t[5 * nx + 50]);
  });
});

describe('熱解析: 発熱体と対流', () => {
  it('発熱量と放熱量が一致する（エネルギー保存）', () => {
    const p = defaultProject();
    p.domain = { width: 1, height: 0.5, nx: 100 };
    p.thickness = 0.01;
    p.shapes = [
      { id: 'plate', name: '板', role: 'solid', materialId: 'al6061', geom: { kind: 'rect', x: 0.2, y: 0.1, w: 0.6, h: 0.3 } },
      { id: 'chip', name: '発熱体', role: 'heatSource', materialId: 'al6061', heatW: 5, geom: { kind: 'rect', x: 0.45, y: 0.2, w: 0.1, h: 0.1 } },
    ];
    p.heat.surfaceH = 10;
    p.heat.faceCooling = true;
    const { result } = solve(p);
    const totalHeat = scalar(result, 'totalHeat');
    const heatOut = scalar(result, 'heatOut');
    expect(totalHeat).toBeCloseTo(5, 6);
    expect(Math.abs(heatOut - totalHeat) / totalHeat).toBeLessThan(0.01);
    // 発熱点が最高温度で、周囲より高い
    expect(scalar(result, 'maxTemp')).toBeGreaterThan(p.heat.ambientC);
    expect(scalar(result, 'minTemp')).toBeGreaterThanOrEqual(p.heat.ambientC);
    expect(scalar(result, 'avgTemp')).toBeLessThanOrEqual(scalar(result, 'maxTemp'));
    // 物体のないセルは周囲温度で埋められ、マスクは物体セルだけ
    const tf = field(result, 'temperature');
    expect(tf.data[0]).toBeCloseTo(25, 4);
    expect(tf.mask![0]).toBe(0);
    expect(tf.mask![25 * 100 + 50]).toBe(1);
    expect(result.history[0].values.length).toBeGreaterThan(1);
    expect(result.warnings).toEqual([]);
  });

  it('樹脂の板（低い熱伝導率）でも熱収支が合い、熱いほど高温になる', () => {
    const p = defaultProject();
    p.domain = { width: 0.4, height: 0.2, nx: 200 };
    p.thickness = 0.003;
    p.shapes = [
      { id: 'pcb', name: '基板', role: 'solid', materialId: 'fr4', geom: { kind: 'rect', x: 0.05, y: 0.05, w: 0.3, h: 0.1 } },
      { id: 'chip', name: 'チップ', role: 'heatSource', materialId: 'fr4', heatW: 1, geom: { kind: 'rect', x: 0.18, y: 0.08, w: 0.04, h: 0.04 } },
    ];
    p.heat.faceCooling = true;
    p.heat.surfaceH = 8;
    const { result } = solve(p);
    expect(Math.abs(scalar(result, 'heatOut') - 1)).toBeLessThan(0.01);
    expect(scalar(result, 'maxTemp')).toBeGreaterThan(scalar(result, 'avgTemp'));
  });

  it('辺の境界条件（対流・固定温度）から放熱できる', () => {
    const p = rodProject();
    p.shapes = [
      { id: 'rod', name: '棒', role: 'heatSource', materialId: 'al6061', heatW: 2, geom: { kind: 'rect', x: 0, y: 0.04, w: 1, h: 0.02 } },
    ];
    p.heat.edges.left = { type: 'temp', tempC: 30 };
    p.heat.edges.right = { type: 'convection', h: 50 };
    const { result } = solve(p);
    expect(Math.abs(scalar(result, 'heatOut') - 2) / 2).toBeLessThan(0.01);
    expect(scalar(result, 'maxTemp')).toBeGreaterThan(30);
  });
});

describe('熱解析: 特殊ケース', () => {
  it('物体がなければ警告つきで即座に完了する', () => {
    const p = defaultProject();
    p.shapes = [];
    const solver = createHeatSolver(p, rasterize(p));
    const status = solver.step(10);
    expect(status.done).toBe(true);
    expect(solver.result().warnings.length).toBeGreaterThan(0);
  });

  it('放熱経路のない発熱体は警告を出して破綻しない', () => {
    const p = defaultProject();
    p.shapes = [
      { id: 'chip', name: '発熱体', role: 'heatSource', materialId: 'al6061', heatW: 1, geom: { kind: 'rect', x: 0.5, y: 0.4, w: 0.2, h: 0.2 } },
    ];
    p.heat.surfaceH = 0;
    p.heat.faceCooling = false;
    const solver = createHeatSolver(p, rasterize(p));
    const status = solver.step(20);
    expect(status.done).toBe(true);
    const r = solver.result();
    expect(r.warnings.some((w) => w.includes('放熱経路'))).toBe(true);
    for (const s of r.scalars) expect(Number.isFinite(s.value)).toBe(true);
  });

  it('大きな格子（400×200）でも数秒以内に収束する', () => {
    const p = defaultProject();
    p.domain = { width: 2, height: 1, nx: 400 };
    p.thickness = 0.005;
    p.shapes = [
      { id: 'base', name: 'ベース', role: 'solid', materialId: 'al6061', geom: { kind: 'rect', x: 0.3, y: 0.3, w: 1.4, h: 0.1 } },
      { id: 'fin1', name: 'フィン1', role: 'solid', materialId: 'al6061', geom: { kind: 'rect', x: 0.4, y: 0.4, w: 0.05, h: 0.4 } },
      { id: 'fin2', name: 'フィン2', role: 'solid', materialId: 'al6061', geom: { kind: 'rect', x: 0.9, y: 0.4, w: 0.05, h: 0.4 } },
      { id: 'pla', name: '樹脂', role: 'solid', materialId: 'pla', geom: { kind: 'rect', x: 1.4, y: 0.4, w: 0.2, h: 0.3 } },
      { id: 'chip', name: '発熱体', role: 'heatSource', materialId: 'al6061', heatW: 10, geom: { kind: 'rect', x: 0.8, y: 0.3, w: 0.2, h: 0.1 } },
    ];
    p.heat.surfaceH = 20;
    const t0 = performance.now();
    const { result } = solve(p);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(Math.abs(scalar(result, 'heatOut') - 10) / 10).toBeLessThan(0.01);
  });
});

describe('熱解析: プロ設定（advanced）', () => {
  const rodWithEnds = (): Project => {
    const p = rodProject();
    p.shapes = [
      { id: 'rod', name: '棒', role: 'solid', materialId: 'al6061', geom: { kind: 'rect', x: 0, y: 0.04, w: 1, h: 0.02 } },
      { id: 'tl', name: '高温端', role: 'fixedTemp', materialId: '', tempC: 100, geom: { kind: 'rect', x: 0, y: 0.04, w: 0.01, h: 0.02 } },
      { id: 'tr', name: '低温端', role: 'fixedTemp', materialId: '', tempC: 20, geom: { kind: 'rect', x: 0.99, y: 0.04, w: 0.01, h: 0.02 } },
    ];
    return p;
  };

  it('自動のときは既定の収束判定と反復上限を結果に報告する', () => {
    const { result } = solve(rodWithEnds());
    expect(scalar(result, 'tolerance')).toBe(1e-7);
    expect(scalar(result, 'maxIterations')).toBe(20000);
  });

  it('tolerance を厳しくすると反復回数が増え、緩めると減る', () => {
    const loose = rodWithEnds();
    loose.heat.advanced = { tolerance: 1e-2 };
    const tight = rodWithEnds();
    tight.heat.advanced = { tolerance: 1e-12 };
    const a = solve(loose);
    const b = solve(rodWithEnds());
    const c = solve(tight);
    expect(a.iterations).toBeLessThan(b.iterations);
    expect(b.iterations).toBeLessThan(c.iterations);
    expect(scalar(c.result, 'tolerance')).toBe(1e-12);
  });

  it('maxIterations で打ち切ると警告が出る', () => {
    const p = rodWithEnds();
    p.heat.advanced = { tolerance: 1e-14, maxIterations: 3 };
    const { result, iterations } = solve(p);
    expect(iterations).toBe(3);
    expect(scalar(result, 'maxIterations')).toBe(3);
    expect(result.warnings.some((w) => w.includes('最大反復回数（3回）'))).toBe(true);
  });
});
