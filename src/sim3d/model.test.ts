import { describe, expect, it } from 'vitest';
import type { ResultSet3D, Study3D } from '../core/types';
import { buildStudy3D } from '../mesh3d/build3d';
import { analyzeMesh } from '../mesh3d/mesh';
import { boxMesh } from '../mesh3d/primitives';
import { Sim3DModel, type ModelEvent } from './model';
import { addRegion, faceOwners, nextRegionName, regionValueText, removeRegion, studySignature, updateRegion } from './regions';
import { COOLING_OPTIONS, QUALITY_OPTIONS, coolingIdFor, previewGrid, qualityGrid, qualityIdFor } from './settings';

const makeStudy = (): Study3D => buildStudy3D({ mesh: analyzeMesh(boxMesh(80, 50, 8)).mesh, fileName: 'plate.stl' });
const fakeResult = (): ResultSet3D => ({ analysis: 'heat', grid: { nx: 1, ny: 1, nz: 1, h: 1, origin: [0, 0, 0] }, fields: [], scalars: [], history: [], warnings: [] });

describe('面の条件の追加・削除・編集', () => {
  it('発熱は既定 5 W、温度固定は周囲の温度、ファンは h = 40、断熱は値なし。名前は種類ごとに連番', () => {
    let s = makeStudy();
    s = { ...s, heat: { ...s.heat, ambientC: 30 } };
    const a = addRegion(s, { role: 'heatFlux', faces: [0, 1] });
    expect(a.region.heatW).toBe(5);
    expect(a.region.name).toBe('発熱 1');
    const b = addRegion(a.study, { role: 'heatFlux', faces: [2] });
    expect(b.region.name).toBe('発熱 2');
    const c = addRegion(b.study, { role: 'fixedTemp', faces: [3] });
    expect(c.region.tempC).toBe(30);
    const d = addRegion(c.study, { role: 'convection', faces: [4] });
    expect(d.region.h).toBe(40);
    const e = addRegion(d.study, { role: 'insulated', faces: [5] });
    expect(e.region.heatW).toBeUndefined();
    expect(e.study.regions.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    expect(nextRegionName(e.study.regions, 'insulated')).toBe('断熱 2');
    // 元の Study3D は変わらない
    expect(s.regions).toEqual([]);
  });

  it('面が選ばれていない・範囲外の面だけのときは日本語の Error', () => {
    const s = makeStudy();
    expect(() => addRegion(s, { role: 'heatFlux', faces: [] })).toThrow(/面が選ばれていません/);
    expect(() => addRegion(s, { role: 'heatFlux', faces: [9999] })).toThrow(/面が選ばれていません/);
  });

  it('同じ面を別の条件にすると、面は新しい条件に移る。面がなくなった条件は消える', () => {
    const s0 = makeStudy();
    const a = addRegion(s0, { role: 'heatFlux', faces: [0, 1, 2] });
    const b = addRegion(a.study, { role: 'convection', faces: [2, 3] });
    expect(b.study.regions.find((r) => r.id === a.region.id)!.faces).toEqual([0, 1]);
    expect(b.removed).toEqual([]);
    const c = addRegion(b.study, { role: 'insulated', faces: [0, 1] });
    expect(c.removed).toEqual(['発熱 1']);
    expect(c.study.regions.map((r) => r.role)).toEqual(['convection', 'insulated']);
  });

  it('削除・名前と値の編集。断熱の値は無視する', () => {
    const a = addRegion(makeStudy(), { role: 'heatFlux', faces: [0] });
    const b = addRegion(a.study, { role: 'insulated', faces: [1] });
    const edited = updateRegion(b.study, a.region.id, { name: 'CPU', value: 12 });
    expect(edited.regions[0]).toMatchObject({ name: 'CPU', heatW: 12 });
    const same = updateRegion(edited, b.region.id, { value: 3 });
    expect(same.regions[1].heatW).toBeUndefined();
    expect(removeRegion(same, a.region.id).regions.map((r) => r.id)).toEqual([b.region.id]);
    expect(removeRegion(same, 'zzz')).toBe(same);
    expect(regionValueText(edited.regions[0])).toBe('12 W');
  });

  it('三角形 → 条件の番号', () => {
    const a = addRegion(makeStudy(), { role: 'heatFlux', faces: [0, 1] });
    const b = addRegion(a.study, { role: 'fixedTemp', faces: [5] });
    const owner = faceOwners(b.study);
    expect([owner[0], owner[1], owner[2], owner[5]]).toEqual([0, 0, -1, 1]);
  });
});

describe('古い結果の見分け（studySignature）', () => {
  it('値・材料・周囲・条件が変われば印が変わる。名前だけなら変わらない', () => {
    const s = makeStudy();
    const base = studySignature(s);
    expect(studySignature({ ...s, name: '別の名前' })).toBe(base);
    expect(studySignature({ ...s, materialId: 'pla' })).not.toBe(base);
    expect(studySignature({ ...s, heat: { ...s.heat, ambientC: 40 } })).not.toBe(base);
    const a = addRegion(s, { role: 'heatFlux', faces: [0] });
    expect(studySignature(a.study)).not.toBe(base);
    expect(studySignature(updateRegion(a.study, a.region.id, { name: 'x' }))).toBe(studySignature(a.study));
    expect(studySignature(updateRegion(a.study, a.region.id, { value: 6 }))).not.toBe(studySignature(a.study));
    expect(studySignature({ ...s, grid: { maxCells: 50_000 } })).not.toBe(base);
  });
});

describe('Sim3DModel', () => {
  it('選んだ面に条件を足す → 選択は空になり、その条件が一覧で選ばれた状態になる', () => {
    const m = new Sim3DModel(makeStudy());
    expect(() => m.addRegionFromSelection('heatFlux')).toThrow();
    m.setSelection(new Set([0, 1]));
    const r = m.addRegionFromSelection('heatFlux', 5);
    expect(m.selection.size).toBe(0);
    expect(m.activeRegionId).toBe(r.region.id);
    expect(m.study.regions).toHaveLength(1);
    m.deleteRegion(r.region.id);
    expect(m.study.regions).toHaveLength(0);
    expect(m.activeRegionId).toBeNull();
  });

  it('結果は、条件や設定を変えると古い扱いになる。もとに戻すと古くない', () => {
    const m = new Sim3DModel(makeStudy());
    expect(m.stale).toBe(false);
    m.setResult(fakeResult(), m.signature);
    expect(m.stale).toBe(false);
    m.setAmbient(40);
    expect(m.stale).toBe(true);
    m.setAmbient(25);
    expect(m.stale).toBe(false);
    m.setSelection(new Set([0]));
    m.addRegionFromSelection('heatFlux');
    expect(m.stale).toBe(true);
    m.setName('名前だけ');
    expect(m.stale).toBe(true); // 条件を足した分はまだ古い
  });

  it('結果が届いたら、一覧で選んでいた条件の強調は外れる（結果の色を読み取りやすくする）', () => {
    const m = new Sim3DModel(makeStudy());
    m.setSelection(new Set([0, 1]));
    m.addRegionFromSelection('heatFlux');
    expect(m.activeRegionId).not.toBeNull();
    m.setResult(fakeResult(), m.signature);
    expect(m.activeRegionId).toBeNull();
  });

  it('計算を始めたあとに条件が変わったら、結果が届いた時点で古い', () => {
    const m = new Sim3DModel(makeStudy());
    const sig = m.signature;
    m.setSurfaceH(40);
    m.setResult(fakeResult(), sig);
    expect(m.stale).toBe(true);
  });

  it('部品全体の発熱は 0 以下で「なし」。計算の細かさは maxCells になる', () => {
    const m = new Sim3DModel(makeStudy());
    m.setBodyHeat(3);
    expect(m.study.heat.bodyHeatW).toBe(3);
    m.setBodyHeat(0);
    expect(m.study.heat.bodyHeatW).toBeUndefined();
    m.setQuality('fine');
    expect(m.study.grid?.maxCells).toBe(1_000_000);
    expect(m.study.grid?.cell).toBeCloseTo(0.08 / 128, 9);
    m.setQuality('normal');
    expect(m.study.grid).toEqual({ maxCells: 300_000 });
  });

  it('断面の位置は形の範囲に収まり、軸を変えると真ん中に戻る', () => {
    const m = new Sim3DModel(makeStudy());
    expect(m.section.position).toBeCloseTo(0.004, 6);
    m.setSection({ position: 10 });
    expect(m.section.position).toBeCloseTo(0.008, 6);
    m.setSection({ axis: 0 });
    expect(m.section.position).toBeCloseTo(0.04, 6);
  });

  it('変更を購読している画面に知らせる', () => {
    const m = new Sim3DModel(makeStudy());
    const events: ModelEvent[] = [];
    const off = m.subscribe((e) => events.push(e));
    m.setAmbient(30);
    m.setSelection(new Set([1]));
    m.setSection({ on: true });
    off();
    m.setAmbient(31);
    expect(events).toEqual(['study', 'selection', 'section']);
  });
});

describe('設定の選択肢', () => {
  it('冷え方: h に合う選択肢、合わなければ「数値で指定」', () => {
    expect(coolingIdFor(8)).toBe('natural');
    expect(coolingIdFor(40)).toBe('fan');
    expect(coolingIdFor(33)).toBe('custom');
    expect(COOLING_OPTIONS.filter((o) => o.h !== undefined).map((o) => o.h)).toEqual([8, 20, 40, 80]);
  });

  it('細かさ: 粗い 5 万・標準 30 万・細かい 100 万。格子はセル数の上限に収まる', () => {
    expect(QUALITY_OPTIONS.map((q) => q.maxCells)).toEqual([50_000, 300_000, 1_000_000]);
    expect(qualityIdFor(undefined)).toBe('normal');
    expect(qualityIdFor(60_000)).toBe('coarse');
    const s = makeStudy();
    const m = new Sim3DModel(s);
    const counts = QUALITY_OPTIONS.map((q) => {
      const g = previewGrid(m.bounds, qualityGrid(q.id, m.bounds))!;
      expect(g.nx * g.ny * g.nz).toBeLessThanOrEqual(q.maxCells);
      return g.nx * g.ny * g.nz;
    });
    // 粗い < 標準 < 細かい（セル数の上限だけでは、標準より細かくならない）
    expect(counts[0]).toBeLessThan(counts[1]);
    expect(counts[1]).toBeLessThan(counts[2]);
  });
});
