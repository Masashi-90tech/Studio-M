import { makeProject, rect, shape } from '../calculix/test-projects';
import { bodyShapeAt, buildGeo, cleanPolygon, geomArea, geomBox, inDomain } from './shapes';

const circle = (cx: number, cy: number, r: number) => ({ kind: 'circle' as const, cx, cy, r });

// 0.3 × 0.1 m の帯板。中央に直径 20 mm の穴、左端を支持、右端に荷重
const plate = (extra: ReturnType<typeof shape>[] = []) =>
  makeProject({
    width: 0.3,
    height: 0.1,
    nx: 120,
    thickness: 0.01,
    shapes: [
      shape('solid', rect(0, 0, 0.3, 0.1)),
      shape('hole', circle(0.15, 0.05, 0.01)),
      shape('support', rect(0, 0, 0.01, 0.1)),
      shape('load', rect(0.29, 0, 0.01, 0.1), { force: { fx: 100, fy: 0 } }),
      ...extra,
    ],
  });

describe('bodyShapeAt（後のものが前を上書きする）', () => {
  it('穴の中は物体なし、外は固体の番号。支持・荷重は物体を作らない', () => {
    const p = plate();
    expect(bodyShapeAt(p, 0.15, 0.05)).toBe(-1); // 穴の中
    expect(bodyShapeAt(p, 0.05, 0.05)).toBe(0);
    expect(bodyShapeAt(p, 0.005, 0.05)).toBe(0); // 支持の範囲でも物体は固体のまま
    expect(bodyShapeAt(p, 0.5, 0.5)).toBe(-1); // 何もない
  });

  it('穴の後に置いた固体は、穴を埋める。固体の後に置いた別の固体は、前を上書きして材料を決める', () => {
    const p = plate([shape('solid', circle(0.15, 0.05, 0.005), { materialId: 'al6061' }), shape('solid', rect(0.1, 0, 0.02, 0.1), { materialId: 'pla' })]);
    expect(bodyShapeAt(p, 0.15, 0.05)).toBe(4); // 穴の中に置いたアルミの円
    expect(bodyShapeAt(p, 0.15, 0.057)).toBe(-1); // 穴の残り
    expect(bodyShapeAt(p, 0.11, 0.05)).toBe(5); // PLA の帯
    expect(p.shapes[bodyShapeAt(p, 0.11, 0.05)].materialId).toBe('pla');
  });

  it('領域の内外', () => {
    const p = plate();
    expect(inDomain(p, 0.3, 0.1)).toBe(true);
    expect(inDomain(p, 0.31, 0.05)).toBe(false);
    expect(inDomain(p, -0.001, 0.05)).toBe(false);
  });
});

describe('形の寸法', () => {
  it('面積・外接矩形。使えない形は面積 0', () => {
    expect(geomArea(rect(0, 0, 0.2, 0.1))).toBeCloseTo(0.02, 12);
    expect(geomArea(circle(0, 0, 0.01))).toBeCloseTo(Math.PI * 1e-4, 12);
    expect(geomArea({ kind: 'polygon', points: [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]] })).toBeCloseTo(1, 12);
    expect(geomArea({ kind: 'polygon', points: [[0, 0], [1, 0]] })).toBe(0);
    expect(geomArea(rect(0, 0, 0, 1))).toBe(0);
    expect(geomArea(circle(0, 0, 0))).toBe(0);
    expect(geomBox(circle(1, 2, 0.5))).toEqual({ x0: 0.5, y0: 1.5, x1: 1.5, y1: 2.5 });
  });

  it('多角形の頂点: 同じ点の連続と、始点と同じ終点を除く', () => {
    expect(cleanPolygon([[0, 0], [0, 0], [1, 0], [1, 1], [0, 0]])).toEqual([[0, 0], [1, 0], [1, 1]]);
  });
});

