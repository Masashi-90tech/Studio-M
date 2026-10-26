import { stripMesh } from '../gmsh/test-meshes';
import { GRAVITY, MeshError } from './mesh';
import { buildShapedMesh } from './gmsh-mesh';
import { shapeP2 } from './p2';
import { makeProject, rect, shape } from './test-projects';

// 0.4 × 0.2 m の板。メッシュは 4 × 2 セル（セル 0.1 m）を 2 つずつの三角形にした 16 要素。格子は 0.01 m（40 × 20 セル）
const project = (extra: ReturnType<typeof shape>[] = [], over: { selfWeight?: boolean } = {}) =>
  makeProject({
    width: 0.4,
    height: 0.2,
    nx: 40,
    thickness: 0.01,
    selfWeight: over.selfWeight,
    shapes: [
      shape('solid', rect(0, 0, 0.4, 0.2)),
      shape('solid', rect(0.2, 0, 0.2, 0.2), { materialId: 'al6061' }),
      shape('support', rect(0, 0, 0.1, 0.2)),
      shape('load', rect(0.3, 0, 0.1, 0.2), { force: { fx: 200, fy: -1000 } }),
      ...extra,
    ],
  });
const grid = { nx: 40, ny: 20, h: 0.01 };
const strip = () => stripMesh({ w: 0.4, h: 0.2, nx: 4, ny: 2 });

const signedArea = (m: ReturnType<typeof buildShapedMesh>, e: number): number => {
  const p = (a: number) => [m.coords[2 * (m.connectivity[6 * e + a] - 1)], m.coords[2 * (m.connectivity[6 * e + a] - 1) + 1]];
  const [a, b, c] = [p(0), p(1), p(2)];
  return ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
};

