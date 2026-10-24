import { describe, expect, it } from 'vitest';
import type { Shape, ShapeGeom } from '../core/types';
import {
  applyHandle,
  dedupePoints,
  distToOutline,
  geomBBox,
  geomHandles,
  geomToPolygon,
  hitHandle,
  hitShape,
  polygonArea,
  rdpSimplify,
  simplifyFreehand,
  snapValue,
  translateGeom,
  type Pt,
} from './geometry';

const rect: ShapeGeom = { kind: 'rect', x: 1, y: 1, w: 2, h: 1 };
const circle: ShapeGeom = { kind: 'circle', cx: 5, cy: 5, r: 1 };
const mk = (id: string, geom: ShapeGeom): Shape => ({ id, name: id, geom, role: 'solid', materialId: 'pla' });

describe('bbox / translate', () => {
  it('各形状の外接矩形', () => {
    expect(geomBBox(rect)).toEqual({ x0: 1, y0: 1, x1: 3, y1: 2 });
    expect(geomBBox(circle)).toEqual({ x0: 4, y0: 4, x1: 6, y1: 6 });
    expect(geomBBox({ kind: 'polygon', points: [[0, 0], [4, 1], [2, 3]] })).toEqual({ x0: 0, y0: 0, x1: 4, y1: 3 });
  });
  it('平行移動しても元の形は変わらない', () => {
    const moved = translateGeom(rect, 1, -1);
    expect(moved).toEqual({ kind: 'rect', x: 2, y: 0, w: 2, h: 1 });
    expect(rect).toEqual({ kind: 'rect', x: 1, y: 1, w: 2, h: 1 });
  });
});

describe('hitShape', () => {
  const shapes = [mk('a', { kind: 'rect', x: 0, y: 0, w: 10, h: 10 }), mk('b', { kind: 'rect', x: 2, y: 2, w: 2, h: 2 })];
  it('重なっていたら後ろ（手前）の図形を選ぶ', () => {
    expect(hitShape(shapes, 3, 3)?.id).toBe('b');
    expect(hitShape(shapes, 8, 8)?.id).toBe('a');
  });
  it('何もなければ undefined', () => {
    expect(hitShape(shapes, 20, 20)).toBeUndefined();
  });
  it('許容距離内なら輪郭の外側でも拾う', () => {
    expect(hitShape(shapes, 10.2, 5)).toBeUndefined();
    expect(hitShape(shapes, 10.2, 5, 0.5)?.id).toBe('a');
  });
  it('多角形の内側判定', () => {
    const tri = [mk('t', { kind: 'polygon', points: [[0, 0], [4, 0], [0, 4]] })];
    expect(hitShape(tri, 1, 1)?.id).toBe('t');
    expect(hitShape(tri, 3, 3)).toBeUndefined();
  });
});

describe('distToOutline', () => {
  it('長方形・円の輪郭までの距離', () => {
    expect(distToOutline(rect, 2, 1.5)).toBeCloseTo(0.5);
    expect(distToOutline(circle, 7, 5)).toBeCloseTo(1);
    expect(distToOutline(circle, 5, 5)).toBeCloseTo(1);
  });
});

describe('handles', () => {
  it('長方形は4隅、円は1つ、多角形は頂点ぶん', () => {
    expect(geomHandles(rect)).toHaveLength(4);
    expect(geomHandles(circle)).toHaveLength(1);
    expect(geomHandles({ kind: 'polygon', points: [[0, 0], [1, 0], [0, 1]] })).toHaveLength(3);
  });
  it('hitHandle は一番近いハンドルを返す', () => {
    expect(hitHandle(rect, 3.02, 2.01, 0.1)?.id).toBe('ne');
    expect(hitHandle(rect, 2, 1.5, 0.1)).toBeUndefined();
  });
  it('長方形のハンドルは反対側の角を固定して動く', () => {
    const g = applyHandle(rect, 'ne', 5, 4);
    expect(g).toEqual({ kind: 'rect', x: 1, y: 1, w: 4, h: 3 });
    const flipped = applyHandle(rect, 'ne', 0, 0); // 反対側の角を越えて引いても正規化される
    expect(flipped).toMatchObject({ kind: 'rect', x: 0, y: 0, w: 1, h: 1 });
    const sw = applyHandle(rect, 'sw', 2, 1.5);
    expect(sw).toMatchObject({ x: 2, y: 1.5, w: 1, h: 0.5 });
  });
  it('円は半径、多角形は頂点だけが変わる', () => {
    expect(applyHandle(circle, 'r', 8, 5)).toEqual({ kind: 'circle', cx: 5, cy: 5, r: 3 });
    const poly: ShapeGeom = { kind: 'polygon', points: [[0, 0], [1, 0], [0, 1]] };
    expect(applyHandle(poly, 'v1', 3, 3)).toEqual({ kind: 'polygon', points: [[0, 0], [3, 3], [0, 1]] });
  });
});

describe('rdpSimplify / simplifyFreehand', () => {
  it('一直線上の点は端点だけに', () => {
    const line: Pt[] = Array.from({ length: 20 }, (_, i) => [i, 0]);
    expect(rdpSimplify(line, 0.01)).toEqual([[0, 0], [19, 0]]);
  });
  it('折れ点は許容誤差より大きければ残る', () => {
    const l: Pt[] = [[0, 0], [5, 0.05], [10, 0], [10, 10]];
    expect(rdpSimplify(l, 0.1)).toEqual([[0, 0], [10, 0], [10, 10]]);
    expect(rdpSimplify(l, 0.01)).toHaveLength(4);
  });
  it('丸い軌跡は少数の頂点の多角形になる', () => {
    const circlePts: Pt[] = Array.from({ length: 200 }, (_, i) => [Math.cos((i / 200) * 2 * Math.PI), Math.sin((i / 200) * 2 * Math.PI)]);
    const poly = simplifyFreehand(circlePts, 0.02)!;
    expect(poly).not.toBeNull();
    expect(poly.length).toBeGreaterThanOrEqual(8);
    expect(poly.length).toBeLessThan(60);
    expect(polygonArea(poly)).toBeGreaterThan(2.9);
  });
  it('点が少ない・面積がない軌跡は null', () => {
    expect(simplifyFreehand([[0, 0], [1, 1]], 0.1)).toBeNull();
    expect(simplifyFreehand([[0, 0], [1, 0], [2, 0], [3, 0]], 0.1)).toBeNull();
  });
});

describe('その他', () => {
  it('dedupePoints は近い連続点と始終点の重複を除く', () => {
    expect(dedupePoints([[0, 0], [0.01, 0], [1, 0], [1, 1], [0.005, 0.005]], 0.05)).toEqual([[0, 0], [1, 0], [1, 1]]);
  });
  it('polygonArea', () => {
    expect(polygonArea([[0, 0], [4, 0], [4, 3], [0, 3]])).toBe(12);
  });
  it('snapValue', () => {
    expect(snapValue(0.26, 0.1)).toBeCloseTo(0.3);
    expect(snapValue(0.26, 0)).toBe(0.26);
  });
  it('geomToPolygon は長方形の辺を分割する', () => {
    expect(geomToPolygon(rect, 48, 4)).toHaveLength(16);
    expect(geomToPolygon(circle, 12)).toHaveLength(12);
  });
});
