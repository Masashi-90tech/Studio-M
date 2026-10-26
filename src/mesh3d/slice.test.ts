import { describe, expect, it } from 'vitest';
import { dropTriangle, toAsciiStl, toBinaryStl, unindex } from './fixtures';
import { cleanMesh } from './mesh';
import { boxMesh, cylinderMesh, extrudePolygon, plateWithHole, regularPolygonArea } from './primitives';
import { parseStl } from './stl';
import { pointInPolygon, sectionSegments3D, simplifyLoop, sliceAxes, sliceMesh } from './slice';
import type { Axis, TriMesh } from './types';

/** STL を読んだあとと同じ（頂点が重なっている）形から整理して、切る */
const prep = (m: TriMesh): TriMesh => cleanMesh(unindex(m)).mesh;
const cut = (m: TriMesh, axis: Axis, position: number, extra: Partial<Parameters<typeof sliceMesh>[1]> = {}) => sliceMesh(prep(m), { axis, position, ...extra });
const areaOf = (loops: { area: number; hole: boolean }[]): number => loops.reduce((s, l) => s + (l.hole ? -l.area : l.area), 0);

const L_POLY: [number, number][] = [
  [0, 0],
  [40, 0],
  [40, 10],
  [10, 10],
  [10, 40],
  [0, 40],
];

describe('断面の向き', () => {
  it('Z で切ると (x, y)、X で切ると (y, z)、Y で切ると (x, z)', () => {
    expect(sliceAxes(2)).toEqual({ uAxis: 0, vAxis: 1 });
    expect(sliceAxes(0)).toEqual({ uAxis: 1, vAxis: 2 });
    expect(sliceAxes(1)).toEqual({ uAxis: 0, vAxis: 2 });
  });

  it('箱を X で切ると、画面の横が Y・縦が Z になる', () => {
    const s = cut(boxMesh(10, 20, 30), 0, 5);
    expect(s.bounds2d).toEqual([0, 0, 20, 30]);
    expect(s.axisRange).toEqual([0, 10]);
  });
});

describe('立方体の断面', () => {
  it('中央で切ると、正方形 1 つ（4 頂点、面積 100）。どの軸でも同じ', () => {
    for (const axis of [0, 1, 2] as Axis[]) {
      const s = cut(boxMesh(10, 10, 10), axis, 5);
      expect(s.loops).toHaveLength(1);
      expect(s.loops[0].points).toHaveLength(4);
      expect(s.loops[0].area).toBeCloseTo(100, 4);
      expect(s.loops[0]).toMatchObject({ depth: 0, hole: false });
      expect(s.openSegments).toBe(0);
      expect(s.warnings).toEqual([]);
    }
  });

  it('外形は反時計回り（符号つき面積が正）', () => {
    const p = cut(boxMesh(10, 10, 10), 2, 5).loops[0].points;
    let a = 0;
    for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
    expect(a / 2).toBeCloseTo(100, 4);
  });

  it('外れた位置では断面が空になり、注意が出る', () => {
    for (const z of [-3, 13]) {
      const s = cut(boxMesh(10, 10, 10), 2, z);
      expect(s.loops).toEqual([]);
      expect(s.bounds2d).toBeNull();
      expect(s.warnings[0]).toMatch(/断面が空/);
    }
  });

  it('側面と同じ高さ（頂点が平面上にある位置）で切っても、欠けも重なりもない', () => {
    const s = cut(boxMesh(10, 10, 10), 2, 0); // 底面ちょうど
    expect(s.loops).toHaveLength(1);
    expect(s.loops[0].area).toBeCloseTo(100, 3);
    expect(s.openSegments).toBe(0);
  });
});

