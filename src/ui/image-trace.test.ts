import { describe, expect, it } from 'vitest';
import {
  binarize,
  borderIsMostlyObject,
  centeredOrigin,
  defaultWidthMm,
  groupsBBox,
  morphClose,
  morphOpen,
  otsuThreshold,
  removeSmallSpecks,
  runPipeline,
  scaleFromWidth,
  signedArea,
  toGray,
  toShapes,
  traceContours,
  traceMask,
  type PipelineParams,
  type RgbaImage,
} from './image-trace';

// ---------- テスト用の合成画像 ----------

/** 白地（255）に、f(x,y) が true の画素を黒で塗った RGBA 画像 */
function makeImage(w: number, h: number, dark: (x: number, y: number) => boolean): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = dark(x, y) ? 0 : 255;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const params = (over: Partial<PipelineParams> = {}): PipelineParams => ({
  threshold: 128,
  invert: false,
  minArea: 4,
  morphRadius: 0,
  tolerance: 1,
  includeHoles: true,
  ...over,
});

function run(img: RgbaImage, over: Partial<PipelineParams> = {}) {
  return runPipeline(toGray(img), img.width, img.height, params(over));
}

const near = (a: number, b: number, rel: number) => Math.abs(a - b) <= Math.abs(b) * rel;

describe('toGray / otsuThreshold / binarize', () => {
  it('輝度に変換し、透明は白として扱う', () => {
    const img: RgbaImage = { width: 3, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0]) };
    const g = toGray(img);
    expect(g[0]).toBe(Math.round(0.299 * 255));
    expect(g[1]).toBe(0);
    expect(g[2]).toBe(255);
  });

  it('二山のヒストグラムで 2 つの山の間にしきい値が来る', () => {
    const g = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) g[i] = i % 2 === 0 ? 40 + (i % 7) : 200 + (i % 5);
    const t = otsuThreshold(g);
    expect(t).toBeGreaterThanOrEqual(46);
    expect(t).toBeLessThan(200);
  });

  it('完全な 2 値（50 と 200）でも中間を返す', () => {
    const g = new Uint8Array(100).fill(200);
    g.fill(50, 0, 30);
    const t = otsuThreshold(g);
    expect(t).toBeGreaterThanOrEqual(50);
    expect(t).toBeLessThan(200);
    const m = binarize(g, t);
    expect(m.reduce((a, b) => a + b, 0)).toBe(30);
  });

  it('binarize は暗い画素が物体、invert で逆になる', () => {
    const g = new Uint8Array([0, 100, 200, 255]);
    expect(Array.from(binarize(g, 128))).toEqual([1, 1, 0, 0]);
    expect(Array.from(binarize(g, 128, true))).toEqual([0, 0, 1, 1]);
  });

  it('外周が暗い画像は自動反転の対象と判定する', () => {
    const dark = makeImage(20, 20, (x, y) => x < 3 || y < 3 || x > 16 || y > 16);
    expect(borderIsMostlyObject(toGray(dark), 20, 20, 128)).toBe(true);
    const light = makeImage(20, 20, (x, y) => x > 5 && x < 15 && y > 5 && y < 15);
    expect(borderIsMostlyObject(toGray(light), 20, 20, 128)).toBe(false);
  });
});

