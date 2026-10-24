import { describe, expect, it } from 'vitest';
import { defaultProject } from '../core/project';
import type { Project, Shape } from '../core/types';
import {
  bodyMaterial,
  clampEmPoint,
  coolingIndex,
  easyMaterialLabel,
  findLoadShape,
  loadKg,
  setBodyMaterial,
  setLoadKg,
  setSlabThicknessMm,
  setTotalHeatW,
  suggestEdgeRects,
  suggestHeatRect,
  totalHeatW,
} from './easy-logic';
import { COOLING_LEVELS } from './verdict';

const rect = (id: string, role: Shape['role'], x: number, y: number, w: number, h: number, extra: Partial<Shape> = {}): Shape => ({
  id,
  name: id,
  role,
  materialId: 'pla',
  geom: { kind: 'rect', x, y, w, h },
  ...extra,
});

function project(shapes: Shape[]): Project {
  const p = defaultProject();
  p.domain = { width: 0.24, height: 0.06, nx: 240, autoGrid: true };
  p.shapes = shapes;
  return p;
}

describe('荷重（kg ⇄ N）', () => {
  it('kg を入れると向きを保って N に換算する', () => {
    const s = rect('l', 'load', 0, 0, 0.01, 0.01, { force: { fx: 0, fy: -1 } });
    setLoadKg(s, 10);
    expect(s.force!.fx).toBeCloseTo(0, 9);
    expect(s.force!.fy).toBeCloseTo(-98.1, 6);
    expect(loadKg(s)).toBeCloseTo(10, 9);
    expect(s.name).toBe('荷重 10 kg');
  });
  it('斜めの荷重は向きを保つ', () => {
    const s = rect('l', 'load', 0, 0, 0.01, 0.01, { force: { fx: 3, fy: -4 } });
    setLoadKg(s, 1);
    expect(Math.hypot(s.force!.fx, s.force!.fy)).toBeCloseTo(9.81, 6);
    expect(s.force!.fx / s.force!.fy).toBeCloseTo(-0.75, 9);
  });
  it('力が 0 の荷重は下向きになる', () => {
    const s = rect('l', 'load', 0, 0, 0.01, 0.01, { force: { fx: 0, fy: 0 } });
    setLoadKg(s, 2);
    expect(s.force).toEqual({ fx: 0, fy: -19.62 });
  });
  it('選択中の荷重を優先し、なければ最初の荷重を使う', () => {
    const a = rect('a', 'load', 0, 0, 1, 1);
    const b = rect('b', 'load', 0, 0, 1, 1);
    const body = rect('c', 'solid', 0, 0, 1, 1);
    const p = project([body, a, b]);
    expect(findLoadShape(p, 'b')?.id).toBe('b');
    expect(findLoadShape(p, 'c')?.id).toBe('a');
    expect(findLoadShape(p, null)?.id).toBe('a');
    expect(findLoadShape(project([body]), null)).toBeUndefined();
  });
});

describe('置き場所の提案', () => {
  it('荷重と固定面を最初の物体の右端・左端に、物体に重なるように置く', () => {
    const p = project([rect('beam', 'solid', 0.03, 0.025, 0.2, 0.01)]);
    const r = suggestEdgeRects(p, 0.001)!;
    if (r.support.kind !== 'rect' || r.load.kind !== 'rect') throw new Error('rect');
    // 固定面は左端をまたぎ、荷重は右端をまたぐ
    expect(r.support.x).toBeLessThan(0.03);
    expect(r.support.x + r.support.w).toBeGreaterThan(0.03);
    expect(r.load.x).toBeLessThan(0.23);
    expect(r.load.x + r.load.w).toBeGreaterThan(0.23);
    // 高さは物体と同じ
    expect(r.load.y).toBeCloseTo(0.025, 9);
    expect(r.load.h).toBeCloseTo(0.01, 9);
    // 2 セル以上の厚み
    expect(r.load.w).toBeGreaterThanOrEqual(0.002 - 1e-12);
  });
  it('物体がなければ null', () => {
    expect(suggestEdgeRects(project([]), 0.001)).toBeNull();
    expect(suggestHeatRect(project([]))).toBeNull();
  });
  it('発熱体は物体の中央に置く', () => {
    const g = suggestHeatRect(project([rect('b', 'solid', 0.02, 0.01, 0.1, 0.04)]))!;
    if (g.kind !== 'rect') throw new Error('rect');
    expect(g.x + g.w / 2).toBeCloseTo(0.07, 9);
    expect(g.y + g.h / 2).toBeCloseTo(0.03, 9);
  });
});

