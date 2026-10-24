import { describe, expect, it } from 'vitest';
import { autoGrid, resolveProject } from './auto';
import { defaultProject } from './project';
import type { Project, Shape } from './types';

const rect = (name: string, role: Shape['role'], x: number, y: number, w: number, h: number, materialId = 'al6061'): Shape => ({
  id: name,
  name,
  role,
  materialId,
  geom: { kind: 'rect', x, y, w, h },
});

function project(width: number, height: number, shapes: Shape[]): Project {
  const p = defaultProject();
  p.domain = { width, height, nx: 100, autoGrid: true };
  p.shapes = shapes;
  return p;
}

describe('autoGrid: 流れ', () => {
  it('既定の四角柱（高さ 0.2 m、領域幅 2 m）は物体の高さを 32 セルで分割する', () => {
    const g = autoGrid(defaultProject(), 'flow');
    expect(g.nx).toBe(320);
    expect(g.ny).toBe(160);
    expect(g.h).toBeCloseTo(2 / 320, 12);
    expect(g.reason).toContain('物体の高さ 200 mm');
    expect(g.reason).toContain('32 セルで分割');
    expect(g.reason).toContain('流れ');
  });

  it('物体が大きいときも nx は最低 120 を確保する', () => {
    const p = project(1, 0.5, [rect('big', 'solid', 0.2, 0.05, 0.3, 0.4)]);
    const g = autoGrid(p, 'flow'); // 32 セルなら nx = 80
    expect(g.nx).toBe(120);
    expect(g.reason).toContain('最低 120');
  });

  it('物体が小さいと上限 500 で止まり、理由に「上限のため」と書く', () => {
    const p = project(2, 1, [rect('tiny', 'solid', 1, 0.5, 0.01, 0.01)]);
    const g = autoGrid(p, 'flow');
    expect(g.nx).toBe(500);
    expect(g.reason).toContain('上限のため');
    expect(g.reason).toContain('約 3 セル');
  });

  it('縦長の領域ではセル数の上限（約 20 万）が先に効く', () => {
    const p = project(1, 4, [rect('tiny', 'solid', 0.5, 2, 0.01, 0.01)]);
    const g = autoGrid(p, 'flow');
    expect(g.nx).toBeLessThan(500);
    expect(g.nx * g.ny).toBeLessThanOrEqual(200_000);
    expect(g.nx * g.ny).toBeGreaterThan(150_000);
  });

  it('物体がなければ 200', () => {
    const g = autoGrid(project(2, 1, []), 'flow');
    expect(g.nx).toBe(200);
    expect(g.reason).toContain('物体がない');
  });

  it('円・多角形・複数物体の高さは形状から求める（格子化しない）', () => {
    const p = project(2, 1, [
      { id: 'c', name: '円', role: 'solid', materialId: 'al6061', geom: { kind: 'circle', cx: 0.5, cy: 0.3, r: 0.05 } },
      { id: 'p', name: '三角', role: 'heatSource', materialId: 'al6061', heatW: 1, geom: { kind: 'polygon', points: [[1, 0.5], [1.2, 0.5], [1.1, 0.7]] } },
      rect('穴', 'hole', 0, 0, 0.001, 0.9), // 穴・固定温度などは物体の高さに入れない
    ]);
    // 物体の高さ: y = 0.25〜0.7 → 0.45 m
    const g = autoGrid(p, 'flow');
    expect(g.reason).toContain('450 mm');
    expect(g.nx).toBe(Math.max(120, Math.ceil((32 * 2) / 0.45)));
  });
});

describe('autoGrid: スカラー', () => {
  it('物体の高さを約 20 セルで分割する（既定: 高さ 0.2 m → nx = 200）', () => {
    const g = autoGrid(defaultProject(), 'scalar');
    expect(g.nx).toBe(200);
    expect(g.reason).toContain('20 セル');
    expect(g.reason).toContain('スカラー');
  });
});

describe('autoGrid: 熱・強度', () => {
  it('熱は最も細い部位を 4 セル以上で分割する（細い穴が最小）', () => {
    const p = project(1, 0.5, [rect('板', 'solid', 0.1, 0.1, 0.8, 0.3), rect('スリット', 'hole', 0.3, 0.1, 0.005, 0.3)]);
    const g = autoGrid(p, 'heat');
    // 5 mm を 4 セル → nx = 800 → nx の上限 500 より先にセル数の上限（約 12 万）が効く
    expect(g.nx).toBeGreaterThan(450);
    expect(g.nx).toBeLessThan(500);
    expect(g.nx * g.ny).toBeLessThanOrEqual(120_000);
    expect(g.reason).toContain('上限のため');
  });

  it('強度は細い部材を 6 セル以上、セル数は約 12 万以下', () => {
    const p = project(0.2, 0.1, [rect('梁', 'solid', 0, 0.04, 0.2, 0.01)]);
    const g = autoGrid(p, 'stress');
    // 10 mm を 6 セル → nx = 120 （ちょうど下限）
    expect(g.nx).toBe(120);
    expect(g.reason).toContain('「梁」');
    const p2 = project(0.4, 0.2, [rect('梁', 'solid', 0, 0.09, 0.4, 0.01)]);
    const g2 = autoGrid(p2, 'stress'); // 10 mm を 6 セル → nx = 240
    expect(g2.nx).toBe(240);
    expect(g2.nx * g2.ny).toBeLessThanOrEqual(120_000);
  });

  it('stress は heat より細かく切る', () => {
    const p = project(0.4, 0.2, [rect('梁', 'solid', 0, 0.09, 0.4, 0.01)]);
    expect(autoGrid(p, 'stress').nx).toBeGreaterThan(autoGrid(p, 'heat').nx);
    expect(autoGrid(p, 'heat').nx).toBe(160); // 10 mm を 4 セル
  });

  it('部位が大きければ下限 120', () => {
    const g = autoGrid(defaultProject(), 'heat');
    expect(g.nx).toBe(120);
  });

  it('縦長の領域では熱・強度のセル数上限（約 12 万）が効く', () => {
    const p = project(0.1, 0.5, [rect('細い柱', 'solid', 0.045, 0, 0.001, 0.5)]);
    const g = autoGrid(p, 'heat');
    expect(g.nx * g.ny).toBeLessThanOrEqual(120_000);
    expect(g.nx).toBeLessThan(500);
  });

  it('物体がなければ 200', () => {
    expect(autoGrid(project(1, 1, []), 'stress').nx).toBe(200);
  });
});

