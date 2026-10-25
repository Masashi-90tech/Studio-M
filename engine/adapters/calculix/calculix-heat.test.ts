// CalculiX アダプターの熱解析の通し試験（ccx が入っていないときは飛ばす）。Lite の熱ソルバーと同じ条件で比べる。

import { rasterize } from '../../../src/core/raster';
import type { JobRequest } from '../../../src/core/engine-protocol';
import type { Project, ResultSet } from '../../../src/core/types';
import { createHeatSolver } from '../../../src/solvers/heat';
import { calculixAdapter } from './index';
import { createTestContext, hasCcx } from './test-context';
import { heatPlate, mm, rect, shape } from './test-projects';

const scalar = (r: ResultSet, key: string) => r.scalars.find((s) => s.key === key)?.value as number;
const field = (r: ResultSet, key: string) => r.fields.find((f) => f.key === key)!;
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

function lite(project: Project): ResultSet {
  const solver = createHeatSolver(project, rasterize(project));
  for (let i = 0; i < 6000 && !solver.step(50).done; i++);
  return solver.result();
}

async function runCcx(project: Project, extra: Partial<JobRequest> = {}) {
  const ctx = await createTestContext();
  try {
    const out = await calculixAdapter.solve({ analysis: 'heat', engine: 'calculix', project, quality: 'draft', ...extra }, ctx);
    return { out, result: out.result, ctx };
  } finally {
    await ctx.cleanup();
  }
}

describe('宣言した能力（熱）', () => {
  it('熱も CalculiX で解ける', () => {
    expect(calculixAdapter.capabilities.map((c) => c.analysis)).toEqual(['stress', 'heat']);
  });
});

