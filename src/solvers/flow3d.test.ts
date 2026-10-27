import { describe, expect, it } from 'vitest';
import { uvSphere } from '../core/test-meshes';
import type { FlowDirection3D, Mesh3D, ResultSet3D, Solver3D, Study3D } from '../core/types';
import { boxMesh } from '../mesh3d/primitives';
import { createFlow3DCore, createFlow3DSolver } from './flow3d';

const NU_AIR = 1.516e-5;

/** 試験体から Study3D を作る（空気。Re を指定すると流入速度を逆算する。D は部品の流れに垂直な大きさ） */
function makeStudy(opts: {
  mesh: Mesh3D;
  d: number;
  re: number;
  cellsPerD: number;
  direction?: FlowDirection3D;
  walls?: 'slip' | 'noslip';
  domain?: { upstream?: number; downstream?: number; side?: number };
  advanced?: { smagorinskyCs?: number; latticeU?: number };
  thermal?: boolean;
  velocity?: number;
}): Study3D {
  return {
    version: 1,
    name: 'test',
    analysis: 'flow',
    mesh: opts.mesh,
    materialId: 'al6061',
    regions: [],
    heat: { ambientC: 20, surfaceH: 10 },
    stress: { selfWeight: false },
    flow: {
      fluidId: 'air',
      direction: opts.direction ?? '+x',
      inletVelocity: opts.velocity ?? (opts.re * NU_AIR) / opts.d,
      walls: opts.walls ?? 'slip',
      domain: opts.domain,
      advanced: opts.advanced,
      thermal: opts.thermal ? { enabled: true } : undefined,
    },
    grid: { cell: opts.d / opts.cellsPerD, maxCells: 2_000_000 },
  };
}

const scalar = (r: ResultSet3D, key: string): number => {
  const s = r.scalars.find((x) => x.key === key);
  if (!s) throw new Error(`scalar ${key} がありません`);
  return s.value;
};
const field = (r: ResultSet3D, key: string) => r.fields.find((f) => f.key === key)!;

/** 指定のステップ数まで進める */
function run(solver: Solver3D, steps: number): void {
  let it = 0;
  while (it < steps) it = solver.step(100).iteration;
}

/** 履歴の後ろ半分の平均 */
function tailMean(r: ResultSet3D, key: string): number {
  const v = r.history.find((h) => h.key === key)!.values;
  const tail = v.slice(Math.floor(v.length / 2));
  return tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length);
}