describe('材料', () => {
  it('全ての物体を同じ材料にする（穴や荷重は触らない）', () => {
    const p = project([rect('a', 'solid', 0, 0, 1, 1), rect('b', 'heatSource', 0, 0, 1, 1, { materialId: 'c1100' }), rect('c', 'hole', 0, 0, 1, 1, { materialId: 'pla' })]);
    expect(bodyMaterial(p).mixed).toBe(true);
    setBodyMaterial(p, 'al6061');
    expect(p.shapes.map((s) => s.materialId)).toEqual(['al6061', 'al6061', 'pla']);
    expect(bodyMaterial(p)).toEqual({ id: 'al6061', mixed: false });
    expect(bodyMaterial(project([])).id).toBeNull();
  });
  it('roles を絞ると、発熱体の材料は変えない（熱の解析用）', () => {
    const p = project([rect('a', 'solid', 0, 0, 1, 1), rect('b', 'heatSource', 0, 0, 1, 1, { materialId: 'c1100' })]);
    setBodyMaterial(p, 'al6061', ['solid']);
    expect(p.shapes.map((s) => s.materialId)).toEqual(['al6061', 'c1100']);
    expect(bodyMaterial(p, ['solid'])).toEqual({ id: 'al6061', mixed: false });
  });
  it('やさしい名前', () => {
    expect(easyMaterialLabel('al6061')).toBe('アルミ');
    expect(easyMaterialLabel('pla')).toContain('PLA');
    expect(easyMaterialLabel('fr4')).toContain('FR-4');
  });
});

describe('発熱量', () => {
  it('合計が指定値になるように、割合を保って配分する', () => {
    const p = project([rect('a', 'heatSource', 0, 0, 1, 1, { heatW: 1 }), rect('b', 'heatSource', 0, 0, 1, 1, { heatW: 3 })]);
    expect(totalHeatW(p)).toBe(4);
    setTotalHeatW(p, 8);
    expect(p.shapes.map((s) => s.heatW)).toEqual([2, 6]);
  });
  it('全て 0 W なら等分する', () => {
    const p = project([rect('a', 'heatSource', 0, 0, 1, 1, { heatW: 0 }), rect('b', 'heatSource', 0, 0, 1, 1, { heatW: 0 })]);
    setTotalHeatW(p, 10);
    expect(p.shapes.map((s) => s.heatW)).toEqual([5, 5]);
  });
});

describe('冷やし方', () => {
  it('h に近い段階を選び、離れていればカスタム(-1)', () => {
    expect(coolingIndex(7, COOLING_LEVELS)).toBe(0);
    expect(coolingIndex(8, COOLING_LEVELS)).toBe(0);
    expect(coolingIndex(25, COOLING_LEVELS)).toBe(1);
    expect(coolingIndex(60, COOLING_LEVELS)).toBe(2);
    expect(coolingIndex(15, COOLING_LEVELS)).toBe(-1);
  });
});

describe('電磁波', () => {
  it('平板の厚みは中心を保って変わる', () => {
    const s = rect('s', 'solid', 0.0481, 0.008, 0.0037, 0.064);
    setSlabThicknessMm(s, 1.9);
    if (s.geom.kind !== 'rect') throw new Error('rect');
    expect(s.geom.w).toBeCloseTo(0.0019, 9);
    expect(s.geom.x + s.geom.w / 2).toBeCloseTo(0.0481 + 0.00185, 9);
    expect(s.geom.y).toBe(0.008);
  });
  it('領域の外にある点波源は、見える位置に直す', () => {
    const p = project([]);
    p.em.pointX = 0.2;
    p.em.pointY = 0.5;
    expect(clampEmPoint(p)).toEqual({ x: 0.06, y: 0.03 });
    p.em.pointX = 0.1;
    p.em.pointY = 0.02;
    expect(clampEmPoint(p)).toEqual({ x: 0.1, y: 0.02 });
  });
});
