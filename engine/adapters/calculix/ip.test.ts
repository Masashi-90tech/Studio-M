import { evalFit, readStressFits } from './ip';

const f12 = (x: number): string => x.toExponential(6);

/**
 * ccx の .dat と同じ形（stresses → global coordinates）の文章を作る。
 * 要素 1 つ、三角形 (0,0) (0.01,0) (0,0.01)。面内 3 点 × 厚さ方向 3 層 = 9 積分点（平面応力なので層ごとに値は同じ）
 */
function dat(sigma: (x: number, y: number) => [number, number, number], opts: { skipCoords?: boolean } = {}): string {
  const pts: [number, number][] = [[1 / 6, 1 / 6], [2 / 3, 1 / 6], [1 / 6, 2 / 3]].map(([a, b]) => [0.01 * a, 0.01 * b]);
  const stress: string[] = [];
  const coords: string[] = [];
  let ip = 0;
  for (let layer = 0; layer < 3; layer++) {
    for (const [x, y] of pts) {
      ip++;
      const [sx, sy, sxy] = sigma(x, y);
      stress.push(`${String(1).padStart(10)}${String(ip).padStart(3)} ${f12(sx)} ${f12(sy)} ${f12(0)} ${f12(sxy)} ${f12(1e3 * layer)} ${f12(0)}`);
      coords.push(`${String(1).padStart(10)}${String(ip).padStart(3)} ${f12(x)} ${f12(y)} ${f12(0.005 * layer)}`);
    }
  }
  return [
    ' displacements (vx,vy,vz) for set NALL and time  0.1000000E+01',
    '',
    '         1  0.0  0.0  0.0',
    '',
    ' stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz) for set EALL and time  0.1000000E+01',
    '',
    ...stress,
    '',
    ...(opts.skipCoords ? [] : [' global coordinates (elem, integ.pnt.,x,y,z) for set EALL and time  0.1000000E+01', '', ...coords, '']),
  ].join('\n');
}

describe('readStressFits', () => {
  it('積分点の応力に 1 次式を当てはめ、要素の中のどの点でも値が出せる（1 次式の応力は厳密）', () => {
    const sigma = (x: number, y: number): [number, number, number] => [1e6 + 2e8 * x - 3e8 * y, -5e5 + 1e8 * y, 4e5 * 1 + 5e7 * x];
    const fits = readStressFits(dat(sigma), 1)!;
    expect(fits).not.toBeNull();
    for (const [x, y] of [[0, 0], [0.01, 0], [0, 0.01], [0.0035, 0.0021], [0.005, 0.005]]) {
      const [sx, sy, sxy] = sigma(x, y);
      expect(evalFit(fits, 0, 0, x, y)).toBeCloseTo(sx, 0);
      expect(evalFit(fits, 0, 1, x, y)).toBeCloseTo(sy, 0);
      expect(evalFit(fits, 0, 2, x, y)).toBeCloseTo(sxy, 0);
    }
  });

  it('一様な応力なら、どこでも同じ値', () => {
    const fits = readStressFits(dat(() => [7e6, -2e6, 1e6]), 1)!;
    expect(evalFit(fits, 0, 0, 0.002, 0.004)).toBeCloseTo(7e6, 0);
  });

  it('積分点の座標（COORD）がない・要素が足りないときは null', () => {
    expect(readStressFits(dat(() => [1, 1, 1], { skipCoords: true }), 1)).toBeNull();
    expect(readStressFits(dat(() => [1, 1, 1]), 2)).toBeNull();
    expect(readStressFits('なにもない', 1)).toBeNull();
  });
});
