import { rasterize } from '../../../src/core/raster';
import { buildHeatMesh } from './heat-mesh';
import { writeHeatInp } from './heat-inp';
import { makeProject, rect, shape } from './test-projects';

// 4 × 2 セルの板（セル幅 10 mm、厚さ 2 mm）。左の 1 列が 60 °C、中央の 1 セルが 2 W
const project = () => {
  const p = makeProject({
    width: 0.04,
    height: 0.03,
    nx: 4,
    thickness: 0.002,
    shapes: [
      shape('solid', rect(0, 0, 0.04, 0.02), { materialId: 'al6061' }),
      shape('heatSource', rect(0.02, 0.01, 0.01, 0.01), { materialId: 'al6061', heatW: 2 }),
      shape('fixedTemp', rect(0, 0, 0.01, 0.02), { tempC: 60 } as never),
    ],
  });
  p.heat.surfaceH = 10;
  p.heat.ambientC = 20;
  return p;
};

const section = (inp: string, keyword: string): string[] => {
  const lines = inp.split('\n');
  const start = lines.findIndex((l) => l.toUpperCase().startsWith(keyword));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('*'); i++) if (lines[i].trim() !== '') out.push(lines[i]);
  return out;
};

describe('writeHeatInp', () => {
  const p = project();
  const mesh = buildHeatMesh({ project: p, raster: rasterize(p) });
  const inp = writeHeatInp(mesh, { title: 'テスト' });

  it('節点・要素の数が分割と一致する', () => {
    expect(section(inp, '*NODE,')).toHaveLength(mesh.nodeCount);
    expect(section(inp, '*ELEMENT')).toHaveLength(8);
    expect(inp).toContain('*ELEMENT, TYPE=DC3D8, ELSET=EALL');
    expect(section(inp, '*ELEMENT')[0].split(',')).toHaveLength(9);
  });

  it('熱伝導率は面内と板厚方向を分けて書く（TYPE=ORTHO）', () => {
    expect(inp).toContain('*MATERIAL, NAME=MK1\n*CONDUCTIVITY, TYPE=ORTHO\n167, 167, 167');
    expect(inp).toContain('*SOLID SECTION, ELSET=EK1, MATERIAL=MK1');
  });

  it('固定温度は *BOUNDARY の自由度 11、発熱は *DFLUX の BF（W/m³）', () => {
    expect(section(inp, '*BOUNDARY')).toEqual(['NT1, 11, 11, 60']);
    const [line] = section(inp, '*DFLUX');
    const [set, kind, value] = line.split(',').map((v) => v.trim());
    expect(set).toBe('EQ1');
    expect(kind).toBe('BF');
    expect(Number(value)).toBeCloseTo(2 / (0.01 * 0.01 * 0.002), 3);
  });

  it('膜は面番号・周囲温度・熱伝達率の順', () => {
    const films = section(inp, '*FILM');
    expect(films.length).toBe(mesh.films.length);
    expect(films).toContain('EF1, F1, 20, 10'); // 表裏の放熱
    for (const f of films) expect(f).toMatch(/^EF\d+, F[1-6], 20, 10$/);
  });

  it('定常熱伝導のステップと、温度・熱流束・固定温度の熱の出入りの出力要求', () => {
    expect(inp).toContain('*HEAT TRANSFER, STEADY STATE');
    expect(inp).toContain('*NODE PRINT, NSET=NALL\nNT');
    expect(inp).toContain('*NODE PRINT, NSET=NFIX, TOTALS=ONLY\nRFL');
    expect(inp).toContain('*EL PRINT, ELSET=EALL\nHFL');
    expect(inp.trimEnd().endsWith('*END STEP')).toBe(true);
  });

  it('固定温度がなければ *BOUNDARY と RFL の出力はない', () => {
    const q = project();
    q.shapes.pop();
    const m = buildHeatMesh({ project: q, raster: rasterize(q) });
    const text = writeHeatInp(m);
    expect(text).not.toContain('*BOUNDARY');
    expect(text).not.toContain('RFL\n*EL PRINT');
    expect(text).not.toContain('NSET=NFIX');
  });
});