describe('輪郭追跡', () => {
  it('塗りつぶした長方形は外周 1 つ・面積が一致', () => {
    const img = makeImage(60, 40, (x, y) => x >= 10 && x < 40 && y >= 5 && y < 25); // 30 x 20
    const { groups } = run(img);
    expect(groups).toHaveLength(1);
    expect(groups[0].holes).toHaveLength(0);
    expect(near(groups[0].outer.signedArea, 600, 0.01)).toBe(true);
    expect(groups[0].outer.points).toHaveLength(4);
    expect(groupsBBox(groups)).toEqual({ minX: 10, minY: 5, maxX: 40, maxY: 25 });
  });

  it('円盤に穴を開けたリングは外周 1 つ + 穴 1 つ', () => {
    const cx = 50;
    const cy = 50;
    const img = makeImage(100, 100, (x, y) => {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      return r <= 40 && r > 20;
    });
    const { groups } = run(img, { tolerance: 0.8 });
    expect(groups).toHaveLength(1);
    expect(groups[0].holes).toHaveLength(1);
    expect(near(groups[0].outer.signedArea, Math.PI * 40 * 40, 0.04)).toBe(true);
    expect(near(-groups[0].holes[0].signedArea, Math.PI * 20 * 20, 0.05)).toBe(true);
    expect(groups[0].holes[0].isHole).toBe(true);
    expect(groups[0].holes[0].depth).toBe(1);
  });

  it('穴を取り込まない設定では穴を返さない', () => {
    const img = makeImage(50, 50, (x, y) => x >= 5 && x < 45 && y >= 5 && y < 45 && !(x >= 20 && x < 30 && y >= 20 && y < 30));
    expect(run(img).groups[0].holes).toHaveLength(1);
    expect(run(img, { includeHoles: false }).groups[0].holes).toHaveLength(0);
  });

  it('離れた 2 つの塊は外周 2 つ', () => {
    const img = makeImage(80, 40, (x, y) => (x >= 5 && x < 25 && y >= 10 && y < 30) || (x >= 45 && x < 70 && y >= 10 && y < 20));
    const { groups } = run(img);
    expect(groups).toHaveLength(2);
    expect(groups[0].outer.signedArea).toBeGreaterThan(groups[1].outer.signedArea); // 面積の大きい順
    expect(near(groups[0].outer.signedArea, 400, 0.01)).toBe(true);
    expect(near(groups[1].outer.signedArea, 250, 0.01)).toBe(true);
  });

  it('穴の中の島は別の外周になり、深さ 2 になる', () => {
    const img = makeImage(60, 60, (x, y) => {
      const inOuter = x >= 5 && x < 55 && y >= 5 && y < 55;
      const inHole = x >= 15 && x < 45 && y >= 15 && y < 45;
      const inIsland = x >= 25 && x < 35 && y >= 25 && y < 35;
      return (inOuter && !inHole) || inIsland;
    });
    const { groups } = run(img);
    expect(groups).toHaveLength(2);
    expect(groups[0].outer.depth).toBe(0);
    expect(groups[0].holes).toHaveLength(1);
    expect(groups[1].outer.depth).toBe(2);
    expect(groups[1].holes).toHaveLength(0);
    // 島は穴より後ろに並ぶ
    const shapes = toShapes(groups, { scaleMPerPx: 0.001, originX: 0, originY: 0, imageHeight: 60, materialId: 'al6061' });
    expect(shapes.map((s) => s.role)).toEqual(['solid', 'hole', 'solid']);
  });

  it('斜めに接する画素は 1 つの塊（8 近傍）', () => {
    const mask = new Uint8Array(16);
    mask[0 * 4 + 0] = 1;
    mask[1 * 4 + 1] = 1;
    mask[2 * 4 + 2] = 1;
    const cs = traceContours(mask, 4, 4);
    expect(cs).toHaveLength(1);
    expect(cs[0].signedArea).toBeCloseTo(3, 6);
  });

  it('すべての輪郭の面積の合計 = 物体の画素数（外周 − 穴）', () => {
    const img = makeImage(70, 70, (x, y) => {
      const r = Math.hypot(x - 35, y - 35);
      return (r < 30 && r > 12) || (x > 30 && x < 40 && y > 30 && y < 40);
    });
    const gray = toGray(img);
    const mask = binarize(gray, 128);
    const cs = traceContours(mask, 70, 70);
    const sum = cs.reduce((a, c) => a + c.signedArea, 0);
    expect(sum).toBeCloseTo(mask.reduce((a, b) => a + b, 0), 6);
  });
});