describe.skipIf(!hasCcx)('CalculiX 通し試験（熱）', () => {
  it('アルミ板 + 5 W のチップ: Lite と最高温度が 1% 以内で一致し、発熱量 = 放熱量（熱収支）', async () => {
    const project = heatPlate({ material: 'al6061' });
    const { result, out } = await runCcx(project);
    const liteResult = lite(project);

    for (const key of ['maxTemp', 'minTemp', 'avgTemp']) {
      expect(rel(scalar(result, key), scalar(liteResult, key))).toBeLessThan(0.01);
    }
    expect(scalar(result, 'totalHeat')).toBeCloseTo(5, 6);
    expect(Math.abs(scalar(result, 'heatOut') - 5) / 5).toBeLessThan(0.005); // CalculiX 自身の熱収支
    expect(Math.abs(scalar(liteResult, 'heatOut') - 5) / 5).toBeLessThan(0.005);
    expect(scalar(result, 'maxTemp')).toBeGreaterThan(90); // 周囲 25 °C よりずっと高い

    // 熱流束の最大値も近い
    const peak = (r: ResultSet) => Math.max(...field(r, 'heatFlux').data);
    expect(rel(peak(result), peak(liteResult))).toBeLessThan(0.05);

    // 形・マスク・キーは Lite と同じ
    expect(result).toMatchObject({ analysis: 'heat', nx: 100, ny: 60 });
    expect(result.fields.map((f) => f.key)).toEqual(['temperature', 'heatFlux']);
    expect(field(result, 'temperature').unit).toBe('°C');
    const mask = field(result, 'temperature').mask!;
    expect(mask[30 * 100 + 50]).toBe(1);
    expect(mask[2 * 100 + 2]).toBe(0);
    expect(field(result, 'temperature').data[2 * 100 + 2]).toBeCloseTo(25, 6); // 板の外は周囲温度
    // チップの中央が最高温度
    const t = field(result, 'temperature').data;
    expect(t[30 * 100 + 50]).toBeGreaterThan(t[30 * 100 + 15]);

    // 部品ごとの結果（Lite と同じ形）
    expect(result.perShape?.[0]).toMatchObject({ label: 'チップ' });
    expect(result.perShape![0].values.find((v) => v.key === 'heatW')!.value).toBeCloseTo(5, 6);

    expect(result.warnings[0]).toBe('CalculiX（熱伝導・厚さ 1 要素の 3D の板 DC3D8）で解きました');
    expect(out.files.map((f) => f.name)).toEqual(['job.inp', 'job.frd', 'job.vtk']);
  });

  it('樹脂（PLA）の板: 温度が高く、膜の熱抵抗が効く場合も Lite と 2% 以内', async () => {
    const project = heatPlate({ material: 'pla' });
    const { result } = await runCcx(project);
    const liteResult = lite(project);
    expect(rel(scalar(result, 'maxTemp'), scalar(liteResult, 'maxTemp'))).toBeLessThan(0.02);
    expect(rel(scalar(result, 'avgTemp'), scalar(liteResult, 'avgTemp'))).toBeLessThan(0.02);
  });

  it('表裏の放熱を切ると温度が上がり、Lite と一致する（側面だけで放熱）', async () => {
    const withFace = await runCcx(heatPlate({ material: 'al6061' }));
    const project = heatPlate({ material: 'al6061', faceCooling: false });
    const { result } = await runCcx(project);
    expect(scalar(result, 'maxTemp')).toBeGreaterThan(scalar(withFace.result, 'maxTemp') + 10);
    expect(rel(scalar(result, 'maxTemp') - 25, scalar(lite(project), 'maxTemp') - 25)).toBeLessThan(0.02);
    expect(Math.abs(scalar(result, 'heatOut') - 5) / 5).toBeLessThan(0.005);
  });

  it('領域の辺の条件（固定温度・対流）と、固定温度の形（物体・空きセル）も Lite と一致する', async () => {
    const project = heatPlate({ material: 'al6061', fullDomain: true });
    project.heat.edges = { left: { type: 'temp', tempC: 25 }, right: { type: 'convection', h: 50 }, top: { type: 'adiabatic' }, bottom: { type: 'convection', h: 20 } };
    const a = await runCcx(project);
    expect(rel(scalar(a.result, 'maxTemp') - 25, scalar(lite(project), 'maxTemp') - 25)).toBeLessThan(0.02);
    expect(Math.abs(scalar(a.result, 'heatOut') - 5) / 5).toBeLessThan(0.005);

    const fixed = heatPlate({ material: 'al6061', fullDomain: true, surfaceH: 0, faceCooling: false });
    fixed.shapes.push(shape('fixedTemp', rect(0, 0, mm(5), mm(60)), { tempC: 40 } as never));
    fixed.shapes.push(shape('fixedTemp', rect(mm(90), mm(20), mm(10), mm(20)), { tempC: 15 } as never));
    const b = await runCcx(fixed);
    const liteB = lite(fixed);
    expect(scalar(b.result, 'maxTemp')).toBeCloseTo(40, 6);
    expect(scalar(b.result, 'minTemp')).toBeCloseTo(15, 6);
    expect(Math.abs(scalar(b.result, 'heatOut') - 5) / 5).toBeLessThan(0.005); // 5 W が固定温度の側へ出ていく
    expect(rel(scalar(b.result, 'avgTemp') - 15, scalar(liteB, 'avgTemp') - 15)).toBeLessThan(0.05);
  });

  it('基板の銅箔（実効熱伝導率）も効く', async () => {
    const project = heatPlate({ material: 'fr4', fullDomain: true });
    project.pcb = {
      source: 'テスト',
      boardThicknessMm: 1.6,
      substrateId: 'fr4',
      layers: [{ name: 'F.Cu', thicknessUm: 35, polygons: [[[mm(10), mm(10)], [mm(90), mm(10)], [mm(90), mm(50)], [mm(10), mm(50)]]] }],
    };
    const { result } = await runCcx(project);
    expect(rel(scalar(result, 'maxTemp') - 25, scalar(lite(project), 'maxTemp') - 25)).toBeLessThan(0.02);
    expect(result.warnings.some((w) => w.includes('実効熱伝導率'))).toBe(true);
  });

  it('quality: standard は格子が 1.5 倍になり、温度はほぼ変わらない', async () => {
    const project = heatPlate({ material: 'al6061' });
    const draft = await runCcx(project, { quality: 'draft' });
    const standard = await runCcx(project, { quality: 'standard' });
    expect(standard.result).toMatchObject({ nx: 150, ny: 90 });
    expect(rel(scalar(standard.result, 'maxTemp') - 25, scalar(draft.result, 'maxTemp') - 25)).toBeLessThan(0.03);
    expect(Math.abs(scalar(standard.result, 'heatOut') - 5) / 5).toBeLessThan(0.005);
  });

  it('放熱経路がないときは、日本語のエラー', async () => {
    const project = heatPlate({ material: 'al6061', surfaceH: 0 });
    await expect(runCcx(project)).rejects.toThrow('放熱経路');
  });

  it('物体がないときは、日本語のエラー', async () => {
    const project = heatPlate();
    project.shapes = [];
    await expect(runCcx(project)).rejects.toThrow('物体がない');
  });
});