describe('穴あき板の断面', () => {
  const N = 48;
  const plate = plateWithHole({ w: 80, d: 50, t: 8, r: 12, n: N });
  const holeArea = regularPolygonArea(12, N);

  it('厚さ方向（Z）に切ると、外形 1 つ + 穴 1 つ。面積が理論値と一致する', () => {
    const s = cut(plate, 2, 4, { simplify: 0 });
    expect(s.loops).toHaveLength(2);
    const [outer, hole] = s.loops;
    expect(outer).toMatchObject({ depth: 0, hole: false });
    expect(hole).toMatchObject({ depth: 1, hole: true });
    expect(outer.area).toBeCloseTo(80 * 50, 3);
    expect(hole.area).toBeCloseTo(holeArea, 3);
    expect(hole.points).toHaveLength(N);
    expect(areaOf(s.loops)).toBeCloseTo(80 * 50 - holeArea, 3);
    expect(s.warnings).toEqual([]);
  });

  it('間引き（既定）をかけても、面積は 0.1% 以内。円の頂点は消えない', () => {
    const s = cut(plate, 2, 4);
    expect(s.loops[1].points).toHaveLength(N);
    expect(areaOf(s.loops)).toBeCloseTo(80 * 50 - holeArea, 0);
    expect(Math.abs(areaOf(s.loops) - (80 * 50 - holeArea)) / (80 * 50)).toBeLessThan(1e-3);
  });

  it('穴の中心を通る X 方向の断面は、2 本の壁（外形 2 つ・穴なし）になる', () => {
    const s = cut(plate, 0, 40); // 板の中央（x = 40）。穴の直径が通る
    expect(s.loops).toHaveLength(2);
    expect(s.loops.every((l) => !l.hole)).toBe(true);
    // 壁の幅 = (50 - 穴の Y 方向の幅) / 2。N = 48 で頂点は ±(180/48) 度ずれた位置にあるので、幅は 2 r cos(π/N)
    const gap = 2 * 12 * Math.cos(Math.PI / N);
    const wall = (50 - gap) / 2;
    expect(s.loops[0].area).toBeCloseTo(wall * 8, 1);
    expect(s.loops[1].area).toBeCloseTo(wall * 8, 1);
  });

  it('穴を外れた位置の X 断面は、1 つの長方形', () => {
    const s = cut(plate, 0, 10);
    expect(s.loops).toHaveLength(1);
    expect(s.loops[0].area).toBeCloseTo(50 * 8, 3);
  });

  it('バイナリ STL と ASCII STL から読んだ形で、同じ断面になる', () => {
    const fromBin = sliceMesh(cleanMesh(parseStl(toBinaryStl(plate))).mesh, { axis: 2, position: 4 });
    const fromAscii = sliceMesh(cleanMesh(parseStl(new TextEncoder().encode(toAsciiStl(plate)))).mesh, { axis: 2, position: 4 });
    expect(fromBin.loops).toHaveLength(2);
    expect(fromAscii.loops.map((l) => l.points.length)).toEqual(fromBin.loops.map((l) => l.points.length));
    expect(areaOf(fromAscii.loops)).toBeCloseTo(areaOf(fromBin.loops), 6);
  });
});

describe('いろいろな形', () => {
  it('円柱（64 角形）の断面は、多角形の面積と一致する', () => {
    const s = cut(cylinderMesh(5, 20, 64), 2, 10);
    expect(s.loops).toHaveLength(1);
    expect(s.loops[0].area).toBeCloseTo(regularPolygonArea(5, 64), 3);
    // 円柱を横（X）から切ると、直径に近い幅 × 高さの長方形
    const side = cut(cylinderMesh(5, 20, 64), 0, 0.001);
    expect(side.loops).toHaveLength(1);
    expect(side.loops[0].area).toBeCloseTo(20 * 10, 0);
    expect(side.bounds2d![3] - side.bounds2d![1]).toBeCloseTo(20, 6);
  });

  it('L 字ブラケットの断面は L 字（6 頂点、面積 700）で、辺の途中の点は間引かれる', () => {
    const l = extrudePolygon(L_POLY, 0, 5, 3);
    const s = cut(l, 2, 2.5);
    expect(s.loops).toHaveLength(1);
    expect(s.loops[0].points).toHaveLength(6);
    expect(s.loops[0].area).toBeCloseTo(40 * 10 + 30 * 10, 4);
    // 高さ方向に切ると 1 辺 10 × 長さ 40 の帯（側面の高さのぶんだけ）
    const side = cut(l, 1, 5);
    expect(side.loops).toHaveLength(1);
    expect(side.loops[0].area).toBeCloseTo(40 * 5, 4);
  });

  it('頂点がちょうど平面上にある高さで切っても、少しずらした高さと同じ断面になる', () => {
    const l = extrudePolygon(L_POLY, 0, 6, 3); // 高さ 2, 4 に頂点の輪がある
    const on = cut(l, 2, 2, { simplify: 0 });
    const off = cut(l, 2, 2.0001, { simplify: 0 });
    expect(on.loops).toHaveLength(1);
    expect(on.openSegments).toBe(0);
    expect(on.loops[0].area).toBeCloseTo(off.loops[0].area, 3);
    expect(on.loops[0].area).toBeCloseTo(700, 3);
  });

  it('入れ子（外形の中の穴の中の島）を偶奇で判定する: 2 つの箱の組み合わせではなく、入れ子の輪を直接渡す', () => {
    // 中空の筒（外径 20・内径 10）と、その中に立つ棒（直径 4）を 1 つのメッシュにする
    const tube = plateWithHole({ w: 20, d: 20, t: 10, r: 5, n: 32 });
    const rod = cylinderMesh(2, 10, 24, [10, 10]);
    const merged: TriMesh = {
      positions: Float32Array.from([...tube.positions, ...rod.positions]),
      indices: Uint32Array.from([...tube.indices, ...Array.from(rod.indices, (i) => i + tube.positions.length / 3)]),
    };
    const s = sliceMesh(cleanMesh(unindex(merged)).mesh, { axis: 2, position: 5 });
    expect(s.loops.map((l) => l.depth)).toEqual([0, 1, 2]);
    expect(s.loops.map((l) => l.hole)).toEqual([false, true, false]);
  });
});

