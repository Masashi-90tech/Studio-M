import { readFileSync } from 'node:fs';
import path from 'node:path';
import { lastBlock, parseDat } from './dat';

// fixtures/plastic-4x2.dat は、このアダプターが書いた 4 × 2 要素（CPS4）の片持ち板の弾塑性計算（ccx 2.21）の出力。
// 全要素が 8 積分点（平面応力要素は内部で 3D に広げられる）、増分は最後だけ出力した形。
const text = readFileSync(path.join(__dirname, 'fixtures/plastic-4x2.dat'), 'utf8');

describe('parseDat（実際の ccx 出力）', () => {
  const blocks = parseDat(text);

  it('変位・反力・応力・塑性ひずみのブロックが読める', () => {
    expect(blocks.map((b) => b.kind)).toEqual(['displacement', 'totalForce', 'stress', 'plasticStrain']);
    for (const b of blocks) expect(b.time).toBeCloseTo(1, 9);
  });

  it('節点変位: 15 節点 × 3 成分', () => {
    const d = lastBlock(blocks, 'displacement', 'NALL')!;
    expect(d.ids.length).toBe(15);
    expect(d.columns).toBe(3);
    expect(Array.from(d.ids)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    // 固定端は 0、先端（節点 5）は下向き
    expect(d.values[0]).toBe(0);
    expect(d.values[3 * 4 + 1]).toBeCloseTo(-3.517261e-3, 9);
  });

  it('反力: 荷重 200 kN とつり合う', () => {
    const rf = lastBlock(blocks, 'totalForce', 'NSUP')!;
    expect(rf.values.length).toBe(3);
    expect(rf.values[1]).toBeCloseTo(2e5, -1);
  });

  it('応力は要素ごと（積分点 8 つの平均）に 6 成分', () => {
    const s = lastBlock(blocks, 'stress')!;
    expect(s.ids.length).toBe(8);
    expect(s.columns).toBe(6);
    // 要素 8（先端の上側）の sxx は積分点の値の平均
    const rows = text
      .split('\n')
      .filter((l) => /^\s+8\s+\d\s/.test(l))
      .slice(0, 8)
      .map((l) => Number(l.trim().split(/\s+/)[2]));
    expect(rows.length).toBe(8);
    const mean = rows.reduce((a, b) => a + b, 0) / 8;
    expect(s.values[6 * 7]).toBeCloseTo(mean, -2);
  });

  it('相当塑性ひずみは要素ごとに 1 値で、降伏した要素だけ正', () => {
    const p = lastBlock(blocks, 'plasticStrain')!;
    expect(p.ids.length).toBe(8);
    expect(p.columns).toBe(1);
    const yielded = Array.from(p.values).filter((v) => v > 1e-8).length;
    expect(yielded).toBe(6); // 固定端に近い要素（上下の列）が降伏している
    for (const v of p.values) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('parseDat（書式の細かい場合）', () => {
  const snippet = `

                        S T E P       1


                                INCREMENT     1


 displacements (vx,vy,vz) for set NALL and time  0.5000000E+00

         1  0.000000E+00  0.000000E+00  0.000000E+00
         2  1.000000E-03 -2.000000E-03  0.000000E+00

 total force (fx,fy,fz) for set NSUP and time  0.5000000E+00

       -1.000000E+00  2.000000E+02  0.000000E+00

 stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz) for set EALL and time  0.5000000E+00

         1   1  1.000000E+06  0.000000E+00  0.000000E+00  0.000000E+00  0.000000E+00  0.000000E+00
         1   2  3.000000E+06  0.000000E+00  0.000000E+00  2.000000E+06  0.000000E+00  0.000000E+00
         2   1 -5.000000E+06  1.000000E+06  0.000000E+00  0.000000E+00  0.000000E+00  0.000000E+00

                                INCREMENT     2


 displacements (vx,vy,vz) for set NALL and time  0.1000000E+01

         1  0.000000E+00  0.000000E+00  0.000000E+00
         2  2.000000E-03 -4.000000E-03  0.000000E+00
`;

  it('増分が複数あっても、時刻ごとのブロックに分かれ、lastBlock は最後を返す', () => {
    const blocks = parseDat(snippet);
    expect(blocks.map((b) => `${b.kind}@${b.time}`)).toEqual(['displacement@0.5', 'totalForce@0.5', 'stress@0.5', 'displacement@1']);
    expect(lastBlock(blocks, 'displacement')!.values[4]).toBeCloseTo(-4e-3, 12);
    expect(lastBlock(blocks, 'stress')!.time).toBe(0.5);
  });

  it('積分点の平均を要素ごとにとる', () => {
    const s = lastBlock(parseDat(snippet), 'stress')!;
    expect(Array.from(s.ids)).toEqual([1, 2]);
    expect(s.values[0]).toBeCloseTo(2e6, 3); // (1e6 + 3e6) / 2
    expect(s.values[3]).toBeCloseTo(1e6, 3); // sxy: (0 + 2e6) / 2
    expect(s.values[6]).toBeCloseTo(-5e6, 3);
  });

  it('空の入力や関係ない文章は空の結果', () => {
    expect(parseDat('')).toEqual([]);
    expect(parseDat('CalculiX\nJob finished\n')).toEqual([]);
  });

  it('Windows の改行でも読める', () => {
    const blocks = parseDat(snippet.replace(/\n/g, '\r\n'));
    expect(lastBlock(blocks, 'stress')!.ids.length).toBe(2);
  });
});

// fixtures/heat-3x1.dat は、手で書いた 3 要素（DC3D8）の板の定常熱伝導（ccx 2.21）の出力。
// 左端の節点を 100 °C に固定、右端の要素に 1e6 W/m³ の発熱、表裏と右端に膜（熱伝達率 10、周囲 20 °C）
describe('parseDat（熱の出力）', () => {
  const blocks = parseDat(readFileSync(path.join(__dirname, 'fixtures/heat-3x1.dat'), 'utf8'));

  it('節点温度・固定温度の節点の熱の出入り・要素の熱流束が読める', () => {
    expect(blocks.map((b) => b.kind)).toEqual(['temperature', 'totalHeat', 'heatFlux']);
    const t = lastBlock(blocks, 'temperature', 'NALL')!;
    expect(t.ids.length).toBe(16);
    expect(t.values[0]).toBeCloseTo(100, 6);
    expect(t.values[3]).toBeCloseTo(258.6887, 3);
  });

  it('「total heat generation」は固定温度の節点から出ていく熱 [W]（出るとき負）', () => {
    const rfl = lastBlock(blocks, 'totalHeat', 'NFIX')!;
    expect(rfl.values).toHaveLength(1);
    expect(rfl.values[0]).toBeCloseTo(-15.13697, 4);
  });

  it('熱流束は見出しの set が空白なしでも読め、要素ごとの平均になる', () => {
    const q = lastBlock(blocks, 'heatFlux', 'EALL')!;
    expect(q.ids.length).toBe(3);
    expect(q.columns).toBe(3);
    expect(q.values[0]).toBeCloseTo(-1.513697e4, 0);
    expect(q.values[3]).toBeCloseTo(-3.87671e4, 0);
  });
});
