// 形に沿ったメッシュ（gmsh）で解く CalculiX の強度解析の通し試験。
// ccx と gmsh が入っていて、STUDIO_M_ENGINE_TESTS=1 のとき（npm run test:engines）だけ動く。
// 検出と失敗の説明は、実機なしで動く試験が gmsh.test.ts（gmsh/）と、このファイルの最初の describe にある。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { rasterize } from '../../../src/core/raster';
import type { JobRequest } from '../../../src/core/engine-protocol';
import type { Project, ResultSet } from '../../../src/core/types';
import { createStressSolverDetailed } from '../../../src/solvers/stress';
import { GMSH_INSTALL_NOTE } from '../gmsh/mesh2d';
import { calculixAdapter } from './index';
import { BEAM, heywoodKt, HOLE_PLATE, holePlate, makeProject, petersonKt, rect, shape, steelBeam } from './test-projects';
import { createTestContext, hasCcx, hasGmsh, type TestContext } from './test-context';

const scalar = (r: ResultSet, key: string) => r.scalars.find((s) => s.key === key)?.value as number;
const field = (r: ResultSet, key: string) => r.fields.find((f) => f.key === key)!;
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

/** Lite の強度ソルバーで同じプロジェクトを解く（格子はプロジェクトの nx のまま） */
function lite(project: Project): ResultSet {
  const solver = createStressSolverDetailed(project, rasterize(project));
  for (let i = 0; i < 4000 && !solver.step(50).done; i++);
  return solver.result();
}

async function solve(project: Project, extra: Partial<JobRequest> = {}, mesher: 'gmsh' | 'grid' = 'gmsh') {
  const ctx = await createTestContext();
  try {
    const options = { ...(mesher === 'gmsh' ? { mesher: 'gmsh' } : {}), ...(extra.options ?? {}) };
    const out = await calculixAdapter.solve({ analysis: 'stress', engine: 'calculix', project, quality: 'draft', ...extra, options }, ctx);
    const names = await fs.readdir(ctx.workDir);
    const inp = await fs.readFile(path.join(ctx.workDir, 'job.inp'), 'utf8');
    return { out, result: out.result, names, inp, ctx };
  } finally {
    await ctx.cleanup();
  }
}

describe('gmsh が見つからないときの CalculiX（実機なし）', () => {
  it('オプション mesher = gmsh で gmsh が見つからなければ、入れ方と「格子に戻す」案内を書いた日本語のエラー', async () => {
    const ctx: TestContext = await createTestContext();
    // ctx.run を、gmsh は見つからない・それ以外は呼ばれない、に差し替える
    const calls: string[] = [];
    const run: TestContext['run'] = async (command) => {
      calls.push(command);
      throw Object.assign(new Error('「gmsh」が見つかりません。インストールするか、docs/ENGINE.md の手順で Docker を使ってください'), { reason: 'not-found' });
    };
    try {
      const req: JobRequest = { analysis: 'stress', engine: 'calculix', project: steelBeam({ P: 100 }), quality: 'draft', options: { mesher: 'gmsh' } };
      await expect(calculixAdapter.solve(req, { ...ctx, run })).rejects.toThrow(GMSH_INSTALL_NOTE);
      await expect(calculixAdapter.solve(req, { ...ctx, run })).rejects.toThrow('pip install gmsh');
      expect(calls.every((c) => c === 'gmsh')).toBe(true); // ccx は呼ばれない
    } finally {
      await ctx.cleanup();
    }
  });

  it('mesher を指定しない（または grid）なら、gmsh を一度も呼ばない', async () => {
    const ctx: TestContext = await createTestContext();
    const calls: string[] = [];
    const run: TestContext['run'] = async (command) => {
      calls.push(command);
      return { code: 1, stdout: '', stderr: ' *ERROR: test' };
    };
    try {
      const req: JobRequest = { analysis: 'stress', engine: 'calculix', project: steelBeam({ P: 100 }), quality: 'draft' };
      await expect(calculixAdapter.solve(req, { ...ctx, run })).rejects.toThrow('CalculiX が計算に失敗しました');
      await expect(calculixAdapter.solve({ ...req, options: { mesher: 'grid' } }, { ...ctx, run })).rejects.toThrow('CalculiX が計算に失敗しました');
      expect(calls).toEqual(['ccx', 'ccx']);
    } finally {
      await ctx.cleanup();
    }
  });

  it('宣言した能力: 強度のオプションに mesher（格子 / gmsh、既定は格子）がある', () => {
    const cap = calculixAdapter.capabilities.find((c) => c.analysis === 'stress')!;
    const mesher = cap.options!.find((o) => o.key === 'mesher')!;
    expect(mesher.kind).toBe('select');
    expect(mesher.default).toBe('grid');
    expect(mesher.choices!.map((c) => c.value)).toEqual(['grid', 'gmsh']);
  });
});