describe('閉じない断面・間引き', () => {
  const box = boxMesh(10, 10, 10);

  it('三角形が欠けた所を通る断面は、閉じていない線分として数えて注意を出す（輪は作らない）', () => {
    // 側面の三角形 1 つを欠く: 側面は 2 番目の面（index 6 以降が側面）。高さ 5 で切る
    const holed = dropTriangle(box, 4);
    const s = cut(holed, 2, 5, { closeGap: 0 });
    expect(s.loops).toEqual([]);
    expect(s.openSegments).toBeGreaterThan(0);
    expect(s.warnings.join('')).toMatch(/閉じていない.*線分 \d+ 本/);
  });

  it('小さな隙間（断面の対角線の 2% 以内）は直線で閉じ、注意に書く', () => {
    // 辺の長さ 10 の立方体で、欠けた三角形の隙間は 5 以上 → 大きな割合を許したときだけ閉じる
    const holed = dropTriangle(box, 4);
    const s = cut(holed, 2, 5, { closeGap: 1 });
    expect(s.loops).toHaveLength(1);
    expect(s.closedGaps).toBe(1);
    expect(s.warnings.join('')).toMatch(/隙間を 1 か所/);
  });

  it('細かすぎる輪は捨てる', () => {
    const big = boxMesh(100, 100, 10);
    const speck = boxMesh(1e-3, 1e-3, 10, [50, 50, 0]);
    const merged: TriMesh = {
      positions: Float32Array.from([...big.positions, ...speck.positions]),
      indices: Uint32Array.from([...big.indices, ...Array.from(speck.indices, (i) => i + big.positions.length / 3)]),
    };
    const s = sliceMesh(cleanMesh(unindex(merged)).mesh, { axis: 2, position: 5 });
    expect(s.loops).toHaveLength(1);
    expect(s.droppedTiny).toBe(1);
  });

  it('Douglas–Peucker: 一直線上の点を消し、頂点数の上限を守る', () => {
    const line: [number, number][] = [];
    for (let i = 0; i < 10; i++) line.push([i, 0]);
    line.push([10, 10], [0, 10]);
    expect(simplifyLoop(line, 1e-9, 100)).toHaveLength(4);
    // 円を 500 点で近似 → 上限 40 点以下に収める
    const circle: [number, number][] = Array.from({ length: 500 }, (_, k) => [Math.cos((2 * Math.PI * k) / 500), Math.sin((2 * Math.PI * k) / 500)]);
    const out = simplifyLoop(circle, 1e-6, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.length).toBeGreaterThanOrEqual(8);
  });

  it('頂点数の上限つきで切ると、細かい円の輪も上限以内になる', () => {
    const s = cut(cylinderMesh(5, 10, 400), 2, 5, { simplify: 0, maxVertices: 64 });
    expect(s.loops[0].points.length).toBeLessThanOrEqual(64);
  });
});

describe('補助', () => {
  it('偶奇判定の点の内外', () => {
    const sq: [number, number][] = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ];
    expect(pointInPolygon([2, 2], sq)).toBe(true);
    expect(pointInPolygon([5, 2], sq)).toBe(false);
  });

  it('断面の輪を 3D の線分にできる（切った軸の座標は切る位置）', () => {
    const s = cut(boxMesh(10, 10, 10), 2, 5);
    const seg = sectionSegments3D(s);
    expect(seg.length).toBe(4 * 6);
    for (let i = 2; i < seg.length; i += 3) expect(seg[i]).toBeCloseTo(5, 6);
  });
});
