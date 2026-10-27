import { describe, expect, it } from 'vitest';
import { flow3DDefaults, studyGrid } from '../core/grid3d';
import type { Study3D } from '../core/types';
import { buildStudy3D } from '../mesh3d/build3d';
import { analyzeMesh } from '../mesh3d/mesh';
import { boxMesh } from '../mesh3d/primitives';
import { Sim3DModel } from './model';
import { addRegion, studySignature } from './regions';
import {
  FLOW_QUALITY_OPTIONS,
  FLOW_SPEEDS,
  FLUID_OPTIONS,
  directionVector,
  flowGridInfo,
  flowOf,
  flowPartSize,
  flowQualityGrid,
  flowQualityIdFor,
  flowSpeedIndex,
  switchAnalysis,
  tunnelBox,
  withFlow,
} from './flow-settings';

const makeStudy = (): Study3D => buildStudy3D({ mesh: analyzeMesh(boxMesh(80, 50, 8)).mesh, fileName: 'plate.stl' });

describe('流れの設定の選択肢', () => {
  it('流体は空気と水。速さの選択肢は 2D のかんたんパネルと同じ 4 つ', () => {
    expect(FLUID_OPTIONS.map((o) => o.value)).toEqual(['air', 'water']);
    expect(FLOW_SPEEDS.map((s) => s.speed)).toEqual([1, 3, 6, 28]);
    expect(flowSpeedIndex(3)).toBe(1);
    expect(flowSpeedIndex(3.5)).toBe(-1);
  });

  it('計算の細かさは 8 万・25 万・60 万セル。省略時と 25 万は標準。近い方に寄せる', () => {
    expect(FLOW_QUALITY_OPTIONS.map((q) => q.maxCells)).toEqual([80_000, 250_000, 600_000]);
    expect(flowQualityIdFor(undefined)).toBe('normal');
    expect(flowQualityIdFor(250_000)).toBe('normal');
    expect(flowQualityIdFor(80_000)).toBe('coarse');
    expect(flowQualityIdFor(1_000_000)).toBe('fine');
    expect(flowQualityGrid('coarse')).toEqual({ maxCells: 80_000 });
  });

  it('風の向き → 単位ベクトル', () => {
    expect(directionVector('+x')).toEqual([1, 0, 0]);
    expect(directionVector('-y')).toEqual([0, -1, 0]);
    expect(directionVector('-z')).toEqual([0, 0, -1]);
  });
});

describe('Study3D の切り替えと流れの設定', () => {
  it('流れに切り替えると既定の流れの設定が入り、熱の条件・設定はそのまま残る。戻せる', () => {
    let s = makeStudy();
    s = addRegion(s, { role: 'heatFlux', faces: [0, 1], value: 7 }).study;
    const flow = switchAnalysis(s, 'flow');
    expect(flow.analysis).toBe('flow');
    expect(flow.flow).toEqual(flow3DDefaults());
    expect(flow.regions).toBe(s.regions);
    expect(flow.heat).toBe(s.heat);
    expect(flow.mesh).toBe(s.mesh);
    const back = switchAnalysis(flow, 'heat');
    expect(back.analysis).toBe('heat');
    expect(back.regions[0].heatW).toBe(7);
    expect(back.flow).toEqual(flow3DDefaults()); // 流れの設定も消さない
    expect(switchAnalysis(s, 'heat')).toBe(s);
  });

  it('withFlow は一部だけ変える。省略された項目は既定で補う', () => {
    const s = makeStudy();
    expect(flowOf(s)).toEqual(flow3DDefaults());
    const t = withFlow(s, { direction: '-z', inletVelocity: 3 });
    expect(t.flow).toMatchObject({ direction: '-z', inletVelocity: 3, fluidId: 'air', walls: 'slip' });
    expect(s.flow).toBeUndefined();
  });
});

describe('風洞と格子の目安', () => {
  it('部品の幅 D は流れに垂直な 2 方向の大きい方。流れの向きの長さも返す', () => {
    const b = { min: [0, 0, 0] as [number, number, number], max: [0.08, 0.05, 0.008] as [number, number, number] };
    expect(flowPartSize(b, '+x')).toEqual({ d: 0.05, length: 0.08 });
    expect(flowPartSize(b, '-z').d).toBe(0.08);
    expect(flowPartSize(b, '+y').length).toBe(0.05);
  });

  it('風洞の範囲は、上流 1.5D・下流 4D・側方 1.5D 広がる。向きを変えると変わる', () => {
    const s = switchAnalysis(makeStudy(), 'flow');
    const t = tunnelBox(s)!;
    const d = 0.05;
    expect(t.max[0] - t.min[0]).toBeCloseTo(0.08 + 5.5 * d, 5);
    expect(t.max[1] - t.min[1]).toBeCloseTo(0.05 + 3 * d, 5);
    const z = tunnelBox(withFlow(s, { direction: '+z' }))!;
    expect(z.max[2] - z.min[2]).toBeCloseTo(0.008 + 5.5 * 0.08, 5);
  });

  it('格子の目安は、ソルバーが使う格子（studyGrid）と同じ。セル数は上限以内で、D が何セルかも出る', () => {
    const s = switchAnalysis(makeStudy(), 'flow', flowQualityGrid('normal'));
    const info = flowGridInfo(s)!;
    expect(info.grid).toEqual(studyGrid(s));
    expect(info.cells).toBe(info.grid.nx * info.grid.ny * info.grid.nz);
    expect(info.cells).toBeLessThanOrEqual(250_000);
    expect(info.cells).toBeGreaterThan(100_000);
    expect(info.cellMm).toBeCloseTo(info.grid.h * 1e3, 9);
    expect(info.dCells).toBeCloseTo(0.05 / info.grid.h, 6);
    const coarse = flowGridInfo(switchAnalysis(makeStudy(), 'flow', flowQualityGrid('coarse')))!;
    expect(coarse.cells).toBeLessThanOrEqual(80_000);
    expect(coarse.dCells).toBeLessThan(info.dCells);
    const fine = flowGridInfo(switchAnalysis(makeStudy(), 'flow', flowQualityGrid('fine')))!;
    expect(fine.dCells).toBeGreaterThan(info.dCells);
  });
});

