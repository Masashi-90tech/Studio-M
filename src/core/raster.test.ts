import { rasterize, containsPoint } from './raster';
import { defaultProject } from './project';

describe('rasterize', () => {
  it('四角柱の面積が格子で再現される', () => {
    const p = defaultProject();
    const r = rasterize(p);
    expect(r.nx).toBe(200);
    expect(r.ny).toBe(100);
    const count = r.solid.reduce((a, b) => a + b, 0);
    // 0.2m × 0.2m を 0.01m 格子で → 400 セル前後
    expect(count).toBeGreaterThanOrEqual(380);
    expect(count).toBeLessThanOrEqual(441);
  });

  it('穴が物体を削り、荷重は残った物体にだけ配分される', () => {
    const p = defaultProject();
    p.shapes.push({ id: 'h', name: '穴', role: 'hole', materialId: '', geom: { kind: 'circle', cx: 0.55, cy: 0.5, r: 0.05 } });
    p.shapes.push({ id: 'l', name: '荷重', role: 'load', materialId: '', force: { fx: 0, fy: -100 }, geom: { kind: 'rect', x: 0.4, y: 0.4, w: 0.3, h: 0.2 } });
    const r = rasterize(p);
    const c = 50 * r.nx + 55; // 円の中心
    expect(r.solid[c]).toBe(0);
    expect(r.loadFy[c]).toBe(0);
    const total = r.loadFy.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(-100, 3);
  });

  it('発熱量は合計で heatW になる', () => {
    const p = defaultProject();
    p.shapes[0].role = 'heatSource';
    p.shapes[0].heatW = 5;
    const r = rasterize(p);
    let sum = 0;
    for (let c = 0; c < r.heatGen.length; c++) sum += r.heatGen[c] * r.h * r.h * p.thickness;
    expect(sum).toBeCloseTo(5, 3);
  });

  it('多角形の内外判定', () => {
    const tri = { kind: 'polygon' as const, points: [[0, 0], [1, 0], [0, 1]] as [number, number][] };
    expect(containsPoint(tri, 0.2, 0.2)).toBe(true);
    expect(containsPoint(tri, 0.8, 0.8)).toBe(false);
  });
});

describe('copperConductivity', () => {
  it('銅箔のない基板は基材の k、全面ベタは厚さの重み付き平均になる', () => {
    const p = defaultProject();
    p.domain = { width: 0.1, height: 0.05, nx: 50, autoGrid: false };
    p.thickness = 0.0016;
    p.shapes = [{ id: 'b', name: '基板', role: 'solid', materialId: 'fr4', geom: { kind: 'rect', x: 0, y: 0, w: 0.1, h: 0.05 } }];
    const full: [number, number][] = [[0.05, 0], [0.1, 0], [0.1, 0.05], [0.05, 0.05]];
    p.pcb = { source: 't', boardThicknessMm: 1.6, substrateId: 'fr4', layers: [{ name: 'F.Cu', thicknessUm: 35, polygons: [full] }] };
    const r = rasterize(p);
    const left = r.kEff![10 * r.nx + 5];
    const right = r.kEff![10 * r.nx + 40];
    expect(left).toBeCloseTo(0.3, 5);
    // (0.3 × (1.6 − 0.035) + 391 × 0.035) / 1.6 ≈ 8.85
    expect(right).toBeCloseTo((0.3 * (1.6e-3 - 35e-6) + 391 * 35e-6) / 1.6e-3, 3);
  });

  it('shapeIndex は最後に塗った形状を指し、穴は -1 に戻す', () => {
    const p = defaultProject();
    p.shapes.push({ id: 'h', name: '穴', role: 'hole', materialId: '', geom: { kind: 'circle', cx: 0.55, cy: 0.5, r: 0.05 } });
    const r = rasterize(p);
    expect(r.shapeIndex![50 * r.nx + 55]).toBe(-1);
    expect(r.shapeIndex![42 * r.nx + 47]).toBe(0);
  });
});
