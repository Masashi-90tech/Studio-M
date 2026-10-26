import { describe, expect, it } from 'vitest';
import { getMaterial } from '../core/materials';
import { autoGrid } from '../core/auto';
import { rasterize } from '../core/raster';
import { createFlowSolver } from '../solvers/flow';
import { getWorkbench } from '../workbench';
import { polygonArea } from './geometry';
import { beamHandCalc, halfWaveThicknessMm, nacaAirfoil, PRESETS } from './presets';
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
  it('11 個あり、ID が重ならない', () => {
    expect(PRESETS).toHaveLength(11);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(11);
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
    expect(p.domain).toEqual({ width: 2, height: 1, nx: 200, autoGrid: true });
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

  it('格子は片持ち梁と、細いフィンのあるファン冷却だけ手動で固定し、ほかは自動', () => {
    for (const pr of PRESETS) {
      const p = pr.build();
      expect(p.domain.autoGrid, pr.id).toBe(pr.id === 'cantilever' || pr.id === 'fan-heatsink' ? false : true);
    }
  });

  it('ファンで冷やすヒートシンク: 温度を計算する流れのプリセットで、アルミのフィンと上限温度つきの発熱部品がある', () => {
    const pr = PRESETS.find((x) => x.id === 'fan-heatsink')!;
    expect(pr.analysis).toBe('flow');
    const p = pr.build();
    expect(p.flow.thermal).toEqual({ enabled: true, inletTempC: 25 });
    expect(p.flow.inletVelocity).toBeGreaterThan(0);
    expect(p.flow.walls).toBe('noslip'); // ダクトの中
    const fins = p.shapes.filter((s) => s.role === 'solid' && s.name.startsWith('フィン'));
    expect(fins.length).toBeGreaterThanOrEqual(4);
    for (const f of [...fins, p.shapes.find((s) => s.name === 'ベース')!]) expect(f.materialId).toBe('al6061');
    const chip = p.shapes.find((s) => s.role === 'heatSource')!;
    expect(chip.heatW).toBe(8);
    expect(chip.maxTempC).toBe(85);
    // 格子化しても発熱が保存され、いちばん細いフィン（3 mm）が 3 セル以上で切れる
    const r = rasterize(p);
    expect(sum(r.heatGen) * r.h * r.h * p.thickness).toBeCloseTo(8, 3);
    expect(0.003 / r.h).toBeGreaterThanOrEqual(3);
    // 流れのワークベンチの先頭は、契約テストが使うカルマン渦のまま
    expect(getWorkbench('flow')!.presets).toEqual(['karman', 'naca0012', 'fan-heatsink']);
    // 温度も計算しているときは、まず温度を見せる（流れだけなら流速のまま）
    expect(getWorkbench('flow')!.defaultFieldFor?.(p)).toBe('temp');
    expect(getWorkbench('flow')!.defaultFieldFor?.(PRESETS.find((x) => x.id === 'karman')!.build())).toBeUndefined();
  });

  it('ファンで冷やすヒートシンクは、少し動かしても温度が出て、部品ごとの結果にチップが載る', () => {
    const p = PRESETS.find((x) => x.id === 'fan-heatsink')!.build();
    const solver = createFlowSolver(p, rasterize(p));
    solver.step(150);
    const res = solver.result();
    const temp = res.fields.find((f) => f.key === 'temp')!;
    expect(temp).toBeDefined();
    expect(Array.from(temp.data).every((v) => Number.isFinite(v))).toBe(true);
    expect(res.perShape?.map((s) => s.label)).toEqual(['発熱する部品 (8 W)']);
  });

  it('電磁波の点波源は、どのプリセットでも解析範囲の中にある', () => {
    for (const pr of PRESETS) {
      const p = pr.build();
      expect(p.em.pointX, pr.id).toBeGreaterThan(0);
      expect(p.em.pointX, pr.id).toBeLessThan(p.domain.width);
      expect(p.em.pointY, pr.id).toBeGreaterThan(0);
      expect(p.em.pointY, pr.id).toBeLessThan(p.domain.height);
    }
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

  describe('電磁波のプリセット', () => {
    const get = (id: string) => PRESETS.find((x) => x.id === id)!;

    it('レーダーカバー: 24 GHz・PLA・厚み 3.7 mm は半波長に近く、PML から離れている', () => {
      const pr = get('radar-cover');
      const p = pr.build();
      expect(pr.analysis).toBe('em');
      expect(p.em).toMatchObject({ frequencyGHz: 24, source: 'plane', angleDeg: 0, polarization: 'TM' });
      expect(p.domain.width).toBeCloseTo(0.12, 9);
      expect(p.domain.height).toBeCloseTo(0.08, 9);
      const s = p.shapes[0];
      expect(s.materialId).toBe('pla');
      expect(s.geom.kind).toBe('rect');
      if (s.geom.kind !== 'rect') return;
      expect(s.geom.w).toBeCloseTo(0.0037, 9);
      expect(s.geom.x + s.geom.w / 2).toBeCloseTo(0.05, 9);
      expect(halfWaveThicknessMm(24, getMaterial('pla').epsR!)).toBeCloseTo(3.74, 1);
      // 吸収境界（既定 12 セル）の外側に収まる
      const g = autoGrid(p, 'em');
      expect(s.geom.y).toBeGreaterThan(12 * g.h);
      expect(s.geom.y + s.geom.h).toBeLessThan(p.domain.height - 12 * g.h);
      expect(s.geom.x).toBeGreaterThan(12 * g.h);
    });

    it('金属板: アルミ板が 10 GHz の平面波を半分だけさえぎる', () => {
      const p = get('metal-shadow').build();
      expect(p.em.frequencyGHz).toBe(10);
      const s = p.shapes[0];
      expect(getMaterial(s.materialId).conductor).toBe(true);
      if (s.geom.kind !== 'rect') throw new Error('rect expected');
      // 板は領域の高さの一部だけ（全部は塞がない）
      expect(s.geom.h).toBeLessThan(p.domain.height * 0.6);
      expect(s.geom.h).toBeGreaterThan(p.domain.height * 0.3);
    });

    it('Wi-Fi の部屋: 点波源は部屋の中、格子は上限に収まる', () => {
      const p = get('wifi-room').build();
      expect(p.em).toMatchObject({ frequencyGHz: 2.4, source: 'point' });
      const g = autoGrid(p, 'em');
      expect(g.nx).toBeLessThanOrEqual(500);
      expect(g.nx * g.ny).toBeLessThanOrEqual(200_000);
      // 壁の中でも 1 波長あたり 10 セル以上
      const lambdaMin = 299792458 / 2.4e9 / Math.sqrt(getMaterial('concrete').epsR!);
      expect(lambdaMin / g.h).toBeGreaterThanOrEqual(10); // ソルバーが警告を出さない下限
      // 点波源は内寸（壁の内側）の中
      expect(p.em.pointX).toBeGreaterThan(0.2);
      expect(p.em.pointX).toBeLessThan(2.4);
      expect(p.em.pointY).toBeGreaterThan(0.2);
      expect(p.em.pointY).toBeLessThan(1.7);
      // 出入口がある（右の壁の上下の部分の間に隙間）
      const lower = p.shapes.find((s) => s.name === '壁（右・下側）')!.geom;
      const upper = p.shapes.find((s) => s.name === '壁（右・上側）')!.geom;
      if (lower.kind !== 'rect' || upper.kind !== 'rect') throw new Error('rect expected');
      expect(upper.y - (lower.y + lower.h)).toBeCloseTo(0.9, 6);
      expect(p.shapes.some((s) => s.materialId === 'wood')).toBe(true);
      expect(p.shapes.every((s) => ['concrete', 'wood'].includes(s.materialId))).toBe(true);
    });
  });
});