describe('Sim3DModel の解析の切り替え', () => {
  it('熱 → 流れ → 熱: 面の条件は残り、計算の細かさは解析ごとに別。選択は流れで外れる', () => {
    const m = new Sim3DModel(makeStudy());
    m.setQuality('fine');
    m.setSelection(new Set([0, 1]));
    m.addRegionFromSelection('heatFlux', 5);
    m.setSelection(new Set([4]));
    const events: string[] = [];
    m.subscribe((e) => events.push(e));
    m.setAnalysis('flow');
    expect(events).toContain('analysis');
    expect(m.study.analysis).toBe('flow');
    expect(m.study.regions).toHaveLength(1);
    expect(m.selection.size).toBe(0);
    expect(m.study.grid).toBeUndefined(); // 流れは標準から（熱の「細かい」を引きずらない）
    m.setFlowQuality('coarse');
    expect(m.study.grid).toEqual({ maxCells: 80_000 });
    m.setAnalysis('heat');
    expect(m.study.analysis).toBe('heat');
    expect(m.study.grid?.maxCells).toBe(1_000_000);
    expect(m.study.regions[0].heatW).toBe(5);
    m.setAnalysis('flow');
    expect(m.study.grid).toEqual({ maxCells: 80_000 });
  });

  it('結果は解析ごとに残る。熱の設定を変えても、流れの結果は古くならない（逆も同じ）', () => {
    const m = new Sim3DModel(makeStudy());
    const heat = { analysis: 'heat' as const, grid: { nx: 1, ny: 1, nz: 1, h: 1, origin: [0, 0, 0] as [number, number, number] }, fields: [], scalars: [], history: [], warnings: [] };
    m.setResult(heat, m.signature);
    m.setAnalysis('flow');
    expect(m.result).toBeNull();
    m.setResult({ ...heat, analysis: 'flow' }, m.signature, m.study.flow);
    expect(m.result?.data.analysis).toBe('flow');
    expect(m.stale).toBe(false);
    m.setAnalysis('heat');
    expect(m.result?.data.analysis).toBe('heat');
    m.setAmbient(40);
    expect(m.stale).toBe(true);
    m.setAnalysis('flow');
    expect(m.stale).toBe(false); // 熱の周囲温度は、流れの結果に関係ない
    m.setFlow({ inletVelocity: 3 });
    expect(m.stale).toBe(true);
    m.setFlow({ inletVelocity: 1 });
    expect(m.stale).toBe(false);
  });

  it('流れの印は、向き・流体・まわり・細かさで変わり、名前では変わらない。熱の印とは別', () => {
    const s = switchAnalysis(makeStudy(), 'flow');
    const base = studySignature(s);
    expect(studySignature({ ...s, name: '別' })).toBe(base);
    expect(studySignature(withFlow(s, { direction: '+y' }))).not.toBe(base);
    expect(studySignature(withFlow(s, { fluidId: 'water' }))).not.toBe(base);
    expect(studySignature(withFlow(s, { walls: 'noslip' }))).not.toBe(base);
    expect(studySignature({ ...s, grid: flowQualityGrid('fine') })).not.toBe(base);
    expect(studySignature({ ...s, heat: { ...s.heat, ambientC: 99 } })).toBe(base);
    expect(studySignature(switchAnalysis(s, 'heat'))).not.toBe(base);
  });

  it('断面を切れる範囲は、熱は部品、流れは風洞。切り替えたあとも位置は範囲内に収まる', () => {
    const m = new Sim3DModel(makeStudy());
    const part = m.sectionBounds!;
    expect(part.max[0] - part.min[0]).toBeCloseTo(0.08, 5);
    m.setSection({ on: true, axis: 0 });
    m.setAnalysis('flow');
    const tunnel = m.sectionBounds!;
    expect(tunnel.max[0] - tunnel.min[0]).toBeGreaterThan(0.3);
    m.setSection({ position: tunnel.max[0] + 10 });
    expect(m.section.position).toBeCloseTo(tunnel.max[0], 9);
    m.setFlow({ direction: '+z' }); // 風洞が変わる（向きの違う軸が長くなる）
    const t2 = m.sectionBounds!;
    expect(m.section.position).toBeLessThanOrEqual(t2.max[0]);
    expect(m.section.position).toBeGreaterThanOrEqual(t2.min[0]);
    m.setAnalysis('heat');
    expect(m.section.position).toBeLessThanOrEqual(m.sectionBounds!.max[0]);
  });
});
