import { describe, expect, it } from 'vitest';
import {
  arcFromThreePoints,
  arcStripPolygon,
  bboxOf,
  chainPolylines,
  makeTransform,
  polygonArea,
  rectPolygon,
  rotatePt,
  simplifyRing,
  stadiumPolygon,
  tessellateArc,
  type Pt,
} from './geom';

describe('回転', () => {
  it('KiCad と同じく、画面（y 下向き）で反時計回りが正', () => {
    // 右に伸びる点 (1, 0) を 90° 回すと、画面の上 = y が負の向き
    const [x, y] = rotatePt([1, 0], 90);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(-1, 12);
    expect(rotatePt([1, 2], 180)).toEqual([-1, -2]);
  });

  it('平行移動と合わせた変換', () => {
    const tf = makeTransform(10, 20, 90);
    const p = tf([2, 1]); // 回転で (1, -2) → 平行移動で (11, 18)
    expect(p[0]).toBeCloseTo(11, 9);
    expect(p[1]).toBeCloseTo(18, 9);
  });
});

describe('図形', () => {
  it('長円の面積は 長さ × 幅 + 円（近似）', () => {
    const p = stadiumPolygon([0, 0], [10, 0], 0.5);
    const exact = 10 * 0.5 + Math.PI * 0.25 ** 2;
    expect(polygonArea(p) / exact).toBeGreaterThan(0.995);
    expect(polygonArea(p) / exact).toBeLessThanOrEqual(1);
    const b = bboxOf(p);
    expect(b.x0).toBeCloseTo(-0.25, 9);
    expect(b.x1).toBeCloseTo(10.25, 9);
  });

  it('長さ 0 の長円は円', () => {
    expect(polygonArea(stadiumPolygon([1, 1], [1, 1], 2))).toBeGreaterThan(3.0);
  });

  it('回転した四角の面積は変わらない', () => {
    expect(polygonArea(rectPolygon(5, 5, 4, 2, 37))).toBeCloseTo(8, 9);
  });
});

describe('弧', () => {
  it('3 点から円の中心と半径を求め、中間点を通る向きに掃引する', () => {
    const arc = arcFromThreePoints([1, 0], [0, 1], [-1, 0])!;
    expect(arc.r).toBeCloseTo(1, 9);
    expect(arc.cx).toBeCloseTo(0, 9);
    // (1,0) → (0,1) → (-1,0): 角度が増える向きに半周
    expect(arc.sweep).toBeCloseTo(Math.PI, 9);
    const rev = arcFromThreePoints([1, 0], [0, -1], [-1, 0])!;
    expect(rev.sweep).toBeCloseTo(-Math.PI, 9);
  });

  it('一直線上の 3 点は弧にならない', () => {
    expect(arcFromThreePoints([0, 0], [1, 1], [2, 2])).toBeNull();
  });

  it('折れ線にしても始点と終点がずれない', () => {
    const arc = arcFromThreePoints([5, 0], [0, 5], [-5, 0])!;
    const pts = tessellateArc(arc);
    expect(pts[0][0]).toBeCloseTo(5, 9);
    expect(pts[pts.length - 1][0]).toBeCloseTo(-5, 9);
    expect(pts.length).toBeGreaterThan(8);
  });

  it('弧の配線の面積は 弧長 × 幅 に近い', () => {
    const arc = arcFromThreePoints([3, 0], [3 * Math.SQRT1_2, 3 * Math.SQRT1_2], [0, 3])!;
    const a = polygonArea(arcStripPolygon(arc, 0.4));
    expect(a / ((Math.PI * 3 / 2) * 0.4)).toBeGreaterThan(0.99);
    expect(a / ((Math.PI * 3 / 2) * 0.4)).toBeLessThan(1.01);
  });
});

describe('chainPolylines', () => {
  const sq: Pt[][] = [
    [[0, 0], [10, 0]],
    [[10, 10], [10, 0]], // 向きが逆
    [[10, 10], [0, 10]],
    [[0, 10], [0, 0.0004]], // 端点が 0.4 µm ずれている
  ];
  it('向きや順番がばらばらでも輪郭にし、端点の小さなずれを許す', () => {
    const { closed, open } = chainPolylines(sq, 1e-3);
    expect(open).toHaveLength(0);
    expect(closed).toHaveLength(1);
    expect(polygonArea(closed[0])).toBeCloseTo(100, 2);
  });

  it('隙間のある線は open に残る', () => {
    const { closed, open } = chainPolylines(sq.slice(0, 3), 1e-3);
    expect(closed).toHaveLength(0);
    expect(open).toHaveLength(1);
  });

  it('途中から始まる線でも先頭側につながる', () => {
    const shuffled = [sq[1], sq[0], sq[3], sq[2]];
    expect(chainPolylines(shuffled, 1e-3).closed).toHaveLength(1);
  });
});

describe('simplifyRing', () => {
  it('円を簡略化しても面積はほぼ変わらず、頂点は減る', () => {
    const pts: Pt[] = [];
    for (let i = 0; i < 400; i++) pts.push([10 * Math.cos((2 * Math.PI * i) / 400), 10 * Math.sin((2 * Math.PI * i) / 400)]);
    const s = simplifyRing(pts, 0.01);
    expect(s.length).toBeLessThan(pts.length / 3);
    expect(polygonArea(s) / polygonArea(pts)).toBeGreaterThan(0.999);
  });
});