describe('ノイズ除去', () => {
  it('小さな点（ごま塩ノイズ）を除去して本体だけが残る', () => {
    const specks = [
      [3, 3],
      [50, 5],
      [8, 40],
      [55, 45],
      [30, 3],
    ];
    const img = makeImage(60, 50, (x, y) => (x >= 15 && x < 45 && y >= 12 && y < 38) || specks.some(([sx, sy]) => x === sx && y === sy));
    // 除去なし（minArea=1）では 6 個
    const raw = traceMask(binarize(toGray(img), 128), 60, 50, { tolerance: 0, minArea: 1, includeHoles: true });
    expect(raw).toHaveLength(6);
    const { groups } = run(img, { minArea: 10 });
    expect(groups).toHaveLength(1);
    expect(near(groups[0].outer.signedArea, 30 * 26, 0.01)).toBe(true);
  });

  it('removeSmallSpecks は面積しきい値未満の塊だけを消す', () => {
    const mask = new Uint8Array(10 * 10);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) mask[y * 10 + x] = 1; // 16
    mask[7 * 10 + 7] = 1; // 1
    mask[8 * 10 + 8] = 1; // 斜めに接する → 2 画素の塊
    const r = removeSmallSpecks(mask, 10, 10, 5);
    expect(r.reduce((a, b) => a + b, 0)).toBe(16);
  });

  it('オープニングは細い突起を消し、クロージングは小さな隙間を埋める', () => {
    const w = 30;
    const h = 30;
    const body = (x: number, y: number) => x >= 8 && x < 22 && y >= 8 && y < 22;
    const withSpur = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) withSpur[y * w + x] = body(x, y) || (y === 15 && x >= 22 && x < 28) ? 1 : 0;
    const opened = morphOpen(withSpur, w, h, 1);
    expect(opened[15 * w + 26]).toBe(0);
    expect(opened[15 * w + 15]).toBe(1);

    const withGap = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) withGap[y * w + x] = body(x, y) && !(x === 15 && y === 15) ? 1 : 0;
    const closed = morphClose(withGap, w, h, 1);
    expect(closed[15 * w + 15]).toBe(1);
  });
});