describe('buildShapedMesh', () => {
  it('要素・節点・材料・質量: 材料の境目（x = 0.2）で材料が分かれる', () => {
    const m = buildShapedMesh({ project: project(), gmsh: strip(), grid });
    expect(m.elementType).toBe('CPS6');
    expect(m.nodesPerElement).toBe(6);
    expect(m.elementCount).toBe(16);
    expect(m.nodeCount).toBe(9 * 5);
    expect(m.connectivity.length).toBe(16 * 6);
    expect(m.materials.map((x) => x.material.id)).toEqual(['ss400', 'al6061']);
    expect(m.materials[0].elements).toHaveLength(8);
    expect(m.materials[1].elements).toHaveLength(8);
    expect(m.mass).toBeCloseTo((7850 * 0.2 * 0.2 + 2700 * 0.2 * 0.2) * 0.01, 9);
    expect(m.area).toBeCloseTo(0.08, 12);
    // 材料 1 の要素は x < 0.2
    for (const e of m.materials[0].elements) {
      const x = m.coords[2 * (m.connectivity[6 * (e - 1)] - 1)];
      expect(x).toBeLessThan(0.2 - 1e-12);
    }
  });

  it('支持の範囲の要素の全節点が固定される（x ≤ 0.1 の 3 列 × 5 行）', () => {
    const m = buildShapedMesh({ project: project(), gmsh: strip(), grid });
    expect(m.supportNodes).toHaveLength(15);
    for (const n of m.supportNodes) expect(m.coords[2 * (n - 1)]).toBeLessThanOrEqual(0.1 + 1e-12);
  });

  it('荷重は、範囲の中の要素に面積に比例して配り、合計が一致する。要素の角には載せず、辺の中点だけ', () => {
    const m = buildShapedMesh({ project: project(), gmsh: strip(), grid });
    let fx = 0;
    let fy = 0;
    for (const [n, f] of m.nodalLoads) {
      fx += f.fx;
      fy += f.fy;
      // 角の節点は格子の偶数番目（0.1 m 刻み）の位置。荷重は辺の中点（0.05 m 刻みの奇数番目を含む位置）だけ
      const ix = Math.round(m.coords[2 * (n - 1)] / 0.05);
      const iy = Math.round(m.coords[2 * (n - 1) + 1] / 0.05);
      expect(ix % 2 === 0 && iy % 2 === 0).toBe(false);
      expect(m.coords[2 * (n - 1)]).toBeGreaterThanOrEqual(0.3 - 1e-12);
    }
    expect(fx).toBeCloseTo(200, 9);
    expect(fy).toBeCloseTo(-1000, 9);
    expect(m.appliedLoad).toBeCloseTo(1200, 9);
  });

  it('自重: 全要素の重さが辺の中点に下向きに載る（支持の中にも）', () => {
    const p = project([], { selfWeight: true });
    p.shapes = p.shapes.filter((s) => s.role !== 'load');
    const m = buildShapedMesh({ project: p, gmsh: strip(), grid, selfWeight: true });
    let fy = 0;
    for (const f of m.nodalLoads.values()) fy += f.fy;
    expect(fy).toBeCloseTo(-m.mass * GRAVITY, 9);
    expect(m.appliedLoad).toBe(0);
  });

  it('時計回りの三角形は、向きを直す（全要素の向きが反時計回り）', () => {
    const cw = stripMesh({ w: 0.4, h: 0.2, nx: 4, ny: 2, clockwise: true });
    const m = buildShapedMesh({ project: project(), gmsh: cw, grid });
    for (let e = 0; e < m.elementCount; e++) expect(signedArea(m, e)).toBeGreaterThan(0);
    // 向きを直しても、辺の中点は同じ辺の中点のまま（中点 4 は角 1-2 の真ん中）
    for (let e = 0; e < m.elementCount; e++) {
      for (let a = 0; a < 3; a++) {
        const p = m.connectivity[6 * e + a] - 1;
        const q = m.connectivity[6 * e + (a + 1) % 3] - 1;
        const mid = m.connectivity[6 * e + 3 + a] - 1;
        expect(m.coords[2 * mid]).toBeCloseTo((m.coords[2 * p] + m.coords[2 * q]) / 2, 12);
        expect(m.coords[2 * mid + 1]).toBeCloseTo((m.coords[2 * p + 1] + m.coords[2 * q + 1]) / 2, 12);
      }
    }
    expect(m.nodalLoads.size).toBe(buildShapedMesh({ project: project(), gmsh: strip(), grid }).nodalLoads.size);
  });

  it('穴: 穴の中の要素は除く。領域の外の要素も除く', () => {
    const hole = project([shape('hole', { kind: 'circle', cx: 0.25, cy: 0.1, r: 0.04 })]);
    const holed = buildShapedMesh({ project: hole, gmsh: strip(), grid });
    expect(holed.elementCount).toBeLessThan(16);
    expect(holed.mass).toBeLessThan(buildShapedMesh({ project: project(), gmsh: strip(), grid }).mass);
    // 領域を x ≤ 0.3 までにすると、右の 1 列が外になる（荷重の範囲 0.3〜0.4 は物体と重ならなくなる）
    const small = project();
    small.domain.width = 0.3;
    const m = buildShapedMesh({ project: small, gmsh: strip(), grid: { nx: 30, ny: 20, h: 0.01 } });
    expect(m.elementCount).toBe(12);
    expect(m.appliedLoad).toBe(0);
  });

  it('セルの中心がどの要素のどこにあるか: 形状関数で戻すと中心の座標になる', () => {
    const m = buildShapedMesh({ project: project(), gmsh: strip(), grid });
    expect(m.included.reduce((s, v) => s + v, 0)).toBe(40 * 20);
    const N = new Array<number>(6).fill(0);
    for (const c of [0, 39, 10 * 40 + 17, 19 * 40 + 3, 40 * 20 - 1]) {
      const e = m.cellElement[c];
      expect(e).toBeGreaterThanOrEqual(0);
      shapeP2(m.cellXi[c], m.cellEta[c], N);
      let x = 0;
      let y = 0;
      for (let a = 0; a < 6; a++) {
        x += N[a] * m.coords[2 * (m.connectivity[6 * e + a] - 1)];
        y += N[a] * m.coords[2 * (m.connectivity[6 * e + a] - 1) + 1];
      }
      expect(x).toBeCloseTo(((c % 40) + 0.5) * 0.01, 10);
      expect(y).toBeCloseTo((Math.floor(c / 40) + 0.5) * 0.01, 10);
    }
    // 穴のあるセルは含まない
    const holed = buildShapedMesh({ project: project([shape('hole', { kind: 'circle', cx: 0.25, cy: 0.1, r: 0.04 })]), gmsh: strip(), grid });
    expect(holed.included[10 * 40 + 25]).toBe(0); // 穴の中心
    expect(holed.included[10 * 40 + 5]).toBe(1);
  });

  it('支持されていない部品は除き、警告を出す。そこに載る荷重は無視する', () => {
    // 左の板（x 0〜0.1、支持あり）と、右の離れた板（x 0.3〜0.4、支持なし・荷重あり）。間は物体なし
    const p = project();
    p.shapes = [shape('solid', rect(0, 0, 0.1, 0.2)), shape('solid', rect(0.3, 0, 0.1, 0.2)), shape('support', rect(0, 0, 0.05, 0.2)), shape('load', rect(0.3, 0, 0.1, 0.2), { force: { fx: 0, fy: -50 } })];
    const m = buildShapedMesh({ project: p, gmsh: strip(), grid });
    expect(m.excludedParts).toBe(1);
    expect(m.elementCount).toBe(4);
    expect(m.excludedElements).toBe(4);
    expect(m.appliedLoad).toBe(0);
    expect(m.ignoredLoad).toBeCloseTo(50, 9);
    expect(m.warnings.some((w) => w.includes('支持されていない部品') && w.includes('除外'))).toBe(true);
    expect(m.warnings.some((w) => w.includes('荷重は無視'))).toBe(true);
    expect(m.mass).toBeCloseTo(7850 * 0.2 * 0.2 * 0.01, 9); // 質量は除いた部品も含む
    expect(m.included[10 * 40 + 35]).toBe(0);
    expect(m.included[10 * 40 + 5]).toBe(1);
  });

  it('支持がない・物体がないときは、日本語の MeshError', () => {
    const noSupport = project();
    noSupport.shapes = noSupport.shapes.filter((s) => s.role !== 'support');
    expect(() => buildShapedMesh({ project: noSupport, gmsh: strip(), grid })).toThrow(MeshError);
    expect(() => buildShapedMesh({ project: noSupport, gmsh: strip(), grid })).toThrow('支持');
    const none = project();
    none.shapes = [shape('support', rect(0, 0, 0.1, 0.2))];
    expect(() => buildShapedMesh({ project: none, gmsh: strip(), grid })).toThrow('物体がありません');
  });

  it('材料の弾性率が未設定なら警告する（弾性率のない材料は流体）', () => {
    const p = project();
    p.shapes[1].materialId = 'wood';
    const m = buildShapedMesh({ project: p, gmsh: strip(), grid });
    expect(m.warnings.some((w) => w.includes('未設定'))).toBe(false); // 木材は E・nu がある
    p.shapes[1].materialId = 'air';
    expect(buildShapedMesh({ project: p, gmsh: strip(), grid }).warnings.some((w) => w.includes('未設定'))).toBe(true);
  });
});
