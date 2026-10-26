import { areaP2, insideTriangle, interpP2, locateP2, shapeP2 } from './p2';

// 直角三角形（0,0）（1,0）（0,1）。辺の中点は直線上
const X = [0, 1, 0, 0.5, 0.5, 0];
const Y = [0, 0, 1, 0, 0.5, 0.5];

describe('形状関数', () => {
  it('和は 1、節点では自分の節点だけ 1', () => {
    const N = new Array<number>(6).fill(0);
    shapeP2(0.2, 0.3, N);
    expect(N.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    const nodes: [number, number][] = [[0, 0], [1, 0], [0, 1], [0.5, 0], [0.5, 0.5], [0, 0.5]];
    nodes.forEach(([xi, eta], a) => {
      shapeP2(xi, eta, N);
      N.forEach((v, b) => expect(v).toBeCloseTo(a === b ? 1 : 0, 12));
    });
  });

  it('2 次式を厳密に補間する（節点の値から）', () => {
    const f = (x: number, y: number) => 3 + 2 * x - y + 4 * x * x - 5 * x * y + y * y;
    const v = X.map((x, i) => f(x, Y[i]));
    for (const [xi, eta] of [[0.1, 0.2], [0.6, 0.3], [0.25, 0.7]]) expect(interpP2(v, xi, eta)).toBeCloseTo(f(xi, eta), 12);
  });
});

describe('areaP2', () => {
  it('直線の辺: 三角形の面積', () => {
    expect(areaP2(X, Y)).toBeCloseTo(0.5, 12);
    expect(areaP2(X.map((x) => 2 * x), Y.map((y) => 3 * y))).toBeCloseTo(3, 12);
  });

  it('辺の中点を外にずらした（曲がった辺）: 放物線の弓形の面積 2/3 × 弦 × ずれ だけ増える', () => {
    const y = [...Y];
    y[3] = -0.1; // 辺 1-2（(0,0)→(1,0)）の中点を下へ
    expect(areaP2(X, y)).toBeCloseTo(0.5 + (2 / 3) * 1 * 0.1, 12);
  });
});

describe('locateP2', () => {
  it('直線の辺: 点の位置（ξ, η）が分かり、中か外かも分かる', () => {
    const a = locateP2(X, Y, 0.2, 0.3)!;
    expect(a.xi).toBeCloseTo(0.2, 12);
    expect(a.eta).toBeCloseTo(0.3, 12);
    expect(insideTriangle(a.xi, a.eta)).toBe(true);
    const b = locateP2(X, Y, 0.8, 0.8)!;
    expect(insideTriangle(b.xi, b.eta)).toBe(false);
  });

  it('曲がった辺でも、形状関数で戻すと元の点になる', () => {
    const xs = [0, 1, 0, 0.5, 0.58, 0];
    const ys = [0, 0, 1, -0.08, 0.57, 0.5];
    const N = new Array<number>(6).fill(0);
    for (const [xi, eta] of [[0.2, 0.2], [0.5, 0.3], [0.1, 0.8], [0.4, 0.05]]) {
      shapeP2(xi, eta, N);
      const px = N.reduce((s, n, a) => s + n * xs[a], 0);
      const py = N.reduce((s, n, a) => s + n * ys[a], 0);
      const loc = locateP2(xs, ys, px, py)!;
      expect(loc.xi).toBeCloseTo(xi, 9);
      expect(loc.eta).toBeCloseTo(eta, 9);
    }
  });

  it('つぶれた要素（面積 0）は null', () => {
    expect(locateP2([0, 1, 2, 0.5, 1.5, 1], [0, 0, 0, 0, 0, 0], 0.5, 0.1)).toBeNull();
  });
});
