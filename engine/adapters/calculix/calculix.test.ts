// CalculiX アダプターの通し試験。ccx が入っていないときは、検出と失敗の説明のテストだけ動く。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { rasterize } from '../../../src/core/raster';
import type { JobRequest } from '../../../src/core/engine-protocol';
import type { Project, ResultSet } from '../../../src/core/types';
import { createStressSolverDetailed } from '../../../src/solvers/stress';
import { calculixAdapter, explainFailure } from './index';
import { aluminumBeamPreset, BEAM, makeProject, rect, shape, steelBeam } from './test-projects';
import { createDetectContext, createTestContext, hasCcx } from './test-context';

const scalar = (r: ResultSet, key: string) => r.scalars.find((s) => s.key === key)?.value as number;
const field = (r: ResultSet, key: string) => r.fields.find((f) => f.key === key)!;
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

/** Lite の強度ソルバーで同じプロジェクトを解く（格子はプロジェクトの nx のまま） */
function lite(project: Project): ResultSet {
  const solver = createStressSolverDetailed(project, rasterize(project));
  for (let i = 0; i < 4000 && !solver.step(50).done; i++);
  return solver.result();
}

async function runCcx(project: Project, extra: Partial<JobRequest> = {}) {
  const ctx = await createTestContext();
  const started = Date.now();
  try {
    const out = await calculixAdapter.solve({ analysis: 'stress', engine: 'calculix', project, quality: 'draft', ...extra }, ctx);
    const names = await fs.readdir(ctx.workDir);
    const inp = await fs.readFile(path.join(ctx.workDir, 'job.inp'), 'utf8');
    return { out, result: out.result, ctx, names, inp, seconds: (Date.now() - started) / 1000 };
  } finally {
    await ctx.cleanup();
  }
}

describe('detect', () => {
  it('ccx が見つからないときは、入れ方を案内する', async () => {
    const info = await calculixAdapter.detect({ dockerAvailable: false, probe: async () => ({ ok: false, output: '' }) });
    expect(info).toMatchObject({ id: 'calculix', available: false, via: 'none', license: 'GPL-2.0' });
    expect(info.note).toContain('sudo apt install calculix-ccx');
  });

  it('ccx -v の出力から版を読む（終了コードが 0 以外でも見つかったとする）', async () => {
    const info = await calculixAdapter.detect({
      dockerAvailable: false,
      probe: async (command, args) => {
        expect([command, args]).toEqual(['ccx', ['-v']]);
        return { ok: false, output: '\nThis is Version 2.21\n' };
      },
    });
    expect(info).toMatchObject({ available: true, version: '2.21', via: 'native', name: 'CalculiX' });
  });

  it('宣言した能力: 強度を CalculiX で。オプションは塑性・大変形・要素の種類を含む', () => {
    const cap = calculixAdapter.capabilities.find((c) => c.analysis === 'stress')!;
    expect(cap.engine).toBe('calculix');
    expect(cap.options!.map((o) => o.key)).toEqual(expect.arrayContaining(['plasticity', 'largeDeformation', 'elementType']));
    expect(cap.options!.find((o) => o.key === 'plasticity')!.default).toBe(false);
  });

  it.skipIf(!hasCcx)('入っている ccx を実際に見つける', async () => {
    const info = await calculixAdapter.detect(createDetectContext());
    expect(info.available).toBe(true);
    expect(info.version).toMatch(/^\d+\.\d+/);
  });
});

describe('explainFailure', () => {
  it('塑性の収束失敗は、崩れている旨と降伏荷重の目安を伝える', () => {
    const msg = explainFailure(' *ERROR: increment size smaller than minimum\n', { plasticity: true, largeDeformation: false, yieldLoadFactor: 0.67 });
    expect(msg).toContain('荷重が大きすぎて、材料が支えきれずに崩れています（降伏荷重を超えています）');
    expect(msg).toContain('0.67 倍');
  });

  it('弾性の収束失敗や、ほかの失敗にも日本語の理由を付ける', () => {
    expect(explainFailure('too many cutbacks', { plasticity: false, largeDeformation: true })).toContain('大きな変形');
    expect(explainFailure('numerical singularity', { plasticity: false, largeDeformation: false })).toContain('支持');
    expect(explainFailure(' *ERROR in readinput: unknown keyword\n', { plasticity: false, largeDeformation: false })).toContain('unknown keyword');
  });
});