describe('座標変換とスケール', () => {
  it('画像座標（y 下向き）→ メートル（y 上向き）に反転・拡大される', () => {
    // 画像 100 x 50 の左下寄りに 20 x 10 の長方形（x:10..30, y:30..40）
    const img = makeImage(100, 50, (x, y) => x >= 10 && x < 30 && y >= 30 && y < 40);
    const { groups } = run(img);
    const s = 0.002; // 1 画素 = 2 mm
    const shapes = toShapes(groups, { scaleMPerPx: s, originX: 1, originY: 2, flipY: true, imageHeight: 50, materialId: 'al6061', namePrefix: '部品' });
    expect(shapes).toHaveLength(1);
    expect(shapes[0].name).toBe('部品');
    const g = shapes[0].geom;
    expect(g.kind).toBe('polygon');
    if (g.kind !== 'polygon') return;
    const xs = g.points.map((p) => p[0]);
    const ys = g.points.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(1 + 10 * s, 9);
    expect(Math.max(...xs)).toBeCloseTo(1 + 30 * s, 9);
    // 画像の下端(y=50)が origin、上に行くほど大きい。長方形の下辺は画像 y=40 → 高さ 10 画素
    expect(Math.min(...ys)).toBeCloseTo(2 + 10 * s, 9);
    expect(Math.max(...ys)).toBeCloseTo(2 + 20 * s, 9);
    expect(signedArea(g.points)).toBeGreaterThan(0); // 反時計回りにそろう
    expect(Math.abs(signedArea(g.points))).toBeCloseTo(20 * 10 * s * s, 9);
  });

  it('flipY=false なら y は反転しない', () => {
    const img = makeImage(20, 20, (x, y) => x >= 2 && x < 6 && y >= 3 && y < 9);
    const { groups } = run(img, { minArea: 1 });
    const [s] = toShapes(groups, { scaleMPerPx: 1, originX: 0, originY: 0, flipY: false, imageHeight: 20, materialId: 'pla' });
    if (s.geom.kind !== 'polygon') throw new Error();
    const ys = s.geom.points.map((p) => p[1]);
    expect(Math.min(...ys)).toBe(3);
    expect(Math.max(...ys)).toBe(9);
  });

  it('穴は外周の直後に role=hole で並ぶ。role が solid 以外なら穴は出さない', () => {
    const img = makeImage(50, 50, (x, y) => x >= 5 && x < 45 && y >= 5 && y < 45 && !(x >= 20 && x < 30 && y >= 20 && y < 30));
    const { groups } = run(img);
    const o = { scaleMPerPx: 0.001, originX: 0, originY: 0, imageHeight: 50, materialId: 'al6061' };
    const a = toShapes(groups, o);
    expect(a.map((s) => s.role)).toEqual(['solid', 'hole']);
    expect(new Set(a.map((s) => s.id)).size).toBe(2);
    const b = toShapes(groups, { ...o, role: 'heatSource' });
    expect(b.map((s) => s.role)).toEqual(['heatSource', 'hole']);
    expect(b[0].heatW).toBe(5);
    expect(toShapes(groups, { ...o, role: 'fixedTemp' }).map((s) => s.role)).toEqual(['fixedTemp']);
    expect(toShapes(groups, { ...o, includeHoles: false }).map((s) => s.role)).toEqual(['solid']);
  });

  it('実寸の幅から 1 画素あたりのメートルを求める', () => {
    expect(scaleFromWidth(100, 200)).toBeCloseTo(0.0005, 12);
    expect(scaleFromWidth(0, 200)).toBe(0);
    expect(scaleFromWidth(100, 0)).toBe(0);
    // 物体の外接矩形の幅(30 画素)を 60 mm にすると、出力ポリゴンの幅がちょうど 60 mm
    const img = makeImage(100, 50, (x, y) => x >= 10 && x < 40 && y >= 10 && y < 30);
    const { groups } = run(img);
    const bb = groupsBBox(groups)!;
    const s = scaleFromWidth(60, bb.maxX - bb.minX);
    const [shape] = toShapes(groups, { scaleMPerPx: s, originX: 0, originY: 0, imageHeight: 50, materialId: 'pla' });
    if (shape.geom.kind !== 'polygon') throw new Error();
    const xs = shape.geom.points.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.06, 9);
  });

  it('centeredOrigin で物体の中心が解析領域の中央に来る', () => {
    const img = makeImage(100, 50, (x, y) => x >= 10 && x < 40 && y >= 10 && y < 30);
    const { groups } = run(img);
    const bb = groupsBBox(groups)!;
    const s = 0.01;
    const domain = { width: 2, height: 1 };
    const { originX, originY } = centeredOrigin(bb, 50, s, domain);
    const [shape] = toShapes(groups, { scaleMPerPx: s, originX, originY, imageHeight: 50, materialId: 'pla' });
    if (shape.geom.kind !== 'polygon') throw new Error();
    const xs = shape.geom.points.map((p) => p[0]);
    const ys = shape.geom.points.map((p) => p[1]);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(1, 9);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(0.5, 9);
  });

  it('defaultWidthMm は領域の約 60% に収まる', () => {
    // 横長の領域・正方形の物体 → 高さが制約になる
    expect(defaultWidthMm({ width: 2, height: 1 }, 1)).toBeCloseTo(600, 0);
    // 横長の物体 → 幅が制約になる
    expect(defaultWidthMm({ width: 2, height: 1 }, 4)).toBeCloseTo(1200, 0);
  });
});

describe('間引き', () => {
  it('円は許容誤差を大きくすると頂点が減り、面積は大きく変わらない', () => {
    const img = makeImage(120, 120, (x, y) => Math.hypot(x + 0.5 - 60, y + 0.5 - 60) <= 50);
    const fine = run(img, { tolerance: 0.5 }).groups[0].outer;
    const coarse = run(img, { tolerance: 3 }).groups[0].outer;
    expect(coarse.points.length).toBeLessThan(fine.points.length);
    expect(near(coarse.signedArea, Math.PI * 2500, 0.06)).toBe(true);
    expect(near(fine.signedArea, Math.PI * 2500, 0.03)).toBe(true);
  });
});
