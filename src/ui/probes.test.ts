import { describe, expect, it } from 'vitest';
import type { Field } from '../core/types';
import { fieldToCsv, resultToVtk, vtkName } from './export-raw';
import { MAX_PROBES, ProState, sampleBilinear, sampleNearest, sectionProfile } from './probes';

// 4 × 3 の格子、セル幅 1 m。値 = i + 10 j
const g = { nx: 4, ny: 3, h: 1 };
const data = new Float32Array(12);
for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) data[j * 4 + i] = i + 10 * j;
const field: Field = { key: 'phi', label: 'φ', unit: 'K', data };

describe('sampleNearest', () => {
  it('点を含むセルの値', () => {
    expect(sampleNearest(g, field, 0.2, 0.2)).toBe(0);
    expect(sampleNearest(g, field, 2.5, 1.5)).toBe(12);
    expect(sampleNearest(g, field, 3.99, 2.99)).toBe(23);
  });
  it('範囲外・無効セルは null', () => {
    expect(sampleNearest(g, field, -0.1, 0.5)).toBeNull();
    expect(sampleNearest(g, field, 4.1, 0.5)).toBeNull();
    const mask = new Uint8Array(12).fill(1);
    mask[5] = 0;
    expect(sampleNearest(g, { ...field, mask }, 1.5, 1.5)).toBeNull();
  });
});

describe('sampleBilinear', () => {
  it('セル中心ではそのセルの値、中心の間では線形補間', () => {
    expect(sampleBilinear(g, field, 1.5, 1.5)).toBeCloseTo(11, 6);
    expect(sampleBilinear(g, field, 2, 1.5)).toBeCloseTo(11.5, 6);
    expect(sampleBilinear(g, field, 1.5, 2)).toBeCloseTo(16, 6);
  });
  it('端では最も近い中心の値に丸める', () => {
    expect(sampleBilinear(g, field, 0, 0)).toBeCloseTo(0, 6);
    expect(sampleBilinear(g, field, 4, 3)).toBeCloseTo(23, 6);
  });
  it('無効なセルは重みから外す', () => {
    const mask = new Uint8Array(12).fill(1);
    mask[5] = 0; // (1,1)
    // (2,2) の周りは (1,1),(2,1),(1,2),(2,2)。値 11 が外れ、残りの平均になる
    const v = sampleBilinear(g, { ...field, mask }, 2, 2)!;
    expect(v).toBeCloseTo((12 + 21 + 22) / 3, 5);
    const none = new Uint8Array(12);
    expect(sampleBilinear(g, { ...field, mask: none }, 2, 2)).toBeNull();
  });
});

describe('sectionProfile', () => {
  it('水平線に沿って 1 セルずつ増える値を返す', () => {
    const p = sectionProfile(g, field, [0.5, 1.5], [3.5, 1.5]);
    expect(p[0].s).toBe(0);
    expect(p[p.length - 1].s).toBeCloseTo(3, 9);
    expect(p[0].v).toBeCloseTo(10, 5);
    expect(p[p.length - 1].v).toBeCloseTo(13, 5);
    // 単調増加
    for (let k = 1; k < p.length; k++) expect(p[k].v!).toBeGreaterThanOrEqual(p[k - 1].v! - 1e-9);
  });
  it('長さ 0 は空、点数には上限がある', () => {
    expect(sectionProfile(g, field, [1, 1], [1, 1])).toEqual([]);
    expect(sectionProfile({ nx: 4, ny: 3, h: 1e-6 }, field, [0, 0], [1e-4, 1e-4], 50).length).toBe(50);
  });
});

describe('ProState', () => {
  it('プローブの追加・削除・上限', () => {
    const s = new ProState();
    let n = 0;
    s.on(() => n++);
    for (let k = 0; k < MAX_PROBES; k++) expect(s.addProbe(k, k)).toBe(true);
    expect(s.addProbe(0, 0)).toBe(false);
    const id = s.probes[3].id;
    s.removeProbe(id);
    expect(s.probes).toHaveLength(MAX_PROBES - 1);
    expect(s.probes.some((p) => p.id === id)).toBe(false);
    s.setSection([0, 0], [1, 1]);
    expect(s.section).not.toBeNull();
    s.clearAll();
    expect(s.probes).toHaveLength(0);
    expect(s.section).toBeNull();
    expect(n).toBeGreaterThan(MAX_PROBES);
  });
});

describe('fieldToCsv', () => {
  const r = { nx: 2, ny: 2, h: 0.001 };
  const f: Field = { key: 'temperature', label: '温度', unit: '°C', data: new Float32Array([20, 21.5, 30, 31]), mask: new Uint8Array([1, 1, 0, 1]) };
  it('ヘッダーと、セル中心 mm 座標の行を出す', () => {
    const lines = fieldToCsv(r, f).trim().split('\n');
    expect(lines[0]).toBe('i,j,x[mm],y[mm],温度[°C]');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('0,0,0.5,0.5,20');
    expect(lines[2]).toBe('1,0,1.5,0.5,21.5');
  });
  it('無効なセルの値は空欄', () => {
    const lines = fieldToCsv(r, f).trim().split('\n');
    expect(lines[3]).toBe('0,1,0.5,1.5,');
    expect(lines[4]).toBe('1,1,1.5,1.5,31');
  });
  it('単位のないラベルはそのまま、カンマを含むなら引用符', () => {
    expect(fieldToCsv(r, { ...f, label: 'a,b', unit: '' }).split('\n')[0]).toBe('i,j,x[mm],y[mm],"a,b"');
  });
});

describe('resultToVtk', () => {
  const f1: Field = { key: 'temperature', label: '温度', unit: '°C', data: new Float32Array([1, 2, 3, 4, 5, 6]), mask: new Uint8Array([1, 1, 1, 1, 0, 1]) };
  const f2: Field = { key: 'heat flux', label: '熱流束', unit: 'W/m²', data: new Float32Array([0, 0, 0, 0, 0, 9]) };
  const vtk = resultToVtk({ nx: 3, ny: 2, h: 0.002, fields: [f1, f2] }, 'テスト');
  const lines = vtk.trim().split('\n');
  it('ヘッダーは legacy VTK の STRUCTURED_POINTS', () => {
    expect(lines.slice(0, 3)).toEqual(['# vtk DataFile Version 3.0', 'テスト', 'ASCII']);
    expect(lines).toContain('DATASET STRUCTURED_POINTS');
    expect(lines).toContain('DIMENSIONS 3 2 1');
    expect(lines).toContain('ORIGIN 1 1 0');
    expect(lines).toContain('SPACING 2 2 1');
    expect(lines).toContain('POINT_DATA 6');
  });
  it('場ごとに SCALARS を持ち、名前に空白を含めない', () => {
    expect(lines).toContain('SCALARS temperature float 1');
    expect(lines).toContain('SCALARS heat_flux float 1');
    expect(lines).toContain('SCALARS valid float 1');
    expect(vtkName('a b/c')).toBe('a_b_c');
  });
  it('値は x が速く動く順で、無効なセルは 0、valid に 1/0 が入る', () => {
    const t = lines.indexOf('SCALARS temperature float 1');
    expect(lines[t + 1]).toBe('LOOKUP_TABLE default');
    expect(lines[t + 2]).toBe('1 2 3 4 0 6');
    const v = lines.indexOf('SCALARS valid float 1');
    expect(lines[v + 2]).toBe('1 1 1 1 0 1');
  });
});
