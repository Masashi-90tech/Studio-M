import { cellIndex3D } from '../core/grid3d';
import type { Mesh3D, Region3D, ResultSet3D, Solver3D, Study3D } from '../core/types';
import { boxMesh, cylinderMesh } from '../mesh3d/primitives';
import { uvSphere } from '../core/test-meshes';
import { createHeat3DSolver } from './heat3d';

/** 試験体から Study3D を作る（m 単位、周囲 20 °C、対流 10 W/(m²·K)） */
function makeStudy(opts: {
  mesh: Mesh3D;
  materialId?: string;
  regions?: Region3D[];
  cell?: number;
  maxCells?: number;
  ambientC?: number;
  surfaceH?: number;
  bodyHeatW?: number;
}): Study3D {
  return {
    version: 1,
    name: 'test',
    analysis: 'heat',
    mesh: opts.mesh,
    materialId: opts.materialId ?? 'al6061',
    regions: opts.regions ?? [],
    heat: { ambientC: opts.ambientC ?? 20, surfaceH: opts.surfaceH ?? 10, bodyHeatW: opts.bodyHeatW },
    stress: { selfWeight: false },
    grid: { cell: opts.cell, maxCells: opts.maxCells ?? 400_000 },
  };
}

/** 重心と単位法線が条件に合う三角形の番号 */
function trisWhere(mesh: Mesh3D, pred: (c: [number, number, number], n: [number, number, number]) => boolean): number[] {
  const p = mesh.positions;
  const idx = mesh.indices;
  const out: number[] = [];
  for (let t = 0; t < idx.length / 3; t++) {
    const v = [0, 1, 2].map((a) => [p[idx[3 * t + a] * 3], p[idx[3 * t + a] * 3 + 1], p[idx[3 * t + a] * 3 + 2]]);
    const c: [number, number, number] = [0, 1, 2].map((a) => (v[0][a] + v[1][a] + v[2][a]) / 3) as [number, number, number];
    const u = [0, 1, 2].map((a) => v[1][a] - v[0][a]);
    const w = [0, 1, 2].map((a) => v[2][a] - v[0][a]);
    const nn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(nn[0], nn[1], nn[2]) || 1;
    if (pred(c, [nn[0] / len, nn[1] / len, nn[2] / len])) out.push(t);
  }
  return out;
}

function solve(study: Study3D, limitMs = 20000): { solver: Solver3D; result: ResultSet3D; iterations: number; ms: number } {
  const t0 = performance.now();
  const solver = createHeat3DSolver(study);
  let status = solver.step(50);
  while (!status.done && performance.now() - t0 < limitMs) status = solver.step(50);
  expect(status.done).toBe(true);
  return { solver, result: solver.result(), iterations: status.iteration, ms: performance.now() - t0 };
}

const scalar = (r: ResultSet3D, key: string): number => r.scalars.find((s) => s.key === key)!.value;

/** 円柱ピンフィンの放熱量（先端が対流）[W]。m = √(hP/kA) */
function finHeat(opts: { k: number; h: number; r: number; L: number; theta0: number }): number {
  const { k, h, r, L, theta0 } = opts;
  const P = 2 * Math.PI * r;
  const A = Math.PI * r * r;
  const m = Math.sqrt((h * P) / (k * A));
  const g = h / (m * k);
  return Math.sqrt(h * P * k * A) * theta0 * ((Math.sinh(m * L) + g * Math.cosh(m * L)) / (Math.cosh(m * L) + g * Math.sinh(m * L)));
}

