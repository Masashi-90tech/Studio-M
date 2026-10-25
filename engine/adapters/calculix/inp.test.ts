import { rasterize } from '../../../src/core/raster';
import { writeInp } from './inp';
import { buildMesh } from './mesh';
import { makeProject, rect, shape } from './test-projects';

const project = () =>
  makeProject({
    width: 0.4,
    height: 0.2,
    nx: 4,
    thickness: 0.01,
    shapes: [
      shape('solid', rect(0, 0, 0.4, 0.2)),
      shape('solid', rect(0.2, 0, 0.2, 0.2), { materialId: 'al6061' }),
      shape('support', rect(0, 0, 0.1, 0.2)),
      shape('load', rect(0.3, 0, 0.1, 0.2), { force: { fx: 200, fy: -1000 } }),
    ],
  });

const make = (opts: Partial<Parameters<typeof writeInp>[1]> = {}, elementType: 'CPS4' | 'CPS8R' = 'CPS4') => {
  const p = project();
  const mesh = buildMesh({ project: p, raster: rasterize(p), elementType });
  return { mesh, inp: writeInp(mesh, { plasticity: false, largeDeformation: false, loadScale: 1, hardeningPercent: 0, ...opts }) };
};

/** 「*KEYWORD」から次の「*」までの行 */
const section = (inp: string, keyword: string): string[] => {
  const lines = inp.split('\n');
  const start = lines.findIndex((l) => l.toUpperCase().startsWith(keyword));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('*'); i++) if (lines[i].trim() !== '') out.push(lines[i]);
  return out;
};

describe('writeInp', () => {
  it('節点・要素の数が分割と一致する', () => {
    const { mesh, inp } = make();
    expect(section(inp, '*NODE,')).toHaveLength(mesh.nodeCount);
    expect(section(inp, '*ELEMENT')).toHaveLength(8);
    expect(inp).toContain('*ELEMENT, TYPE=CPS4, ELSET=EALL');
    // 節点の行は「番号, x, y, 0」
    expect(section(inp, '*NODE,')[1]).toBe('2, 0.1, 0, 0');
  });

  it('材料ごとに *MATERIAL と *SOLID SECTION（厚さ付き）がある', () => {
    const { inp } = make();
    expect(inp.match(/^\*MATERIAL/gm)).toHaveLength(2);
    expect(inp.match(/^\*SOLID SECTION/gm)).toHaveLength(2);
    expect(inp).toContain('*SOLID SECTION, ELSET=EMAT1, MATERIAL=MAT1');
    expect(section(inp, '*SOLID SECTION, ELSET=EMAT1')).toEqual(['0.01']);
    expect(section(inp, '*ELASTIC')[0]).toBe('206000000000, 0.3');
    expect(inp).not.toContain('*PLASTIC');
    // 要素集合に全要素が 1 度ずつ入る
    const ids = [...inp.matchAll(/^\*ELSET, ELSET=EMAT\d\n([^*]*)/gm)].flatMap((m) => m[1].split(/[,\s]+/).filter(Boolean).map(Number));
    expect(ids.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('支持は *BOUNDARY で x, y を固定、荷重は *CLOAD で合計が一致する', () => {
    const { mesh, inp } = make();
    expect(section(inp, '*BOUNDARY')).toEqual(['NSUP, 1, 2']);
    const nset = section(inp, '*NSET, NSET=NSUP').flatMap((l) => l.split(',').map((v) => Number(v.trim())));
    expect(nset).toEqual(mesh.supportNodes);
    let fx = 0;
    let fy = 0;
    for (const line of section(inp, '*CLOAD')) {
      const [, dof, value] = line.split(',').map((v) => Number(v.trim()));
      if (dof === 1) fx += value;
      else fy += value;
    }
    expect(fx).toBeCloseTo(200, 6);
    expect(fy).toBeCloseTo(-1000, 6);
  });

  it('荷重の倍率が *CLOAD に掛かる', () => {
    const { inp } = make({ loadScale: 3 });
    let fy = 0;
    for (const line of section(inp, '*CLOAD')) {
      const [, dof, value] = line.split(',').map((v) => Number(v.trim()));
      if (dof === 2) fy += value;
    }
    expect(fy).toBeCloseTo(-3000, 6);
  });

  it('弾性だけなら増分の指定なし、出力は最後に END STEP', () => {
    const { inp } = make();
    expect(section(inp, '*STATIC')).toEqual([]);
    expect(inp).toContain('*NODE PRINT, NSET=NSUP, TOTALS=ONLY');
    expect(inp).not.toContain('FREQUENCY');
    expect(inp.trimEnd().endsWith('*END STEP')).toBe(true);
    expect(inp).not.toContain('NLGEOM');
  });

  it('塑性は降伏応力から *PLASTIC を書き、増分と PEEQ の出力を付ける', () => {
    const { inp } = make({ plasticity: true });
    // ss400 と アルミ A6061 の降伏応力
    expect(inp).toContain('*PLASTIC\n245000000, 0\n245000000, 1');
    expect(inp).toContain('*PLASTIC\n276000000, 0\n276000000, 1');
    expect(section(inp, '*STATIC')).toEqual(['0.1, 1., 1e-4, 0.2']);
    expect(inp).toContain('S, PEEQ');
    expect(inp).toContain('FREQUENCY=1000');
  });

  it('硬化の指定は 2 点目の応力に入る（E × 割合）', () => {
    const { inp } = make({ plasticity: true, hardeningPercent: 1 });
    expect(inp).toContain('245000000, 0\n2305000000, 1');
  });

  it('大きな変形は NLGEOM', () => {
    expect(make({ largeDeformation: true }).inp).toContain('*STEP, NLGEOM');
  });

  it('CPS8R は 8 節点の要素行になる', () => {
    const { inp } = make({}, 'CPS8R');
    expect(inp).toContain('*ELEMENT, TYPE=CPS8R, ELSET=EALL');
    expect(section(inp, '*ELEMENT')[0].split(',')).toHaveLength(9);
  });
});
