// OpenFOAM が入っている環境だけで走る結合テスト（入っていなければ読み飛ばす）。
// 遅いテスト（細かい格子）は STUDIO_M_SLOW=1 のときだけ走らせる。
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProject } from '../../../src/core/project';
import { rasterize } from '../../../src/core/raster';
import type { Project, ResultSet } from '../../../src/core/types';
import { createFlowSolverWithOptions } from '../../../src/solvers/flow';
import { nacaAirfoil } from '../../../src/ui/airfoil';
import { openfoamAdapter } from './index';
import { createDetectContext, createTestContext, hasOpenFoam } from './test-context';

const foam = hasOpenFoam();
const slow = process.env.STUDIO_M_SLOW === '1';
const scalar = (r: ResultSet, key: string): number | undefined => r.scalars.find((s) => s.key === key)?.value;

/** 円柱まわりの流れ（領域 1 m × 0.5 m、直径 = 12 セル）。Re を指定すると流速を逆算する */
function cylinder(re: number, opts: { nx?: number; walls?: 'slip' | 'noslip' } = {}): Project {
  const p = defaultProject();
  const nx = opts.nx ?? 120;
  const d = (12 * 1) / 120; // 直径は nx によらず 0.1 m
  p.domain = { width: 1, height: 0.5, nx, autoGrid: false };
  p.flow = { fluidId: 'air', inletVelocity: (re * 1.516e-5) / d, walls: opts.walls ?? 'slip' };
  // わずかに上へずらして左右対称を崩す（Lite のプリセットと同じ考え方）
  p.shapes = [{ id: 'c', name: '円柱', role: 'solid', materialId: 'al6061', geom: { kind: 'circle', cx: 0.25, cy: 0.2515, r: d / 2 } }];
  return p;
}

/** 同じプロジェクトを Lite（LBM）で、OpenFOAM と同じ物理時間だけ解く */
function runLite(project: Project, endTime: number): ResultSet {
  const solver = createFlowSolverWithOptions(project, rasterize(project));
  solver.advance(Math.ceil(endTime / solver.dt));
  return solver.result();
}