describe('3D 熱解析: 理論値との照合', () => {
  it('1 次元の棒: 片端を固定温度、もう片端に熱流束、側面は断熱 → 温度は線形に上がる', () => {
    const L = 0.125; // float32 で正確に表せる寸法にする（格子のセル数が 1 つずれないように）
    const w = 0.0078125;
    const mesh = boxMesh(L, w, w);
    const k = 167; // al6061
    const Q = 5;
    const regions: Region3D[] = [
      { id: 'fix', name: '固定', role: 'fixedTemp', faces: trisWhere(mesh, (c, n) => n[0] < -0.9 && c[0] < 1e-9), tempC: 40 },
      { id: 'flux', name: '入熱', role: 'heatFlux', faces: trisWhere(mesh, (c, n) => n[0] > 0.9 && c[0] > L - 1e-9), heatW: Q },
      { id: 'side', name: '側面', role: 'insulated', faces: trisWhere(mesh, (_c, n) => Math.abs(n[0]) < 0.1) },
    ];
    const { result } = solve(makeStudy({ mesh, regions, cell: w / 4 }));
    const g = result.grid;
    const f = result.fields[0];
    const dT = (Q * L) / (k * w * w);
    let checked = 0;
    for (let i = 0; i < g.nx; i++) {
      const c = cellIndex3D(g, i, Math.floor(g.ny / 2), Math.floor(g.nz / 2));
      if (!f.mask[c]) continue;
      const x = g.origin[0] + (i + 0.5) * g.h; // 固定温度の面（x = 0）からの距離
      const expected = 40 + (Q * x) / (k * w * w);
      expect(Math.abs(f.data[c] - expected)).toBeLessThan(0.02 * dT);
      checked++;
    }
    expect(checked).toBe(64);
    // 熱はすべて固定温度の面へ流れる
    expect(scalar(result, 'heatConv')).toBeCloseTo(0, 6);
    expect(scalar(result, 'heatFixed')).toBeGreaterThan(Q * 0.999);
    expect(scalar(result, 'heatFixed')).toBeLessThan(Q * 1.001);
    // 入熱面の最高温度は棒の先端の値に近い
    const flux = result.perRegion!.find((r) => r.shapeId === 'flux')!;
    const maxT = flux.values.find((v) => v.key === 'maxTemp')!.value;
    expect(Math.abs(maxT - (40 + dT))).toBeLessThan(0.02 * dT);
  });

  it('熱収支: 発熱の合計 = 対流で逃げる熱 + 固定温度の面へ流れる熱（1% 以内）', () => {
    const mesh = boxMesh(0.04, 0.03, 0.02);
    const regions: Region3D[] = [
      { id: 'fix', name: '底', role: 'fixedTemp', faces: trisWhere(mesh, (c, n) => n[2] < -0.9 && c[2] < 1e-9), tempC: 30 },
      { id: 'flux', name: '天板', role: 'heatFlux', faces: trisWhere(mesh, (c, n) => n[2] > 0.9 && c[2] > 0.02 - 1e-9), heatW: 3 },
      { id: 'fan', name: 'ファン', role: 'convection', faces: trisWhere(mesh, (_c, n) => n[0] > 0.9), h: 60 },
    ];
    const { result } = solve(makeStudy({ mesh, regions, cell: 0.002, bodyHeatW: 2, surfaceH: 12 }));
    const heat = scalar(result, 'totalHeat');
    expect(heat).toBeCloseTo(5, 6);
    const out = scalar(result, 'heatConv') + scalar(result, 'heatFixed');
    expect(Math.abs(out - heat)).toBeLessThan(0.01 * heat);
    expect(scalar(result, 'heatOut')).toBeCloseTo(out, 9);
    // 面の条件ごとの結果
    expect(result.perRegion!.map((r) => r.shapeId)).toEqual(['fix', 'flux', 'fan']);
  });

  it('銅の小さな立方体に Q [W]、全面対流 h: T ≈ Ta + Q/(h·A)', () => {
    const s = 0.02;
    const Q = 10;
    const h = 20;
    const { result } = solve(makeStudy({ mesh: boxMesh(s, s, s), materialId: 'c1100', bodyHeatW: Q, surfaceH: h, cell: 0.002 }));
    const expected = 20 + Q / (h * 6 * s * s);
    expect(Math.abs(scalar(result, 'avgTemp') - expected)).toBeLessThan(0.03 * (expected - 20));
    expect(Math.abs(scalar(result, 'maxTemp') - expected)).toBeLessThan(0.03 * (expected - 20));
    expect(scalar(result, 'heatConv')).toBeGreaterThan(Q * 0.99);
    expect(scalar(result, 'heatConv')).toBeLessThan(Q * 1.01);
  });

  it('球: 面積を補正すると、対流の面積が本当の表面積に数 % で一致し、温度が集中定数の式に合う', () => {
    const r = 0.02;
    const Q = 5;
    const h = 15;
    const mesh = uvSphere(r, 48, 96);
    const { result } = solve(makeStudy({ mesh, materialId: 'c1100', bodyHeatW: Q, surfaceH: h, cell: r / 8 }));
    const trueArea = scalar(result, 'meshArea');
    expect(Math.abs(trueArea / (4 * Math.PI * r * r) - 1)).toBeLessThan(0.01);
    expect(Math.abs(scalar(result, 'surfaceArea') / trueArea - 1)).toBeLessThan(0.03);
    const expected = 20 + Q / (h * trueArea);
    expect(Math.abs(scalar(result, 'avgTemp') - expected)).toBeLessThan(0.03 * (expected - 20));
    // 補正したことが注意に出る
    expect(result.warnings.some((m) => m.includes('階段状の表面積'))).toBe(true);
  });

  it('多角形で近似した円柱: 全面対流でも、側面（斜めの面）の面積が補正される', () => {
    const mesh = cylinderMesh(0.01, 0.03, 48);
    const { result } = solve(makeStudy({ mesh, materialId: 'c1100', bodyHeatW: 4, surfaceH: 25, cell: 0.001 }));
    const trueArea = scalar(result, 'meshArea');
    expect(Math.abs(scalar(result, 'surfaceArea') / trueArea - 1)).toBeLessThan(0.03);
    const expected = 20 + 4 / (25 * trueArea);
    expect(Math.abs(scalar(result, 'avgTemp') - expected)).toBeLessThan(0.03 * (expected - 20));
  });

  describe('円柱のピンフィン（根元を固定温度、側面と先端は対流）', () => {
    const r = 0.005;
    const L = 0.04;
    const h = 40;
    const k = 167;
    const fin = (cell: number): { Q: number; ms: number } => {
      const mesh = cylinderMesh(r, L, 48);
      const regions: Region3D[] = [{ id: 'root', name: '根元', role: 'fixedTemp', faces: trisWhere(mesh, (c, n) => n[2] < -0.9 && c[2] < 1e-9), tempC: 80 }];
      const { result, ms } = solve(makeStudy({ mesh, regions, cell, surfaceH: h }));
      return { Q: -scalar(result, 'heatFixed'), ms }; // 根元から部品へ入る熱（heatFixed は出ていく向きが正）
    };
    const exact = finHeat({ k, h, r, L, theta0: 60 });

    it('放熱量がフィンの式と 10% 以内で合う', () => {
      const { Q } = fin(0.001);
      expect(Math.abs(Q / exact - 1)).toBeLessThan(0.1);
    });

    it('格子を細かくすると答えが収束していく（粗い / 細かいの差が小さくなる）', () => {
      const q = [0.002, 0.001, 0.0005].map((c) => fin(c).Q);
      const d1 = Math.abs(q[0] - q[1]);
      const d2 = Math.abs(q[1] - q[2]);
      expect(d2).toBeLessThan(d1);
      // 最も細かいものが理論値に近い
      expect(Math.abs(q[2] / exact - 1)).toBeLessThan(0.05);
      expect(Math.abs(q[2] / exact - 1)).toBeLessThan(Math.abs(q[0] / exact - 1));
    });
  });

  it('放熱の経路がない（対流 0 かつ固定温度なし）ときは、解かずに日本語の注意を出す', () => {
    const { result, iterations } = solve(makeStudy({ mesh: boxMesh(0.02, 0.02, 0.02), bodyHeatW: 5, surfaceH: 0, cell: 0.002 }));
    expect(iterations).toBe(0);
    expect(result.warnings.some((m) => m.includes('放熱の経路がない'))).toBe(true);
    expect(Number.isFinite(scalar(result, 'maxTemp'))).toBe(true);
    expect(scalar(result, 'maxTemp')).toBe(20);
    expect(result.fields[0].mask.every((v) => v === 0)).toBe(true);
  });

  it('放熱経路のない部品が別にあっても、ほかの部品は解く（その部品は除外して注意する）', () => {
    const a = boxMesh(0.02, 0.02, 0.02);
    const b = boxMesh(0.02, 0.02, 0.02, [0.04, 0, 0]);
    const mesh: Mesh3D = {
      positions: Float32Array.from([...a.positions, ...b.positions]),
      indices: Uint32Array.from([...a.indices, ...Array.from(b.indices, (v) => v + a.positions.length / 3)]),
    };
    // b の面はすべて断熱、a は対流
    const regions: Region3D[] = [{ id: 'ins', name: '断熱', role: 'insulated', faces: trisWhere(mesh, (c) => c[0] > 0.035) }];
    const { result } = solve(makeStudy({ mesh, regions, bodyHeatW: 4, surfaceH: 20, cell: 0.002 }));
    expect(result.warnings.some((m) => m.includes('放熱経路'))).toBe(true);
    expect(Number.isFinite(scalar(result, 'maxTemp'))).toBe(true);
    // 解いた a の発熱は、体全体の発熱を a と b のセル数で分けた半分
    expect(scalar(result, 'heatConv')).toBeCloseTo(scalar(result, 'totalHeat'), 1);
  });

  it('結果の形: 温度の場・格子の注意・履歴', () => {
    const { result } = solve(makeStudy({ mesh: boxMesh(0.02, 0.02, 0.02), bodyHeatW: 1, cell: 0.002 }));
    const f = result.fields.find((x) => x.key === 'temp')!;
    const g = result.grid;
    expect(f.label).toBe('温度');
    expect(f.unit).toBe('°C');
    expect(f.data.length).toBe(g.nx * g.ny * g.nz);
    expect(f.mask.length).toBe(g.nx * g.ny * g.nz);
    expect(f.mask.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(result.warnings[0]).toContain('セルの一辺 2.00 mm');
    expect(result.history[0].values[0]).toBe(1);
    expect(result.history[0].values.at(-1)!).toBeLessThan(1e-6);
    for (const key of ['maxTemp', 'minTemp', 'avgTemp', 'totalHeat', 'heatOut']) expect(result.scalars.some((s) => s.key === key)).toBe(true);
  });
});