describe.skipIf(!hasCcx)('CalculiX 通し試験（片持ち梁）', { timeout: 120_000 }, () => {
  const P = 100;

  it('先端のたわみがオイラー・ベルヌーイ梁と 10%、Lite と 5% 以内で一致し、反力が荷重と等しい', async () => {
    const project = steelBeam({ P });
    const { result, seconds, out, names, inp } = await runCcx(project);
    const liteResult = lite(project);

    const I = (BEAM.T * BEAM.H ** 3) / 12;
    const euler = (P * (0.995 - 0.01) ** 3) / (3 * BEAM.E * I); // 固定は x = 0.01 まで、荷重の重心は x ≈ 0.995
    const tip = scalar(result, 'maxDisplacement');
    expect(rel(tip, euler)).toBeLessThan(0.1);
    expect(rel(tip, scalar(liteResult, 'maxDisplacement'))).toBeLessThan(0.05);
    expect(rel(scalar(result, 'maxVonMises'), scalar(liteResult, 'maxVonMises'))).toBeLessThan(0.05);

    expect(scalar(result, 'reaction')).toBeCloseTo(P, 3);
    expect(scalar(result, 'mass')).toBeCloseTo(7850 * 1.0 * BEAM.H * BEAM.T, 6);
    expect(scalar(result, 'elementCount')).toBe(1000);
    // 曲げ応力は固定端付近で最大: σ ≈ M c / I
    expect(scalar(result, 'maxVonMises')).toBeGreaterThan(0.5 * ((P * 0.98 * (BEAM.H / 2)) / I));

    // Lite と同じキー・マスク・格子
    expect(result).toMatchObject({ analysis: 'stress', nx: 100, ny: 10 });
    for (const k of ['vonMises', 'displacement', 'sxx', 'syy', 'sxy', 'safety', 'ux', 'uy']) {
      expect(field(result, k).data.length).toBe(1000);
      expect(field(result, k).mask).toBeDefined();
      expect(field(result, k).unit).toBe(field(liteResult, k).unit);
    }
    // 梁の上側は引張、下側は圧縮（固定端付近の σx）
    const sxx = field(result, 'sxx').data;
    expect(sxx[9 * 100 + 5]).toBeGreaterThan(0);
    expect(sxx[0 * 100 + 5]).toBeLessThan(0);
    // 上下反転した 2 点は大きさがほぼ等しい
    expect(Math.abs(sxx[9 * 100 + 50] + sxx[50])).toBeLessThan(0.05 * Math.abs(sxx[9 * 100 + 50]));
    // たわみは下向き
    expect(field(result, 'uy').data[100 * 5 + 99]).toBeLessThan(0);

    expect(result.warnings[0]).toBe('CalculiX（2D 平面応力・CPS4）で解きました');
    expect(result.warnings.some((w) => w.includes('2D平面応力'))).toBe(true);
    expect(out.files).toEqual([
      { name: 'job.inp', description: 'CalculiX の入力' },
      { name: 'job.frd', description: 'CalculiX の結果（ParaView では ccx2paraview などで変換、CGX で直接開けます）' },
      { name: 'job.vtk', description: 'ParaView 用の結果' },
    ]);
    expect(names).toEqual(expect.arrayContaining(['job.inp', 'job.frd', 'job.vtk', 'job.dat']));
    expect(inp).toContain('TYPE=CPS4');
    expect(seconds).toBeLessThan(30); // 空いているマシンでは 1 秒未満
  });

  it('進み具合を知らせ、最後は 1', async () => {
    const { ctx } = await runCcx(steelBeam({ P }));
    const f = ctx.progresses.map((p) => p.fraction);
    expect(f.length).toBeGreaterThan(3);
    expect(f[f.length - 1]).toBe(1);
    expect(ctx.progresses.map((p) => p.status)).toEqual(expect.arrayContaining(['meshing', 'running', 'reading']));
  });

  it('「片持ち梁（アルミ）」プリセットと同じ形: 手計算 10%、Lite 5% 以内', async () => {
    const project = aluminumBeamPreset();
    const { result } = await runCcx(project);
    const liteResult = lite(project);
    const Leff = 0.198; // 固定は x = 31.3 mm まで、荷重の重心は x = 229.3 mm
    const I = (0.01 * 0.01 ** 3) / 12;
    const hand = (100 * Leff ** 3) / (3 * 68.9e9 * I);
    expect(rel(scalar(result, 'maxDisplacement'), hand)).toBeLessThan(0.1);
    expect(rel(scalar(result, 'maxDisplacement'), scalar(liteResult, 'maxDisplacement'))).toBeLessThan(0.05);
    expect(scalar(result, 'reaction')).toBeCloseTo(100, 3);
  });

  it('quality: standard は格子が 1.5 倍になり、たわみはほぼ変わらない', async () => {
    const project = steelBeam({ P });
    const draft = await runCcx(project, { quality: 'draft' });
    const standard = await runCcx(project, { quality: 'standard' });
    expect(standard.result).toMatchObject({ nx: 150, ny: 15 });
    expect(standard.result.h).toBeCloseTo(1 / 150, 12);
    expect(rel(scalar(standard.result, 'maxDisplacement'), scalar(draft.result, 'maxDisplacement'))).toBeLessThan(0.05);
    expect(standard.result.warnings.some((w) => w.includes('1.5 倍'))).toBe(true);
  });

  it('自重: Lite と反力・たわみが一致する', async () => {
    const project = steelBeam({ P: 0, selfWeight: true });
    const { result } = await runCcx(project);
    const liteResult = lite(project);
    // 反力は全荷重（自重）と釣り合う力（支持セルに直接かかる自重も数える。Lite と同じ数え方）
    expect(scalar(result, 'reaction')).toBeCloseTo(scalar(result, 'mass') * 9.80665, 2);
    expect(rel(scalar(result, 'reaction'), scalar(liteResult, 'reaction'))).toBeLessThan(0.01);
    expect(rel(scalar(result, 'maxDisplacement'), scalar(liteResult, 'maxDisplacement'))).toBeLessThan(0.05);
  });

  it('要素の種類 CPS8R / CPS4R も解け、Lite とたわみが 5% 以内', async () => {
    const project = steelBeam({ P });
    const liteTip = scalar(lite(project), 'maxDisplacement');
    for (const elementType of ['CPS8R', 'CPS4R']) {
      const { result, inp } = await runCcx(project, { options: { elementType } });
      expect(inp).toContain(`TYPE=${elementType}`);
      expect(result.warnings[0]).toContain(elementType);
      expect(rel(scalar(result, 'maxDisplacement'), liteTip)).toBeLessThan(0.05);
      expect(scalar(result, 'reaction')).toBeCloseTo(P, 3);
    }
  });

  it('大きな変形（NLGEOM）でも、小さなたわみなら線形とほぼ同じ', async () => {
    const project = steelBeam({ P });
    const linear = await runCcx(project);
    const nl = await runCcx(project, { options: { largeDeformation: true } });
    expect(rel(scalar(nl.result, 'maxDisplacement'), scalar(linear.result, 'maxDisplacement'))).toBeLessThan(0.01);
    expect(nl.result.warnings.some((w) => w.includes('大きな変形'))).toBe(true);
  });

  it('支持されていない部品は除外し、警告を出す（結果の mask も外れる）', async () => {
    const project = steelBeam({ P });
    // 梁から離れた小さな部品（梁の上に 1 行あけて置く）
    project.domain.height = 0.3;
    project.shapes.push(shape('solid', rect(0.4, 0.2, 0.1, 0.05)));
    const { result } = await runCcx(project);
    expect(result.warnings.some((w) => w.includes('支持されていない部品') && w.includes('除外'))).toBe(true);
    const mask = field(result, 'vonMises').mask!;
    const cell = Math.floor(0.225 / 0.01) * 100 + 45; // 離れた部品の中のセル
    expect(mask[cell]).toBe(0);
    expect(mask[5 * 100 + 50]).toBe(1);
    expect(scalar(result, 'elementCount')).toBe(1000);
  });

  it('荷重も自重もないときは、日本語のエラー', async () => {
    await expect(runCcx(steelBeam({ P: 0 }))).rejects.toThrow('荷重も自重もない');
  });

  it('支持がないときは、日本語のエラー', async () => {
    const project = makeProject({
      width: 1,
      height: 0.1,
      nx: 50,
      thickness: 0.01,
      shapes: [shape('solid', rect(0, 0, 1, 0.1)), shape('load', rect(0.9, 0, 0.1, 0.1), { force: { fx: 0, fy: -10 } })],
    });
    await expect(runCcx(project)).rejects.toThrow('支持');
  });

  it('対応していない解析は、日本語のエラー', async () => {
    const ctx = await createTestContext();
    try {
      await expect(calculixAdapter.solve({ analysis: 'flow', engine: 'calculix', project: steelBeam({ P }) }, ctx)).rejects.toThrow('対応していません');
    } finally {
      await ctx.cleanup();
    }
  });
});