describe.skipIf(!foam)('OpenFOAM アダプター（結合テスト）', () => {
  it('detect: 版を読み取れる', async () => {
    const info = await openfoamAdapter.detect(createDetectContext(false));
    expect(info.available).toBe(true);
    expect(info.via).toBe('native');
    expect(info.version).toMatch(/^v\d{4}$/);
    expect(info.license).toBe('GPL-3.0');
  });

  it('円柱 Re = 100（層流）: 抗力が正、Cd が妥当、場が滑らか、Lite と近い [約 40 秒]', async () => {
    const project = cylinder(100);
    const { ctx, logs, progress } = await createTestContext();
    const t0 = Date.now();
    const out = await openfoamAdapter.solve({ analysis: 'flow', engine: 'openfoam', project, quality: 'draft', options: { model: 'auto', flowThroughs: 6 } }, ctx);
    const seconds = (Date.now() - t0) / 1000;
    const r = out.result;

    // 形: Lite と同じキー、格子は Lite と同じ 120 × 60
    expect([r.nx, r.ny]).toEqual([120, 60]);
    expect(r.fields.map((f) => f.key)).toEqual(['speed', 'ux', 'uy', 'pressure', 'vorticity']);
    expect(r.history.map((h) => h.key)).toEqual(['drag', 'lift']);
    for (const key of ['Re', 'drag', 'lift', 'Cd', 'Cl', 'time']) expect(scalar(r, key)).toBeDefined();
    expect(scalar(r, 'Re')).toBeCloseTo(100, 0);
    expect(r.warnings[0]).toBe('OpenFOAM（pimpleFoam、層流）で解きました（格子 120 × 60）。');

    // 物理: 抗力 > 0、Cd は閉塞率 20% の 2D 円柱として妥当
    expect(scalar(r, 'drag')!).toBeGreaterThan(0);
    const cd = scalar(r, 'CdMean')!;
    expect(cd).toBeGreaterThan(1.0);
    expect(cd).toBeLessThan(2.0);
    const st = scalar(r, 'strouhal');
    expect(st, '6 回の通り抜けで渦放出が検出されること').toBeDefined();
    expect(st!).toBeGreaterThan(0.15);
    expect(st!).toBeLessThan(0.3);

    // 場: 有限、マスクは物体を除いた全セル、物体のセルは対象外
    const raster = rasterize(project);
    const speed = r.fields[0];
    let fluid = 0;
    for (let c = 0; c < raster.solid.length; c++) {
      expect(speed.mask![c]).toBe(raster.solid[c] ? 0 : 1);
      if (!raster.solid[c]) {
        fluid++;
        for (const f of r.fields) expect(Number.isFinite(f.data[c])).toBe(true);
      }
    }
    expect(fluid).toBeGreaterThan(7000);

    // セルの対応が正しいこと: 隣り合う流体セルの速度が滑らか（対応が崩れると隣と無関係な値になる）
    const U = project.flow.inletVelocity;
    let sum = 0;
    let pairs = 0;
    for (let j = 0; j < r.ny; j++) {
      for (let i = 0; i < r.nx - 1; i++) {
        const a = j * r.nx + i;
        if (raster.solid[a] || raster.solid[a + 1]) continue;
        sum += Math.abs(speed.data[a] - speed.data[a + 1]);
        pairs++;
      }
    }
    expect(sum / pairs).toBeLessThan(0.03 * U);
    // 入口に近い上流の速度は流入速度のまま
    expect(speed.data[30 * r.nx + 2]).toBeGreaterThan(0.9 * U);
    expect(speed.data[30 * r.nx + 2]).toBeLessThan(1.1 * U);
    // 円柱の真正面（淀み点の手前）は減速して圧力が高い
    const front = 30 * r.nx + 22; // x = 0.19 m、円柱の前面は x = 0.2 m
    const pr = r.fields[3];
    expect(pr.data[front]).toBeGreaterThan(0);

    // 履歴: 時刻が増え、2000 点以下
    const lift = r.history[1];
    expect(lift.t.length).toBeGreaterThan(50);
    expect(lift.t.length).toBeLessThanOrEqual(2000);
    expect(lift.t[lift.t.length - 1]).toBeGreaterThan(lift.t[0]);

    // 進捗: 0.1〜0.9 のあいだで増え、状態が meshing → running → reading の順
    const statuses = progress.map((p) => p.status);
    expect(statuses.indexOf('meshing')).toBeLessThan(statuses.indexOf('running'));
    expect(statuses.indexOf('running')).toBeLessThan(statuses.indexOf('reading'));
    const running = progress.filter((p) => p.status === 'running');
    expect(running.length).toBeGreaterThan(20);
    for (let k = 1; k < running.length; k++) expect(running[k].fraction).toBeGreaterThanOrEqual(running[k - 1].fraction);
    expect(running[running.length - 1].message).toContain('pimpleFoam で計算中');
    expect(logs.join('\n')).toContain('subsetMesh が運んだ元の番号');

    // ファイル
    const names = out.files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['controlDict', 'log.pimpleFoam', 'forces.csv', 'result.vtu']));
    for (const f of out.files) expect(existsSync(join(ctx.workDir, f.name))).toBe(true);
    expect(out.files.find((f) => f.name === 'result.vtu')!.description).toContain('ParaView');
    expect((await readFile(join(ctx.workDir, 'forces.csv'), 'utf8')).split('\n')[0]).toBe('time,drag_N,lift_N');

    // Lite との比較（報告用に出力。ずれが大きすぎないことだけ確かめる）
    const lite = runLite(project, scalar(r, 'time')!);
    const liteCd = scalar(lite, 'Cd')!;
    console.log(
      `[円柱 Re=100] OpenFOAM: Cd(平均)=${cd.toFixed(3)} Cd(最後)=${scalar(r, 'Cd')!.toFixed(3)} St=${st!.toFixed(3)} ClRms=${scalar(r, 'ClRms')!.toFixed(3)} / ` +
        `Lite: Cd=${liteCd.toFixed(3)} St=${scalar(lite, 'strouhal')?.toFixed(3) ?? '未検出'} / OpenFOAM 計算 ${seconds.toFixed(1)} 秒`,
    );
    expect(liteCd).toBeGreaterThan(1.0);
    expect(liteCd).toBeLessThan(2.2);
    expect(Math.abs(cd - liteCd) / liteCd).toBeLessThan(0.4);
  }, 180_000);

  it('取り消し: 計算の途中で signal を中止すると AbortError で終わる', async () => {
    const { ctx, controller } = await createTestContext();
    const project = cylinder(100);
    const pending = openfoamAdapter.solve({ analysis: 'flow', engine: 'openfoam', project, options: { flowThroughs: 20 } }, ctx);
    setTimeout(() => controller.abort(), 4000);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  }, 60_000);

  it('上下が壁（noslip）+ LES でも最後まで解ける [短い計算]', async () => {
    const project = cylinder(2000, { nx: 80, walls: 'noslip' });
    const { ctx } = await createTestContext();
    const out = await openfoamAdapter.solve({ analysis: 'flow', engine: 'openfoam', project, options: { model: 'auto', flowThroughs: 0.6 } }, ctx);
    expect(out.result.warnings[0]).toContain('LES');
    expect(out.result.warnings.join()).toContain('定性的');
    const speed = out.result.fields[0];
    for (let c = 0; c < speed.data.length; c++) if (speed.mask![c]) expect(Number.isFinite(speed.data[c])).toBe(true);
    expect(scalar(out.result, 'drag')!).toBeGreaterThan(0);
  }, 120_000);

  it('NACA 0012・迎角 8°・高 Re の RANS（定常）: 揚力が正 [約 40 秒]', async () => {
    const p = defaultProject();
    p.domain = { width: 0.8, height: 0.4, nx: 200, autoGrid: false };
    p.thickness = 0.01;
    p.flow = { fluidId: 'air', inletVelocity: 5, walls: 'slip' };
    p.shapes = [{ id: 'a', name: 'NACA 0012', role: 'solid', materialId: 'abs', geom: { kind: 'polygon', points: nacaAirfoil('0012', 0.2, 8, 0.2, 0.215, 40) } }];
    const { ctx, progress } = await createTestContext();
    const t0 = Date.now();
    const out = await openfoamAdapter.solve({ analysis: 'flow', engine: 'openfoam', project: p, options: { model: 'rans', turbulenceIntensity: 1 } }, ctx);
    const r = out.result;
    const lift = scalar(r, 'lift')!;
    expect(lift).toBeGreaterThan(0);
    expect(scalar(r, 'Cl')!).toBeGreaterThan(0);
    expect(scalar(r, 'drag')!).toBeGreaterThan(0);
    expect(scalar(r, 'Cl')!).toBeGreaterThan(scalar(r, 'Cd')!); // 翼なので揚力の方が大きい
    expect(scalar(r, 'strouhal')).toBeUndefined();
    expect(r.warnings[0]).toBe('OpenFOAM（simpleFoam、RANS（k-ω SST））で解きました（格子 200 × 100）。');
    expect(progress.filter((q) => q.status === 'running').pop()!.message).toContain('simpleFoam で計算中（反復');
    // 翼の上面は吸い込み（圧力が低い）、下面は高い: 翼の上と下で圧力を比べる
    const raster = rasterize(p);
    const press = r.fields[3].data;
    let top = 0, bottom = 0, nt = 0, nb = 0;
    for (let i = 0; i < raster.nx; i++) {
      let jLo = -1, jHi = -1;
      for (let j = 0; j < raster.ny; j++) if (raster.solid[j * raster.nx + i]) { if (jLo < 0) jLo = j; jHi = j; }
      if (jLo < 2 || jHi > raster.ny - 3 || i < 52 || i > 85) continue; // 翼の中ほどの 33% 〜 後半を見る
      bottom += press[(jLo - 1) * raster.nx + i]; nb++;
      top += press[(jHi + 1) * raster.nx + i]; nt++;
    }
    expect(nt).toBeGreaterThan(10);
    expect(bottom / nb).toBeGreaterThan(top / nt);
    console.log(`[NACA0012 8° RANS] 揚力=${lift.toExponential(3)} N Cl(L基準)=${scalar(r, 'Cl')!.toFixed(3)} Cd(L基準)=${scalar(r, 'Cd')!.toFixed(3)} / ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  }, 180_000);

  it.skipIf(!slow)('[遅い] 円柱 Re = 100 を品質 standard で 10 回通り抜けるまで: St ≈ 0.16〜0.2 [数分]', async () => {
    const project = cylinder(100);
    const { ctx } = await createTestContext();
    const t0 = Date.now();
    const out = await openfoamAdapter.solve({ analysis: 'flow', engine: 'openfoam', project, quality: 'standard', options: { model: 'laminar', flowThroughs: 10 } }, ctx);
    const r = out.result;
    const st = scalar(r, 'strouhal')!;
    console.log(`[遅い・円柱 Re=100 standard] 格子 ${r.nx}×${r.ny} CdMean=${scalar(r, 'CdMean')!.toFixed(3)} St=${st?.toFixed(3)} ClRms=${scalar(r, 'ClRms')!.toFixed(3)} / ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    expect(st).toBeGreaterThan(0.15);
    expect(st).toBeLessThan(0.25);
    expect(scalar(r, 'CdMean')!).toBeGreaterThan(1.2);
    expect(scalar(r, 'CdMean')!).toBeLessThan(2.0);
  }, 900_000);

  it.skipIf(!slow)('[遅い] NACA 0012・8° の RANS を品質 standard で: 揚力係数が細かい格子で上がる [数分]', async () => {
    const p = defaultProject();
    p.domain = { width: 0.8, height: 0.4, nx: 200, autoGrid: false };
    p.thickness = 0.01;
    p.flow = { fluidId: 'air', inletVelocity: 5, walls: 'slip' };
    p.shapes = [{ id: 'a', name: 'NACA 0012', role: 'solid', materialId: 'abs', geom: { kind: 'polygon', points: nacaAirfoil('0012', 0.2, 8, 0.2, 0.215, 40) } }];
    const { ctx } = await createTestContext();
    const t0 = Date.now();
    const out = await openfoamAdapter.solve({ analysis: 'flow', engine: 'openfoam', project: p, quality: 'fine', options: { model: 'rans' } }, ctx);
    const lift = scalar(out.result, 'lift')!;
    const qc = 0.5 * 1.204 * 25 * 0.2 * 0.01; // 翼弦基準の動圧 × 面積
    console.log(`[遅い・NACA0012 8° RANS fine] 格子 ${out.result.nx}×${out.result.ny} 揚力=${lift.toExponential(3)} N Cl(翼弦基準)=${(lift / qc).toFixed(3)} / ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    expect(lift).toBeGreaterThan(0);
  }, 1_800_000);
});