describe('autoGrid: 電磁波', () => {
  it('λmin / 20 で分割する（1 GHz・空気・幅 2 m）', () => {
    const p = project(2, 1, []);
    p.em.frequencyGHz = 1;
    const g = autoGrid(p, 'em');
    const lambda = 299792458 / 1e9 / Math.sqrt(1.0006);
    expect(g.nx).toBe(Math.ceil(2 / (lambda / 20)));
    expect(g.reason).toContain('1波長あたり 20 セル');
  });

  it('誘電体の物体があると、その εr で最短波長が短くなる。導体は数えない', () => {
    const base = project(2, 1, [rect('金属', 'solid', 1, 0.4, 0.2, 0.2, 'al6061')]);
    base.em.frequencyGHz = 1;
    const withMetal = autoGrid(base, 'em').nx;
    const diel = project(2, 1, [rect('基板', 'solid', 1, 0.4, 0.2, 0.2, 'fr4'), rect('金属', 'solid', 0.2, 0.4, 0.2, 0.2, 'al6061')]);
    diel.em.frequencyGHz = 1;
    const g = autoGrid(diel, 'em');
    expect(g.nx).toBeGreaterThan(withMetal * 1.9); // √4.3 ≈ 2.07
    expect(g.nx).toBe(Math.ceil(2 / (299792458 / 1e9 / Math.sqrt(4.3) / 20)));
  });

  it('cellsPerWavelength の指定を使う', () => {
    const p = project(2, 1, []);
    p.em.frequencyGHz = 1;
    const a = autoGrid(p, 'em').nx;
    p.em.advanced = { cellsPerWavelength: 10 };
    const b = autoGrid(p, 'em');
    expect(b.nx).toBe(Math.ceil(a / 2));
    expect(b.reason).toContain('1波長あたり 10 セル');
  });

  it('上限を超えるときは上限（500）にして、理由に 1波長あたりのセル数を書く', () => {
    const p = project(2, 1, []);
    p.em.frequencyGHz = 24; // λ ≈ 12.5 mm、20 セルなら nx ≈ 3200
    const g = autoGrid(p, 'em');
    expect(g.nx).toBe(500);
    expect(g.reason).toContain('上限のため');
    expect(g.reason).toContain('1波長あたり約 3 セル');
  });

  it('波長が長くても nx は下限 40 を割らない', () => {
    const p = project(1, 1, []);
    p.em.frequencyGHz = 0.01; // λ = 30 m
    expect(autoGrid(p, 'em').nx).toBe(40);
  });
});

describe('resolveProject', () => {
  it('autoGrid が true / 省略なら nx を自動で置き換えた浅いコピーを返し、元は変えない', () => {
    const p = defaultProject();
    p.domain.nx = 77;
    const { project: q, grid } = resolveProject(p, 'flow');
    expect(q).not.toBe(p);
    expect(q.domain.nx).toBe(320);
    expect(q.domain.nx).toBe(grid.nx);
    expect(p.domain.nx).toBe(77);
    expect(q.shapes).toBe(p.shapes);

    delete p.domain.autoGrid;
    expect(resolveProject(p, 'flow').project.domain.nx).toBe(320);
  });

  it('autoGrid === false なら元の nx を使い、理由は「手動設定」', () => {
    const p = defaultProject();
    p.domain.autoGrid = false;
    p.domain.nx = 90;
    const { project: q, grid } = resolveProject(p, 'heat');
    expect(q.domain.nx).toBe(90);
    expect(grid.nx).toBe(90);
    expect(grid.ny).toBe(45);
    expect(grid.reason).toBe('手動設定');
  });

  it('ny は raster.gridSize と同じ規則（h = 幅 / nx、ny = round(高さ / h)）', () => {
    const p = project(1.3, 0.7, [rect('a', 'solid', 0.5, 0.3, 0.1, 0.1)]);
    const g = autoGrid(p, 'flow');
    expect(g.h).toBeCloseTo(1.3 / g.nx, 12);
    expect(g.ny).toBe(Math.max(1, Math.round(0.7 / g.h)));
  });
});