describe.skipIf(!hasCcx)('CalculiX 通し試験（塑性）', { timeout: 120_000 }, () => {
  it('降伏する荷重では、降伏した面積と塑性ひずみが固定端付近の上下の縁に出る', async () => {
    const P = 5500; // 弾性の計算では降伏応力の約 1.2 倍になる荷重
    const project = steelBeam({ P });
    const { result, inp } = await runCcx(project, { options: { plasticity: true } });

    expect(inp).toContain('TYPE=CPS8R'); // おまかせ: 塑性は CPS8R
    expect(inp).toContain('*PLASTIC');
    expect(result.warnings[0]).toBe('CalculiX（2D 平面応力・CPS8R）で解きました');
    expect(scalar(result, 'reaction')).toBeCloseTo(P, 2);

    const yieldedArea = scalar(result, 'yieldedArea');
    expect(yieldedArea).toBeGreaterThan(0.02);
    expect(yieldedArea).toBeLessThan(0.2);
    expect(scalar(result, 'maxPlasticStrain')).toBeGreaterThan(1e-4);

    // 降伏した場所: 固定端の近く（x < 0.3 m）で、中立軸（y = 0.05）から遠い縁
    const peeq = field(result, 'plasticStrain');
    let count = 0;
    for (let c = 0; c < peeq.data.length; c++) {
      if (peeq.data[c] <= 1e-8) continue;
      count++;
      const i = c % 100;
      const j = Math.floor(c / 100);
      expect(i).toBeLessThan(30); // 梁理論では x < 0.25 L（モーメントが降伏モーメントを超える範囲）
      expect(Math.abs((j + 0.5) * 0.01 - 0.05)).toBeGreaterThan(0.02);
    }
    expect(count / 1000).toBeCloseTo(yieldedArea, 9);
    // 中立軸付近と先端側は弾性のまま
    expect(peeq.data[5 * 100 + 50]).toBe(0);
    expect(peeq.data[0 * 100 + 90]).toBe(0);

    // 降伏し始める荷重は、弾性の安全率から見積もった値（荷重が 0.85 倍あたり）
    const yieldFactor = scalar(result, 'yieldLoadFactor');
    expect(yieldFactor).toBeGreaterThan(0.75);
    expect(yieldFactor).toBeLessThan(0.95);
    expect(result.warnings.some((w) => w.includes('降伏した部分があります'))).toBe(true);
    expect(scalar(result, 'minSafety')).toBeGreaterThan(0.9); // 完全弾塑性: 応力は降伏応力を超えない
  });

  it('降伏しない荷重では降伏した面積は 0、降伏荷重の倍率が分かる', async () => {
    const { result } = await runCcx(steelBeam({ P: 100 }), { options: { plasticity: true, elementType: 'CPS4' } });
    expect(scalar(result, 'yieldedArea')).toBe(0);
    expect(scalar(result, 'maxPlasticStrain')).toBe(0);
    expect(scalar(result, 'yieldLoadFactor')).toBeGreaterThan(40);
    expect(result.warnings.some((w) => w.includes('降伏した部分はありません'))).toBe(true);
  });

  it('荷重の倍率を上げると、同じ形でも降伏する', async () => {
    const { result } = await runCcx(steelBeam({ P: 1000 }), { options: { plasticity: true, loadFactor: 5 } });
    expect(scalar(result, 'reaction')).toBeCloseTo(5000, 1);
    expect(scalar(result, 'yieldedArea')).toBeGreaterThan(0);
    expect(scalar(result, 'yieldLoadFactor')).toBeGreaterThan(4);
    expect(scalar(result, 'yieldLoadFactor')).toBeLessThan(5);
  });

  it('荷重が崩壊荷重を超えると、日本語で理由と直し方を返す', async () => {
    // 粗い格子（50 × 5）で速く。崩壊荷重はおよそ 6 kN なのに 20 kN をかける
    const project = steelBeam({ P: 20000, nx: 50 });
    await expect(runCcx(project, { options: { plasticity: true } })).rejects.toThrow('荷重が大きすぎて、材料が支えきれずに崩れています（降伏荷重を超えています）');
  });
});