describe('buildGeo', () => {
  it('穴のある板: OpenCASCADE で Rectangle・Disk を作り、BooleanFragments で分割し、2 次の三角形の設定を書く', () => {
    const p = plate();
    const plan = buildGeo({ project: p, size: 0.0025 });
    expect(plan.shapeIndexes).toEqual([0, 1, 2, 3]);
    expect(plan.usesDomain).toBe(false);
    expect(plan.geo).toContain('SetFactory("OpenCASCADE");');
    expect(plan.geo.match(/Rectangle\(/g)).toHaveLength(3); // 固体・支持・荷重
    expect(plan.geo.match(/Disk\(/g)).toHaveLength(1); // 穴
    expect(plan.geo).toContain('Disk(sf1) = {0.15, 0.05, 0, 0.01, 0.01};');
    expect(plan.geo).toContain('Rectangle(sf0) = {0, 0, 0, 0.3, 0.1};');
    expect(plan.geo).toContain('BooleanFragments{ Surface{sf0, sf1, sf2, sf3}; Delete; }{}');
    expect(plan.geo).toContain('Mesh.MeshSizeMax = 0.0025;');
    expect(plan.geo).toContain('Mesh.MeshSizeFromCurvature = 20;');
    expect(plan.geo).toContain('Mesh.ElementOrder = 2;');
    expect(plan.bodyAreaUpper).toBeCloseTo(0.03, 12);
  });

  it('多角形は Point + Line + Curve Loop + Plane Surface にする（同じ点の連続は除く）', () => {
    const p = makeProject({
      width: 1,
      height: 1,
      nx: 20,
      thickness: 0.01,
      shapes: [shape('solid', { kind: 'polygon', points: [[0, 0], [0.5, 0], [0.5, 0], [0.5, 0.4], [0, 0.4], [0, 0]] }), shape('support', rect(0, 0, 0.1, 0.4))],
    });
    const plan = buildGeo({ project: p, size: 0.05 });
    expect(plan.geo.match(/Point\(/g)).toHaveLength(4);
    expect(plan.geo.match(/Line\(/g)).toHaveLength(4);
    expect(plan.geo).toContain('Curve Loop(sf0c)');
    expect(plan.geo).toContain('Plane Surface(sf0) = {sf0c};');
    expect(plan.geo).toContain('BooleanFragments{ Surface{sf0, sf1}; Delete; }{}');
  });

  it('関係のない形は入れない: 物体と重ならない穴・支持・荷重、面積のない形', () => {
    const p = plate([
      shape('hole', circle(0.2, 0.5, 0.01)), // 板の外
      shape('support', rect(0.5, 0.5, 0.01, 0.01)), // 板の外
      shape('load', rect(0.1, 0.5, 0.01, 0.01), { force: { fx: 1, fy: 0 } }),
      shape('solid', rect(0, 0, 0, 0.1)), // 幅 0
    ]);
    expect(buildGeo({ project: p, size: 0.0025 }).shapeIndexes).toEqual([0, 1, 2, 3]);
  });

  it('穴は、それより前の物体と重なるものだけ入れる（後ろの固体にしか重ならない穴は効かない）', () => {
    const p = makeProject({
      width: 1,
      height: 1,
      nx: 20,
      thickness: 0.01,
      shapes: [shape('hole', rect(0.5, 0.5, 0.1, 0.1)), shape('solid', rect(0.4, 0.4, 0.3, 0.3)), shape('support', rect(0.4, 0.4, 0.05, 0.3))],
    });
    expect(buildGeo({ project: p, size: 0.05 }).shapeIndexes).toEqual([1, 2]);
  });

  it('物体が領域からはみ出すときは、領域の矩形でも分割する', () => {
    const p = makeProject({
      width: 0.2,
      height: 0.1,
      nx: 20,
      thickness: 0.01,
      shapes: [shape('solid', rect(0, 0, 0.3, 0.1)), shape('support', rect(0, 0, 0.02, 0.1))],
    });
    const plan = buildGeo({ project: p, size: 0.01 });
    expect(plan.usesDomain).toBe(true);
    expect(plan.geo).toContain('Rectangle(sf2) = {0, 0, 0, 0.2, 0.1};');
    expect(plan.geo).toContain('Surface{sf0, sf1, sf2}');
  });

  it('物体がなければ空の計画を返す。寸法がおかしければエラー', () => {
    const p = makeProject({ width: 1, height: 1, nx: 10, thickness: 0.01, shapes: [shape('support', rect(0, 0, 0.1, 0.1))] });
    expect(buildGeo({ project: p, size: 0.1 })).toMatchObject({ geo: '', shapeIndexes: [] });
    expect(() => buildGeo({ project: plate(), size: 0 })).toThrow('寸法');
  });

  it('プロジェクトの文字列（形の名前）は .geo に入らない', () => {
    const p = plate();
    p.shapes[0].name = 'evil"; Exit; //';
    p.shapes[0].id = 'x\nExit;';
    const plan = buildGeo({ project: p, size: 0.0025 });
    expect(plan.geo).not.toContain('evil');
    expect(plan.geo).not.toContain('Exit');
  });

  it('数値は指数表記でも壊れない（小さい寸法）', () => {
    const p = makeProject({ width: 1e-5, height: 1e-5, nx: 10, thickness: 1e-6, shapes: [shape('solid', rect(0, 0, 1e-5, 1e-5))] });
    expect(buildGeo({ project: p, size: 1e-6 }).geo).toContain('Rectangle(sf0) = {0, 0, 0, 0.00001, 0.00001};');
  });
});