describe.skipIf(!(hasCcx && hasGmsh))('CalculiX + gmsh 通し試験', { timeout: 240_000 }, () => {
  it('中央に円孔のある帯板の引張: 最大応力 / 公称応力が Heywood の式と 10% 以内で、格子版より理論に近い', async () => {
    const { W, D, T } = HOLE_PLATE;
    const sigmaNom = 60e6; // 公称応力 60 MPa（正味断面。降伏より十分低い）
    const P = sigmaNom * (W - D) * T;
    const theory = heywoodKt(D / W);
    const project = holePlate({ P });

    const shaped = await solve(project);
    const grid = await solve(project, {}, 'grid');
    const ktShaped = scalar(shaped.result, 'maxVonMises') / sigmaNom;
    const ktGrid = scalar(grid.result, 'maxVonMises') / sigmaNom;
    console.log(
      `Kt 理論（Heywood）${theory.toFixed(3)} / Peterson ${petersonKt(D / W).toFixed(3)} / gmsh ${ktShaped.toFixed(3)}（${(rel(ktShaped, theory) * 100).toFixed(1)}%）/ 格子 ${ktGrid.toFixed(3)}（${(rel(ktGrid, theory) * 100).toFixed(1)}%）`,
    );
    expect(rel(ktShaped, theory)).toBeLessThan(0.1);
    expect(rel(ktShaped, theory)).toBeLessThan(rel(ktGrid, theory));
    expect(scalar(shaped.result, 'reaction')).toBeCloseTo(P, 3);

    // 結果は Lite と同じ格子・同じキー・同じ単位。穴の中のセルは mask = 0
    const liteResult = lite(project);
    expect(shaped.result).toMatchObject({ analysis: 'stress', nx: liteResult.nx, ny: liteResult.ny });
    for (const k of ['vonMises', 'displacement', 'sxx', 'syy', 'sxy', 'safety', 'ux', 'uy']) {
      expect(field(shaped.result, k).data.length).toBe(liteResult.nx * liteResult.ny);
      expect(field(shaped.result, k).unit).toBe(field(liteResult, k).unit);
      expect(field(shaped.result, k).mask).toBeDefined();
    }
    const mask = field(shaped.result, 'vonMises').mask!;
    const h = shaped.result.h;
    const cellAt = (x: number, y: number) => Math.floor(y / h) * shaped.result.nx + Math.floor(x / h);
    expect(mask[cellAt(0.15, 0.05)]).toBe(0); // 穴の中心
    expect(mask[cellAt(0.15, 0.02)]).toBe(1); // 穴の下
    // 穴の上の縁のすぐ外（x = 0.15, 縁から 1.4 mm）の σx は、総断面の応力 P / (w t) の 1.5 倍以上（Kirsch の式で約 1.7 倍）。
    // 孔から離れた断面では ≈ P / (w t)
    const gross = P / (W * T);
    const sxx = field(shaped.result, 'sxx').data;
    expect(sxx[cellAt(0.15, 0.05 + 0.01 + 0.0015)]).toBeGreaterThan(1.5 * gross);
    expect(rel(sxx[cellAt(0.07, 0.05)], gross)).toBeLessThan(0.1);

    // ログ・警告・ファイル
    expect(shaped.result.warnings[0]).toBe('CalculiX（2D 平面応力・CPS6）で解きました');
    expect(shaped.result.warnings.some((w) => w.includes('gmsh で形に沿ったメッシュ（要素数'))).toBe(true);
    expect(shaped.inp).toContain('TYPE=CPS6');
    expect(shaped.out.files.map((f) => f.name)).toEqual(['job.inp', 'job.frd', 'job.vtk', 'mesh.geo', 'mesh.msh']);
    expect(shaped.names).toEqual(expect.arrayContaining(['job.inp', 'job.frd', 'job.vtk', 'job.dat', 'mesh.geo', 'mesh.msh']));
    expect(shaped.ctx.progresses.map((p) => p.status)).toEqual(expect.arrayContaining(['meshing', 'running', 'reading']));
    expect(shaped.ctx.progresses[shaped.ctx.progresses.length - 1].fraction).toBe(1);
  });

  it('片持ち梁: 先端のたわみが、格子版と 5%、オイラー・ベルヌーイ梁と 10% 以内で一致する。反力は荷重と等しい', async () => {
    const P = 100;
    const project = steelBeam({ P });
    const shaped = await solve(project);
    const grid = await solve(project, {}, 'grid');
    const I = (BEAM.T * BEAM.H ** 3) / 12;
    const euler = (P * (0.995 - 0.01) ** 3) / (3 * BEAM.E * I); // 固定は x = 0.01 まで、荷重の重心は x ≈ 0.995
    const tip = scalar(shaped.result, 'maxDisplacement');
    console.log(`先端のたわみ オイラー ${(euler * 1e3).toFixed(4)} mm / gmsh ${(tip * 1e3).toFixed(4)} mm（${(rel(tip, euler) * 100).toFixed(1)}%）/ 格子 ${(scalar(grid.result, 'maxDisplacement') * 1e3).toFixed(4)} mm`);
    expect(rel(tip, euler)).toBeLessThan(0.1);
    expect(rel(tip, scalar(grid.result, 'maxDisplacement'))).toBeLessThan(0.05);
    expect(scalar(shaped.result, 'reaction')).toBeCloseTo(P, 3);
    expect(scalar(shaped.result, 'mass')).toBeCloseTo(7850 * 1.0 * BEAM.H * BEAM.T, 6);
    // 曲げ応力は固定端付近で最大: σ ≈ M c / I。上側は引張・下側は圧縮
    expect(scalar(shaped.result, 'maxVonMises')).toBeGreaterThan(0.5 * ((P * 0.98 * (BEAM.H / 2)) / I));
    const sxx = field(shaped.result, 'sxx').data;
    expect(sxx[9 * 100 + 5]).toBeGreaterThan(0);
    expect(sxx[5]).toBeLessThan(0);
    expect(field(shaped.result, 'uy').data[100 * 5 + 99]).toBeLessThan(0);
    expect(shaped.inp).toContain('TYPE=CPS6');
  });

  it('自重: 反力が重さ（質量 × g）と等しく、格子版とたわみが 5% 以内', async () => {
    const project = steelBeam({ P: 0, selfWeight: true });
    const shaped = await solve(project);
    const grid = await solve(project, {}, 'grid');
    expect(scalar(shaped.result, 'reaction')).toBeCloseTo(scalar(shaped.result, 'mass') * 9.80665, 2);
    expect(rel(scalar(shaped.result, 'maxDisplacement'), scalar(grid.result, 'maxDisplacement'))).toBeLessThan(0.05);
  });

  it('材料が 2 つ: 並列に引っ張ると、ひずみは同じで、応力は弾性率に比例する（材料の境目に節点が並ぶ）', async () => {
    // 下半分が鉄（E = 206 GPa）、上半分がアルミ（E = 68.9 GPa）の帯。左端を固定、右端を +x に引く
    const L = 0.3;
    const H = 0.1;
    const cell = L / 120;
    const P = 20000;
    // 荷重は弾性率に比例させて、鉄の半分とアルミの半分に別々にかける（まとめて一様にかけると、曲がってしまう）
    const Es = 206e9;
    const Ea = 68.9e9;
    const Ps = (P * Es) / (Es + Ea);
    const Pa = (P * Ea) / (Es + Ea);
    const project = makeProject({
      width: L,
      height: H,
      nx: 120,
      thickness: 0.01,
      shapes: [
        shape('solid', rect(0, 0, L, H / 2)),
        shape('solid', rect(0, H / 2, L, H / 2), { materialId: 'al6061' }),
        shape('support', rect(0, 0, cell, H)),
        shape('load', rect(L - cell, 0, cell, H / 2), { force: { fx: Ps, fy: 0 } }),
        shape('load', rect(L - cell, H / 2, cell, H / 2), { materialId: 'al6061', force: { fx: Pa, fy: 0 } }),
      ],
    });
    const { result, ctx, inp } = await solve(project);
    expect(inp.match(/^\*MATERIAL/gm)).toHaveLength(2);
    const nx = result.nx;
    const sxx = field(result, 'sxx').data;
    const mid = Math.floor(nx / 2);
    const steel = sxx[Math.floor(result.ny / 4) * nx + mid];
    const alu = sxx[Math.floor((3 * result.ny) / 4) * nx + mid];
    const strain = P / ((Es + Ea) * (H / 2) * 0.01);
    console.log(`2 材料の引張: 鉄 ${(steel / 1e6).toFixed(2)} MPa（理論 ${((Es * strain) / 1e6).toFixed(2)}）/ アルミ ${(alu / 1e6).toFixed(2)} MPa（理論 ${((Ea * strain) / 1e6).toFixed(2)}）`);
    expect(rel(steel, Es * strain)).toBeLessThan(0.05);
    expect(rel(alu, Ea * strain)).toBeLessThan(0.05);
    expect(scalar(result, 'reaction')).toBeCloseTo(P, 2);
    expect(ctx.logs.length).toBeGreaterThan(0);
  });

  it('多角形（L 字の金具）: 解けて、反力が荷重と等しく、物体の外のセルは mask = 0', async () => {
    const project = makeProject({
      width: 0.2,
      height: 0.2,
      nx: 100,
      thickness: 0.005,
      shapes: [
        shape('solid', { kind: 'polygon', points: [[0, 0], [0.2, 0], [0.2, 0.04], [0.04, 0.04], [0.04, 0.2], [0, 0.2]] }),
        shape('support', rect(0, 0.18, 0.04, 0.02)),
        shape('load', rect(0.18, 0, 0.02, 0.04), { force: { fx: 0, fy: -300 } }),
      ],
    });
    const { result } = await solve(project);
    expect(scalar(result, 'reaction')).toBeCloseTo(300, 2);
    const mask = field(result, 'vonMises').mask!;
    expect(mask[75 * 100 + 75]).toBe(0); // L 字の外（x = y = 0.15）
    expect(mask[10 * 100 + 10]).toBe(1);
    // 内側の角（0.04, 0.04）で応力が集中する: 角の近くの応力が、離れた腕の応力より大きい
    const vm = field(result, 'vonMises').data;
    expect(vm[19 * 100 + 19]).toBeGreaterThan(vm[10 * 100 + 90]);
  });

  it('塑性（gmsh のメッシュでも）: 穴の縁が降伏し、降伏した面積が出る', async () => {
    const { W, D, T } = HOLE_PLATE;
    const sigmaNom = 120e6; // 孔の縁は約 300 MPa になり、降伏応力（245 MPa）を超える
    const project = holePlate({ P: sigmaNom * (W - D) * T, nx: 60 }); // 時間を短くするため、粗めの格子（セル 5 mm）
    const { result, inp } = await solve(project, { options: { plasticity: true } });
    expect(inp).toContain('*PLASTIC');
    expect(inp).toContain('TYPE=CPS6');
    expect(scalar(result, 'yieldedArea')).toBeGreaterThan(0);
    expect(scalar(result, 'yieldedArea')).toBeLessThan(0.2);
    expect(scalar(result, 'maxPlasticStrain')).toBeGreaterThan(0);
    expect(scalar(result, 'yieldLoadFactor')).toBeGreaterThan(0.6);
    expect(scalar(result, 'yieldLoadFactor')).toBeLessThan(1);
  });

  it('支持がないときは、gmsh を走らせたあとでも日本語のエラー', async () => {
    const project = steelBeam({ P: 100 });
    project.shapes = project.shapes.filter((s) => s.role !== 'support');
    await expect(solve(project)).rejects.toThrow('支持');
  });
});
