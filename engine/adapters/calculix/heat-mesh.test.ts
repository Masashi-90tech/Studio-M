import { rasterize } from '../../../src/core/raster';
import { buildHeatMesh, FACE_NODES } from './heat-mesh';
import { heatPlate, makeProject, mm, rect, shape } from './test-projects';

const build = (p: ReturnType<typeof heatPlate>) => buildHeatMesh({ project: p, raster: rasterize(p) });

// 小さな板: 4 × 2 セル（セル幅 10 mm）、厚さ 2 mm、アルミ。中の 1 セルが 2 W
const small = (extra: ReturnType<typeof shape>[] = [], tweak?: (p: ReturnType<typeof makeProject>) => void) => {
  const p = makeProject({
    width: 0.04,
    height: 0.03,
    nx: 4,
    thickness: 0.002,
    shapes: [shape('solid', rect(0, 0, 0.04, 0.02), { materialId: 'al6061' }), shape('heatSource', rect(0.01, 0.01, 0.01, 0.01), { materialId: 'al6061', heatW: 2 }), ...extra],
  });
  p.heat.surfaceH = 10;
  p.heat.faceCooling = true;
  p.heat.ambientC = 20;
  tweak?.(p);
  return p;
};

describe('buildHeatMesh', () => {
  it('物体セル 1 つ = DC3D8 を 1 要素。節点は上下 2 層', () => {
    const mesh = build(small());
    expect(mesh.elementCell.length).toBe(8);
    expect(mesh.nodeCount).toBe(2 * 15);
    // 要素 1: 下の 4 節点は z = 0、上の 4 節点は z = 厚さ
    const z = [...mesh.connectivity.slice(0, 8)].map((id) => mesh.coords[3 * (id - 1) + 2]);
    expect(z).toEqual([0, 0, 0, 0, 0.002, 0.002, 0.002, 0.002]);
    const x = [...mesh.connectivity.slice(0, 4)].map((id) => mesh.coords[3 * (id - 1)]);
    expect(x).toEqual([0, 0.01, 0.01, 0]);
  });

  it('発熱は体積熱流束 [W/m³] にまとめ、合計が発熱量 W と一致する', () => {
    const mesh = build(small());
    expect(mesh.heatGroups).toHaveLength(1);
    expect(mesh.heatGroups[0].elements).toHaveLength(1);
    expect(mesh.heatGroups[0].qv).toBeCloseTo(2 / (0.01 * 0.01 * 0.002), 3);
    expect(mesh.totalHeat).toBeCloseTo(2, 9);
  });

  it('膜: 表裏は全要素、側面は物体のない隣の面だけ。熱伝達率と周囲温度が付く', () => {
    const mesh = build(small());
    const count = (face: number) => mesh.films.filter((g) => g.face === face).reduce((a, g) => a + g.elements.length, 0);
    expect(count(1)).toBe(8); // 下面（z = 0）
    expect(count(2)).toBe(8); // 上面
    // 板は領域の下端・左右の端に接している（辺は断熱）。膜が付くのは、物体のない隣（上の空き行）に面した北だけ
    expect(count(3)).toBe(0);
    expect(count(4)).toBe(0);
    expect(count(6)).toBe(0);
    expect(count(5)).toBe(4);
    for (const g of mesh.films) {
      expect(g.h).toBe(10);
      expect(g.sink).toBe(20);
    }
  });

  it('faceCooling を切ると表裏の膜はない', () => {
    const mesh = build(small([], (p) => (p.heat.faceCooling = false)));
    expect(mesh.films.some((g) => g.face <= 2)).toBe(false);
  });

  it('固定温度の物体セルは全節点を固定、固定温度の空きセルは接する面の節点を固定する', () => {
    const p = small([shape('fixedTemp', rect(0, 0, 0.01, 0.02), { tempC: 60 } as never), shape('fixedTemp', rect(0.03, 0.02, 0.01, 0.01), { tempC: 5 } as never)]);
    const mesh = build(p);
    const temps = new Map<number, number>();
    for (const [, t] of mesh.fixedNodes) temps.set(t, (temps.get(t) ?? 0) + 1);
    // 左の 1 列 × 2 行の物体セルが 60 °C: 節点は x = 0, 0.01 の 2 列 × 3 行 × 上下 2 層 = 12
    expect(temps.get(60)).toBe(12);
    // 5 °C の空きセルは右上の行の最後の要素の北面に接する: 節点は 2 × 2 層 = 4（そのうち既に固定のものはない）
    expect(temps.get(5)).toBe(4);
    // 固定した物体セルには発熱・膜を付けない
    expect(mesh.films.every((g) => g.elements.every((e) => mesh.elementCell[e - 1] !== 0))).toBe(true);
  });

  it('領域の辺の条件: temp は辺の節点を固定、convection は膜', () => {
    const p = small([], (q) => {
      q.shapes[0] = shape('solid', rect(0, 0, 0.04, 0.03), { materialId: 'al6061' }); // 領域いっぱいの板
      q.heat.edges = { left: { type: 'temp', tempC: 30 }, right: { type: 'convection', h: 50 }, top: { type: 'adiabatic' }, bottom: { type: 'adiabatic' } };
    });
    const mesh = build(p);
    // 左辺: 3 行 → 節点は 4 点 × 上下 2 層 = 8 が 30 °C
    expect([...mesh.fixedNodes.values()].filter((t) => t === 30)).toHaveLength(8);
    const right = mesh.films.find((g) => g.face === 4 && g.h === 50)!;
    expect(right.elements).toHaveLength(3);
  });

  it('熱伝導率: 面内は kEff（あれば）、板厚方向は材料の k。同じ値はまとめる', () => {
    const plain = build(small());
    expect(plain.conductivity).toEqual([{ kx: 167, ky: 167, kz: 167, elements: [1, 2, 3, 4, 5, 6, 7, 8] }]);
    const p = small([], (q) => {
      for (const sh of q.shapes) sh.materialId = 'fr4';
    });
    p.pcb = { source: 'x', boardThicknessMm: 1.6, substrateId: 'fr4', layers: [{ name: 'F.Cu', thicknessUm: 35, polygons: [[[0, 0], [0.04, 0], [0.04, 0.02], [0, 0.02]]] }] };
    const withCu = build(p);
    expect(withCu.usesKEff).toBe(true);
    expect(withCu.conductivity[0].kx).toBeGreaterThan(withCu.conductivity[0].kz); // 銅箔で面内だけ高くなる
    expect(withCu.conductivity[0].kz).toBe(0.3);
    expect(withCu.warnings.join('')).toContain('実効熱伝導率');
  });

  it('放熱経路のない部品は除外して警告（発熱があるとき）。物体全体が浮いていればエラー', () => {
    // 熱の逃げ道は左端の固定温度だけ。離れた発熱体（上の行）には逃げ道がない
    const p = small(
      [
        shape('fixedTemp', rect(0, 0, 0.01, 0.02), { tempC: 30 } as never),
        shape('heatSource', rect(0.01, 0.04, 0.01, 0.01), { materialId: 'al6061', heatW: 1 }),
      ],
      (q) => {
        q.domain.height = 0.05;
        q.heat.surfaceH = 0;
        q.heat.faceCooling = false;
      },
    );
    const mesh = build(p);
    expect(mesh.elementCell.length).toBe(8); // 離れた 1 セルは入らない
    expect(mesh.warnings.join('')).toContain('放熱経路');
    expect(mesh.totalHeat).toBeCloseTo(2, 9); // 浮いた発熱体の 1 W は集計から外れる
    expect(mesh.included[4 * 4 + 1]).toBe(0);

    const none = small([], (q) => {
      q.heat.surfaceH = 0;
    });
    expect(() => build(none)).toThrow('放熱経路');
  });

  it('側面と表裏の面の節点の対応', () => {
    expect(FACE_NODES[0]).toEqual([0, 1, 2, 3]);
    expect(FACE_NODES.flat().length).toBe(24);
  });

  it('プリセット的な板（1 mm 格子）でも組み立てられる', () => {
    const mesh = build(heatPlate());
    expect(mesh.elementCell.length).toBe(80 * 40);
    expect(mesh.totalHeat).toBeCloseTo(5, 5);
    expect(mm(1)).toBe(0.001);
  });
});