describe('createFlow3DCore（格子と部品のセルを直接渡す）', () => {
  it('部品なしの一様流: 一様のまま変わらず、質量が保存される', () => {
    const nx = 24;
    const ny = 14;
    const nz = 12;
    const core = createFlow3DCore({
      grid: { nx, ny, nz, h: 0.01, origin: [0, 0, 0] },
      solid: new Uint8Array(nx * ny * nz),
      inletVelocity: 2,
      length: 0.12,
      viscosity: 1.5e-5,
      perturbation: 0,
    });
    const m0 = core.totalMass();
    core.advance(150);
    const r = core.result();
    const sp = field(r, 'speed');
    const ux = field(r, 'ux').data;
    const uy = field(r, 'uy').data;
    const uz = field(r, 'uz').data;
    let maxDev = 0;
    for (let c = 0; c < nx * ny * nz; c++) {
      maxDev = Math.max(maxDev, Math.abs(sp.data[c] - 2), Math.abs(uy[c]), Math.abs(uz[c]), Math.abs(ux[c] - 2));
    }
    expect(maxDev).toBeLessThan(2e-3);
    expect(Math.abs(core.totalMass() / m0 - 1)).toBeLessThan(1e-5);
    expect(core.instabilityCount).toBe(0);
    // 圧力は基準（0）のまま
    expect(Math.max(...field(r, 'pressure').data.map(Math.abs))).toBeLessThan(1e-2);
  });

  it('向き 6 通りで、部品のない一様流が向きどおりに流れる', () => {
    for (const direction of ['+x', '-x', '+y', '-y', '+z', '-z'] as FlowDirection3D[]) {
      const core = createFlow3DCore({
        grid: { nx: 12, ny: 12, nz: 12, h: 0.01, origin: [0, 0, 0] },
        solid: new Uint8Array(12 * 12 * 12),
        direction,
        inletVelocity: 1,
        length: 0.12,
        perturbation: 0,
      });
      core.advance(40);
      const r = core.result();
      const comp = direction[1] === 'x' ? 'ux' : direction[1] === 'y' ? 'uy' : 'uz';
      const c = (6 * 12 + 6) * 12 + 6;
      const sign = direction[0] === '+' ? 1 : -1;
      expect(field(r, comp).data[c]).toBeCloseTo(sign, 3);
      expect(field(r, 'speed').data[c]).toBeCloseTo(1, 3);
    }
  });

  it('流れの向きを変えても、軸を入れ替えた同じ配置と同じ結果になる（非対称な部品で 6 通り）', () => {
    // 流れが +x の基準の配置: 部品は L 字（どの軸にも対称でない）
    const nx = 28;
    const ny = 18;
    const nz = 14;
    const S = (i: number, j: number, k: number): boolean =>
      (i >= 8 && i < 14 && j >= 6 && j < 12 && k >= 5 && k < 10) || (i >= 14 && i < 18 && j >= 6 && j < 9 && k >= 5 && k < 7);
    // 向きごとの、基準の格子 (i, j, k) と新しい格子 (i', j', k') の対応（新しい格子の大きさと、基準のセルを返す関数）
    const maps: Record<FlowDirection3D, { dims: [number, number, number]; ref: (i: number, j: number, k: number) => [number, number, number] }> = {
      '+x': { dims: [nx, ny, nz], ref: (i, j, k) => [i, j, k] },
      '-x': { dims: [nx, ny, nz], ref: (i, j, k) => [nx - 1 - i, j, k] },
      '+y': { dims: [ny, nx, nz], ref: (i, j, k) => [j, i, k] },
      '-y': { dims: [ny, nx, nz], ref: (i, j, k) => [nx - 1 - j, i, k] },
      '+z': { dims: [nz, ny, nx], ref: (i, j, k) => [k, j, i] },
      '-z': { dims: [nz, ny, nx], ref: (i, j, k) => [nx - 1 - k, j, i] },
    };
    for (const walls of ['slip', 'noslip'] as const) {
      const results: Record<string, { drag: number; lifts: number[] }> = {};
      for (const direction of Object.keys(maps) as FlowDirection3D[]) {
        const { dims, ref } = maps[direction];
        const solid = new Uint8Array(dims[0] * dims[1] * dims[2]);
        for (let k = 0; k < dims[2]; k++)
          for (let j = 0; j < dims[1]; j++)
            for (let i = 0; i < dims[0]; i++) {
              const [a, b, c] = ref(i, j, k);
              if (S(a, b, c)) solid[(k * dims[1] + j) * dims[0] + i] = 1;
            }
        const core = createFlow3DCore({
          grid: { nx: dims[0], ny: dims[1], nz: dims[2], h: 0.01, origin: [0, 0, 0] },
          solid,
          direction,
          walls,
          inletVelocity: 1,
          viscosity: 3e-4,
          length: 0.06,
          perturbation: 0,
        });
        core.advance(200);
        const r = core.result();
        results[direction] = { drag: scalar(r, 'drag'), lifts: [scalar(r, 'liftA'), scalar(r, 'liftB')] };
        // 質量が保存されている（流入と流出がつり合う）
        expect(Math.abs(core.totalMass() / (dims[0] * dims[1] * dims[2] - solid.reduce((a, v) => a + v, 0)) - 1)).toBeLessThan(0.02);
      }
      const base = results['+x'];
      expect(base.drag).toBeGreaterThan(0);
      for (const direction of Object.keys(maps) as FlowDirection3D[]) {
        const got = results[direction];
        expect(got.drag / base.drag).toBeCloseTo(1, 4);
        // 揚力の A・B は、流れが z のとき基準の B・A に当たる
        const lifts = direction[1] === 'z' ? [got.lifts[1], got.lifts[0]] : got.lifts;
        expect(lifts[0] / base.lifts[0]).toBeCloseTo(1, 3);
        expect(lifts[1] / base.lifts[1]).toBeCloseTo(1, 3);
      }
    }
  });

  it('正方形ダクト（noslip の側面）の十分発達した流れ: 中心の速さ / 平均の速さ ≈ 2.096（解析解）', () => {
    // Re = 3·uLat·D / (τ − ½) で τ = 0.933（半格子バウンスバックが放物形をほぼ厳密に再現する値）、格子速度 0.03
    const w = 12;
    const nx = 48;
    const uLat = 0.03;
    const tau = 0.933;
    const h = 0.01;
    const d = w * h;
    const re = (3 * uLat * w) / (tau - 0.5);
    const core = createFlow3DCore({
      grid: { nx, ny: w, nz: w, h, origin: [0, 0, 0] },
      solid: new Uint8Array(nx * w * w),
      walls: 'noslip',
      inletVelocity: 1,
      viscosity: d / re,
      length: d,
      advanced: { smagorinskyCs: 0, latticeU: uLat },
    });
    expect(core.tau).toBeCloseTo(tau, 3);
    core.advance(2000);
    const ux = field(core.result(), 'ux').data;
    const i = Math.floor(nx * 0.55); // 入口から十分下流、流出のスポンジ層より手前
    const at = (j: number, k: number): number => ux[(k * w + j) * nx + i];
    let sum = 0;
    for (let k = 0; k < w; k++) for (let j = 0; j < w; j++) sum += at(j, k);
    const mean = sum / (w * w);
    const c = w / 2;
    const center = (at(c - 1, c - 1) + at(c, c) + at(c - 1, c) + at(c, c - 1)) / 4; // 中心をはさむ 4 セルの平均
    expect(mean).toBeGreaterThan(0.9);
    expect(mean).toBeLessThan(1.05);
    expect(Math.abs(center / mean / 2.096 - 1)).toBeLessThan(0.05);
  });

  it('発散を検出して、日本語の注意を出し、初期状態からやり直す', () => {
    const nx = 30;
    const ny = 20;
    const nz = 20;
    const solid = new Uint8Array(nx * ny * nz);
    for (let k = 8; k < 12; k++) for (let j = 8; j < 12; j++) for (let i = 8; i < 12; i++) solid[(k * ny + j) * nx + i] = 1;
    // 渦粘性なし・格子速度 0.2・Re が極端に高い: τ が下限になり BGK は保たない
    const core = createFlow3DCore({
      grid: { nx, ny, nz, h: 0.01, origin: [0, 0, 0] },
      solid,
      inletVelocity: 100,
      viscosity: 1e-9,
      length: 0.04,
      advanced: { smagorinskyCs: 0, latticeU: 0.2 },
    });
    for (let k = 0; k < 40 && core.instabilityCount === 0; k++) core.advance(25);
    expect(core.instabilityCount).toBeGreaterThan(0);
    const r = core.result();
    expect(r.warnings.some((w) => w.includes('不安定'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('Re'))).toBe(true);
    // やり直したあとは有限の値に戻っている
    expect(field(r, 'speed').data.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('createFlow3DSolver（Study3D から）', () => {
  it('結果の形が契約どおり（fields・scalars・history・mask）で、done は常に false', () => {
    const d = 0.08;
    const study = makeStudy({ mesh: boxMesh(d, d, d, [-d / 2, -d / 2, -d / 2]), d, re: 20, cellsPerD: 8, domain: { upstream: 1, downstream: 2, side: 1 } });
    const solver = createFlow3DSolver(study);
    const s1 = solver.step(30);
    const s2 = solver.step(30);
    expect(solver.analysis).toBe('flow');
    expect(s1.done).toBe(false);
    expect(s2.iteration).toBeGreaterThan(s1.iteration);
    expect(s2.progress).toBeGreaterThan(0);
    expect(s2.progress).toBeLessThanOrEqual(1);
    expect(s2.message).toContain('ステップ/秒');
    run(solver, 100);
    const r = solver.result();
    const n = r.grid.nx * r.grid.ny * r.grid.nz;
    expect(r.analysis).toBe('flow');
    expect(r.fields.map((f) => f.key)).toEqual(['speed', 'ux', 'uy', 'uz', 'pressure', 'vorticity']);
    expect(field(r, 'pressure').diverging).toBe(true);
    expect(field(r, 'speed').label).toBe('流速');
    expect(field(r, 'pressure').label).toBe('圧力');
    for (const f of r.fields) {
      expect(f.data.length).toBe(n);
      expect(f.mask.length).toBe(n);
      expect(f.data.every((v) => Number.isFinite(v))).toBe(true);
    }
    // mask = 流体のセル。部品のセルは 0 で、部品のセルの数は cellsInside と合う
    const mask = field(r, 'speed').mask;
    const solidCount = mask.reduce((a, v) => a + (v === 1 ? 0 : 1), 0);
    expect(solidCount).toBe(scalar(r, 'cellsInside'));
    expect(solidCount).toBeGreaterThan(100);
    for (const key of ['Re', 'drag', 'liftA', 'liftB', 'Cd', 'ClA', 'ClB', 'time', 'latticeU', 'tau', 'smagorinskyCs', 'steps', 'flowThroughs', 'refArea', 'length', 'cells']) {
      expect(Number.isFinite(scalar(r, key))).toBe(true);
    }
    // 立方体の流れに垂直な寸法 = D、基準面積 = D²（流れの向きへの投影面積）
    expect(scalar(r, 'length')).toBeCloseTo(d, 5);
    expect(scalar(r, 'refArea')).toBeCloseTo(d * d, 5);
    expect(scalar(r, 'Re')).toBeCloseTo(20, 1);
    expect(scalar(r, 'drag')).toBeGreaterThan(0);
    expect(r.history.map((h) => h.key)).toEqual(['drag', 'liftA', 'liftB']);
    expect(r.history[0].t.length).toBeGreaterThan(3);
    expect(Array.isArray(r.warnings)).toBe(true);
  });

  it('流れの向き 6 通りで、抗力が正（流れの向き）になり、揚力の軸の名前が label に出る', () => {
    const d = 0.06;
    for (const direction of ['+x', '-x', '+y', '-y', '+z', '-z'] as FlowDirection3D[]) {
      const study = makeStudy({ mesh: boxMesh(d, d, d, [-d / 2, -d / 2, -d / 2]), d, re: 20, cellsPerD: 5, direction, domain: { upstream: 1, downstream: 2, side: 1 } });
      const solver = createFlow3DSolver(study);
      run(solver, 150);
      const r = solver.result();
      expect(scalar(r, 'drag')).toBeGreaterThan(0);
      // 揚力の軸の名前が label に出る（流れが x なら A = y、B = z。y なら A = x、B = z。z なら A = x、B = y）
      const axes = direction[1] === 'x' ? ['y', 'z'] : direction[1] === 'y' ? ['x', 'z'] : ['x', 'y'];
      expect(r.scalars.find((s) => s.key === 'liftA')!.label).toContain(axes[0]);
      expect(r.scalars.find((s) => s.key === 'liftB')!.label).toContain(axes[1]);
    }
  });

  it('上下・左右に対称な部品（立方体・球）: 平均の揚力がほぼ 0', () => {
    const d = 0.08;
    const shapes: Mesh3D[] = [boxMesh(d, d, d, [-d / 2, -d / 2, -d / 2]), uvSphere(d / 2, 16, 32)];
    for (const mesh of shapes) {
      const study = makeStudy({ mesh, d, re: 30, cellsPerD: 8, domain: { upstream: 1, downstream: 3, side: 1 } });
      const solver = createFlow3DSolver(study);
      run(solver, 700);
      const r = solver.result();
      const drag = tailMean(r, 'drag');
      expect(drag).toBeGreaterThan(0);
      expect(Math.abs(tailMean(r, 'liftA')) / drag).toBeLessThan(0.02);
      expect(Math.abs(tailMean(r, 'liftB')) / drag).toBeLessThan(0.02);
    }
  });

  it('流入速度を 2 倍にすると抗力は 2〜4 倍の間（Re によって）', () => {
    const d = 0.08;
    const drag = (re: number): number => {
      const study = makeStudy({ mesh: uvSphere(d / 2, 16, 32), d, re, cellsPerD: 8, domain: { upstream: 1, downstream: 3, side: 1 } });
      const solver = createFlow3DSolver(study);
      run(solver, 700);
      return tailMean(solver.result(), 'drag');
    };
    const ratio = drag(40) / drag(20);
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(4);
  });

  it('球の抗力係数: Schiller–Naumann の式より少し大きく出て、格子を細かくすると近づく（Re = 40）', () => {
    // 経験式 Cd = 24/Re (1 + 0.15 Re^0.687)。階段状に近似した球・短い風洞・側面が対称（slip）の閉塞で、粗い格子では 4 割ほど大きく出る。
    // 実測の目安（D のセル数、側方の余白 1D、上流 1.5D、下流 3D）: 6 → 1.6 倍、8 → 1.4 倍。
    // 側方 1.5D、上流 2D、下流 4D にして D を 12 セルにすると 1.22 倍、16 セルで 1.20 倍（25% 以内。数分かかるのでここでは確かめない）。
    // 残りは側面の閉塞（側方を 1D → 1.5D にすると 1.41 → 1.29 倍）で、風洞を広げるほど式に近づく。
    // Smagorinsky の有無（Cs = 0 と 0.1）では 1% しか変わらない。
    const d = 0.08;
    const re = 40;
    const sn = (24 / re) * (1 + 0.15 * re ** 0.687);
    const cdRatio = (cellsPerD: number, steps: number): number => {
      const study = makeStudy({ mesh: uvSphere(d / 2, 16, 32), d, re, cellsPerD, domain: { upstream: 1.5, downstream: 3, side: 1 } });
      const solver = createFlow3DSolver(study);
      run(solver, steps);
      const r = solver.result();
      // 履歴の後半の平均の抗力から係数を出す（最後の数ステップだけだとゆらぐ）
      const cd = (tailMean(r, 'drag') * scalar(r, 'Cd')) / scalar(r, 'drag');
      return cd / sn;
    };
    const coarse = cdRatio(6, 800);
    const fine = cdRatio(8, 1000);
    expect(fine).toBeGreaterThan(0.9);
    expect(fine).toBeLessThan(1.6);
    expect(coarse).toBeGreaterThan(fine); // 細かくすると式に近づく方向
  });

  it('温度の設定が有効でも温度は解かず、注意を出す。部品がなければその旨も出す', () => {
    const d = 0.06;
    const solver = createFlow3DSolver(makeStudy({ mesh: boxMesh(d, d, d, [-d / 2, -d / 2, -d / 2]), d, re: 20, cellsPerD: 6, thermal: true, domain: { upstream: 1, downstream: 2, side: 1 } }));
    run(solver, 5);
    const r = solver.result();
    expect(r.warnings.some((w) => w.includes('温度の計算は次の段階'))).toBe(true);
    expect(r.fields.some((f) => f.key === 'temp')).toBe(false);
  });

  it('格子が粗いとき・Re が高いときの注意が出る', () => {
    const d = 0.06;
    const coarse = createFlow3DSolver(makeStudy({ mesh: uvSphere(d / 2, 12, 24), d, re: 20, cellsPerD: 5, domain: { upstream: 1, downstream: 2, side: 1 } }));
    run(coarse, 3);
    expect(coarse.result().warnings.some((w) => w.includes('代表長さ D') && w.includes('セル'))).toBe(true);

    const fast = createFlow3DSolver(makeStudy({ mesh: uvSphere(d / 2, 12, 24), d, re: 20000, cellsPerD: 8, domain: { upstream: 1, downstream: 2, side: 1 } }));
    run(fast, 3);
    const w = fast.result().warnings.join('\n');
    expect(w).toContain('乱流');
    expect(w).toContain('相当で計算');
  });

  it('流入速度 0 は流れのない状態で、大きさのわからない値にならない', () => {
    const d = 0.06;
    const solver = createFlow3DSolver(makeStudy({ mesh: uvSphere(d / 2, 12, 24), d, re: 20, cellsPerD: 6, velocity: 0, domain: { upstream: 1, downstream: 2, side: 1 } }));
    run(solver, 20);
    const r = solver.result();
    expect(r.warnings.some((w) => w.includes('流入速度が 0'))).toBe(true);
    expect(scalar(r, 'Cd')).toBe(0);
    expect(field(r, 'speed').data.every((v) => Number.isFinite(v) && v < 1e-3)).toBe(true);
  });
});
