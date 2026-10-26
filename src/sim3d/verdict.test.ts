import { describe, expect, it } from 'vitest';
import type { ResultSet3D, Study3D } from '../core/types';
import { buildStudy3D } from '../mesh3d/build3d';
import { analyzeMesh } from '../mesh3d/mesh';
import { boxMesh } from '../mesh3d/primitives';
import { addRegion } from './regions';
import { heatVerdict3D, maxTempOf, totalHeatW } from './verdict';

const study = (materialId: string): Study3D => {
  const s = buildStudy3D({ mesh: analyzeMesh(boxMesh(80, 50, 8)).mesh, fileName: 'p.stl', materialId });
  return addRegion(s, { role: 'heatFlux', faces: [0], value: 5 }).study;
};
const result = (maxTemp: number | null): ResultSet3D => ({
  analysis: 'heat',
  grid: { nx: 2, ny: 1, nz: 1, h: 1, origin: [0, 0, 0] },
  fields: [{ key: 'temp', label: '温度', unit: '°C', data: Float32Array.from([20, maxTemp ?? 20]), mask: Uint8Array.from([1, 1]) }],
  scalars: maxTemp === null ? [] : [{ key: 'maxTemp', label: '最高温度', unit: '°C', value: maxTemp }],
  history: [],
  warnings: [],
});

describe('3D の熱の判定', () => {
  it('耐熱温度（PLA 55°C）に 10 K 以上の余裕があれば OK、0〜10 K で注意、超えたら NG', () => {
    expect(heatVerdict3D({ study: study('pla'), result: result(40) }).level).toBe('ok');
    expect(heatVerdict3D({ study: study('pla'), result: result(45) }).level).toBe('ok');
    expect(heatVerdict3D({ study: study('pla'), result: result(50) }).level).toBe('warn');
    expect(heatVerdict3D({ study: study('pla'), result: result(55) }).level).toBe('warn');
    const ng = heatVerdict3D({ study: study('pla'), result: result(70) });
    expect(ng.level).toBe('ng');
    expect(ng.title).toContain('PLA');
    expect(ng.title).toContain('70');
  });

  it('耐熱温度がない材料（アルミ）は、最高温度と上がり方を知らせるだけ', () => {
    const v = heatVerdict3D({ study: study('al6061'), result: result(60) });
    expect(v.level).toBe('info');
    expect(v.title).toContain('60');
    expect(v.lines.join(' ')).toContain('35');
  });

  it('発熱が何もないときは、足すよう案内する', () => {
    const s = buildStudy3D({ mesh: analyzeMesh(boxMesh(80, 50, 8)).mesh, fileName: 'p.stl', materialId: 'pla' });
    const v = heatVerdict3D({ study: s, result: result(25) });
    expect(v.lines.join(' ')).toContain('発熱がありません');
  });

  it('最高温度がない結果は、最大値で代用する。それもなければ info で見直しを促す', () => {
    const r = result(40);
    r.scalars = [];
    expect(maxTempOf(r)).toBe(40);
    r.fields = [];
    expect(maxTempOf(r)).toBeUndefined();
    expect(heatVerdict3D({ study: study('pla'), result: r }).level).toBe('info');
  });

  it('発熱の合計は、面の発熱と部品全体の発熱の和', () => {
    const s = study('pla');
    expect(totalHeatW(s)).toBe(5);
    expect(totalHeatW({ ...s, heat: { ...s.heat, bodyHeatW: 2 } })).toBe(7);
  });
});
