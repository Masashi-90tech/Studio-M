import { describe, expect, it } from 'vitest';
import { getMaterial } from '../core/materials';
import { rasterize } from '../core/raster';
import { polygonArea } from './geometry';
import { beamHandCalc, nacaAirfoil, PRESETS } from './presets';
import { sanitizeProject } from './project-utils';

const sum = (a: ArrayLike<number>): number => Array.from(a).reduce((s, v) => s + v, 0);

describe('nacaAirfoil', () => {
  const pts = nacaAirfoil('0012', 1, 0, 0, 0, 40);
  it('点数は 2n - 2', () => {
    expect(pts).toHaveLength(78);
  });
  it('翼弦長 1 の中に収まり、前縁は原点・後縁は x=1', () => {
    const xs = pts.map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(1, 6);
  });
  it('最大厚さは 12% で、翼弦の約 30% の位置', () => {
    const upper = pts.filter((p) => p[1] > 0);
    const top = upper.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(top[1] * 2).toBeCloseTo(0.12, 2);
    expect(top[0]).toBeGreaterThan(0.25);
    expect(top[0]).toBeLessThan(0.35);
  });
  it('対称翼型なので上下対称', () => {
    const ymax = Math.max(...pts.map((p) => p[1]));
    const ymin = Math.min(...pts.map((p) => p[1]));
    expect(ymax).toBeCloseTo(-ymin, 6);
  });
  it('迎角を付けると後縁が下がり、前縁位置は動かない', () => {
    const rot = nacaAirfoil('0012', 0.2, 8, 0.3, 0.5, 40);
    const le = rot.reduce((a, b) => (Math.hypot(b[0] - 0.3, b[1] - 0.5) < Math.hypot(a[0] - 0.3, a[1] - 0.5) ? b : a));
    expect(Math.hypot(le[0] - 0.3, le[1] - 0.5)).toBeLessThan(1e-3);
    expect(rot[0][1]).toBeCloseTo(0.5 - 0.2 * Math.sin((8 * Math.PI) / 180), 4);
    expect(rot[0][0]).toBeCloseTo(0.3 + 0.2 * Math.cos((8 * Math.PI) / 180), 3);
  });
  it('面積は翼弦長の2乗に比例（厚さ12%で約 0.082 c²）', () => {
    expect(polygonArea(pts)).toBeGreaterThan(0.075);
    expect(polygonArea(pts)).toBeLessThan(0.09);
    expect(polygonArea(nacaAirfoil('0012', 0.2, 8, 0, 0, 40))).toBeCloseTo(polygonArea(pts) * 0.04, 5);
  });
  it('キャンバー付き(2412)は上に膨らむ', () => {
    const c = nacaAirfoil('2412', 1, 0, 0, 0, 40);
    const meanY = sum(c.map((p) => p[1])) / c.length;
    expect(meanY).toBeGreaterThan(0.005);
  });
  it('不正な番号は例外', () => {
    expect(() => nacaAirfoil('12', 1, 0, 0, 0)).toThrow();
  });
});

describe('プリセット', () => {
  it('7 つあり、ID が重ならない', () => {
    expect(PRESETS).toHaveLength(7);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(7);
  });

  for (const preset of PRESETS) {
    describe(preset.title, () => {
      const p = preset.build();
      it('説明があり、検証を通る', () => {
        expect(preset.description.length).toBeGreaterThan(5);
        const re = sanitizeProject(JSON.parse(JSON.stringify(p)));
        expect(re).not.toBeNull();
        expect(re!.shapes).toHaveLength(p.shapes.length);
      });
      it('材料IDが実在し、図形が領域内に収まる', () => {
        for (const s of p.shapes) {
          expect(() => getMaterial(s.materialId)).not.toThrow();
          const g = s.geom;
          if (g.kind === 'rect') {
            expect(g.x).toBeGreaterThanOrEqual(0);
            expect(g.x + g.w).toBeLessThanOrEqual(p.domain.width + 1e-9);
            expect(g.y + g.h).toBeLessThanOrEqual(p.domain.height + 1e-9);
          }
        }
        const r = rasterize(p);
        expect(sum(r.solid)).toBeGreaterThan(0);
      });
    });
  }

  it('四角柱は動画と同じ領域とスカラー設定', () => {
    const p = PRESETS[0].build();
    expect(p.domain).toEqual({ width: 2, height: 1, nx: 200 });
    expect(p.scalar).toMatchObject({ u: 1, gamma: 0.1, rho: 1 });
  });

  it('カルマン渦は Re≈150', () => {
    const p = PRESETS.find((x) => x.id === 'karman')!.build();
    const s = p.shapes[0].geom;
    expect(s.kind).toBe('circle');
    const D = s.kind === 'circle' ? 2 * s.r : 0;
    const nu = getMaterial('air').viscosity!;
    expect((p.flow.inletVelocity * D) / nu).toBeCloseTo(150, 0);
    expect(p.flow.walls).toBe('slip');
  });

  it('ヒートシンクの発熱は 10 W で、格子化しても保存される', () => {
    const p = PRESETS.find((x) => x.id === 'heatsink')!.build();
    const r = rasterize(p);
    const W = sum(r.heatGen) * r.h * r.h * p.thickness;
    expect(W).toBeCloseTo(10, 3);
    expect(p.heat.faceCooling).toBe(true);
  });

  it('電子基板は 3 つのチップ（合計 2.2 W）', () => {
    const p = PRESETS.find((x) => x.id === 'board')!.build();
    expect(p.shapes.filter((s) => s.role === 'heatSource')).toHaveLength(3);
    const r = rasterize(p);
    expect(sum(r.heatGen) * r.h * r.h * p.thickness).toBeCloseTo(2.2, 3);
  });

  it('L字ブラケットは穴・支持・荷重が物体に重なる', () => {
    const p = PRESETS.find((x) => x.id === 'l-bracket')!.build();
    const roles = p.shapes.map((s) => s.role);
    expect(roles).toEqual(expect.arrayContaining(['solid', 'hole', 'support', 'load']));
    const r = rasterize(p);
    let supportOnBody = 0;
    for (let c = 0; c < r.solid.length; c++) if (r.solid[c] && r.support[c]) supportOnBody++;
    expect(supportOnBody).toBeGreaterThan(20);
    expect(sum(r.loadFy)).toBeCloseTo(-50, 3);
    // ボルト穴の中心は空洞
    const i = Math.floor(0.021 / r.h);
    const j = Math.floor(0.038 / r.h);
    expect(r.solid[j * r.nx + i]).toBe(0);
  });

  it('片持ち梁の荷重は 100 N で、手計算値はアルミの教科書値', () => {
    const p = PRESETS.find((x) => x.id === 'cantilever')!.build();
    const r = rasterize(p);
    expect(sum(r.loadFy)).toBeCloseTo(-100, 3);
    const hand = beamHandCalc();
    expect(hand.stressMPa).toBeCloseTo(120, 6);
    expect(hand.deflectionMm).toBeGreaterThan(4.6);
    expect(hand.deflectionMm).toBeLessThan(4.8);
  });
});
