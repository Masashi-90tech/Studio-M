import { stripMesh } from '../gmsh/test-meshes';
import { parseDat } from './dat';
import { buildShapedMesh, type ShapedMesh } from './gmsh-mesh';
import { mapShapedResults, toShapedResultSet } from './gmsh-results';
import { makeProject, rect, shape } from './test-projects';

// 0.4 × 0.2 m の鉄板（4 × 2 セル × 2 三角形）。左 1 列を固定、右 1 列に荷重
const project = makeProject({
  width: 0.4,
  height: 0.2,
  nx: 40,
  thickness: 0.01,
  shapes: [shape('solid', rect(0, 0, 0.4, 0.2)), shape('support', rect(0, 0, 0.1, 0.2)), shape('load', rect(0.3, 0, 0.1, 0.2), { force: { fx: 0, fy: -1000 } })],
});
const mesh = buildShapedMesh({ project, gmsh: stripMesh({ w: 0.4, h: 0.2, nx: 4, ny: 2 }), grid: { nx: 40, ny: 20, h: 0.01 } });

// 場の関数（x, y の 1 次式）。1 次式の応力は、外挿も補間も厳密になる
const u = (x: number, y: number): [number, number] => [1e-4 * x + 2e-5 * y, -3e-4 * x * x * 0 - 5e-5 * x + 1e-5];
const s = (x: number, y: number): [number, number, number] => [50e6 + 100e6 * x - 80e6 * y, -10e6 + 30e6 * y, 5e6 + 20e6 * x];

const f12 = (x: number): string => x.toExponential(6);

/** ccx の .dat と同じ形の文章（変位・反力・応力・積分点の座標）。要素ごとに面内 3 点 × 3 層の積分点 */
function makeDat(m: ShapedMesh, opts: { reaction?: [number, number, number]; peeq?: (e: number) => number } = {}): string {
  const L: string[] = [' displacements (vx,vy,vz) for set NALL and time  0.1000000E+01', ''];
  for (let n = 1; n <= m.nodeCount; n++) {
    const [ux, uy] = u(m.coords[2 * (n - 1)], m.coords[2 * (n - 1) + 1]);
    L.push(`${String(n).padStart(10)}  ${f12(ux)}  ${f12(uy)}  ${f12(0)}`);
  }
  L.push('', ' total force (fx,fy,fz) for set NSUP and time  0.1000000E+01', '');
  const rf = opts.reaction ?? [0, 0, 0];
  L.push(`  ${f12(rf[0])}  ${f12(rf[1])}  ${f12(rf[2])}`, '');
  const stress: string[] = [];
  const coords: string[] = [];
  for (let e = 0; e < m.elementCount; e++) {
    const px = [0, 1, 2].map((a) => m.coords[2 * (m.connectivity[6 * e + a] - 1)]);
    const py = [0, 1, 2].map((a) => m.coords[2 * (m.connectivity[6 * e + a] - 1) + 1]);
    let ip = 0;
    for (let layer = 0; layer < 3; layer++) {
      for (const [l1, l2, l3] of [[2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3]]) {
        ip++;
        const x = l1 * px[0] + l2 * px[1] + l3 * px[2];
        const y = l1 * py[0] + l2 * py[1] + l3 * py[2];
        const [sx, sy, sxy] = s(x, y);
        stress.push(`${String(e + 1).padStart(10)}${String(ip).padStart(3)} ${f12(sx)} ${f12(sy)} ${f12(0)} ${f12(sxy)} ${f12(0)} ${f12(0)}`);
        coords.push(`${String(e + 1).padStart(10)}${String(ip).padStart(3)} ${f12(x)} ${f12(y)} ${f12(0.001 * layer)}`);
      }
    }
  }
  L.push(' stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz) for set EALL and time  0.1000000E+01', '', ...stress, '');
  if (opts.peeq) {
    L.push(' equivalent plastic strain (elem, integ.pnt.,pe) for set EALL and time  0.1000000E+01', '');
    for (let e = 0; e < m.elementCount; e++) for (let ip = 1; ip <= 9; ip++) L.push(`${String(e + 1).padStart(10)}${String(ip).padStart(3)} ${f12(opts.peeq(e))}`);
    L.push('');
  }
  L.push(' global coordinates (elem, integ.pnt.,x,y,z) for set EALL and time  0.1000000E+01', '', ...coords, '');
  return L.join('\n');
}

const vm = (sxx: number, syy: number, sxy: number) => Math.sqrt(sxx * sxx - sxx * syy + syy * syy + 3 * sxy * sxy);
const field = (r: ReturnType<typeof mapShapedResults>, key: string) => r.fields.find((f) => f.key === key)!;
const scalar = (r: ReturnType<typeof mapShapedResults>, key: string) => r.scalars.find((x) => x.key === key)!.value;

describe('mapShapedResults', () => {
  const text = makeDat(mesh, { reaction: [10, 1000, 0] });
  const mapped = mapShapedResults(mesh, text, parseDat(text), { plasticity: false });

  it('Lite と同じキー・単位の場と、物体のあるセルだけの mask を返す', () => {
    expect(mapped.fields.map((f) => f.key)).toEqual(['vonMises', 'displacement', 'sxx', 'syy', 'sxy', 'safety', 'ux', 'uy']);
    for (const f of mapped.fields) {
      expect(f.data.length).toBe(800);
      expect(f.mask).toBe(mesh.included);
    }
    expect(field(mapped, 'vonMises').unit).toBe('Pa');
    expect(field(mapped, 'displacement').unit).toBe('m');
    expect(field(mapped, 'sxx').diverging).toBe(true);
  });

  it('セルの値は、セル中心での場の値（1 次式の応力は、外挿→補間で厳密）', () => {
    for (const c of [0, 39, 10 * 40 + 17, 19 * 40 + 3, 799]) {
      const x = ((c % 40) + 0.5) * 0.01;
      const y = (Math.floor(c / 40) + 0.5) * 0.01;
      const [sx, sy, sxy] = s(x, y);
      expect(field(mapped, 'sxx').data[c]).toBeCloseTo(sx, -2);
      expect(field(mapped, 'syy').data[c]).toBeCloseTo(sy, -2);
      expect(field(mapped, 'sxy').data[c]).toBeCloseTo(sxy, -2);
      expect(field(mapped, 'vonMises').data[c] / vm(sx, sy, sxy)).toBeCloseTo(1, 5);
      const [ux, uy] = u(x, y);
      expect(field(mapped, 'ux').data[c]).toBeCloseTo(ux, 9);
      expect(field(mapped, 'uy').data[c]).toBeCloseTo(uy, 9);
      expect(field(mapped, 'displacement').data[c]).toBeCloseTo(Math.hypot(ux, uy), 9);
      expect(field(mapped, 'safety').data[c] / Math.min(100, 245e6 / vm(sx, sy, sxy))).toBeCloseTo(1, 5);
    }
  });

  it('最大値は、格子に戻す前の節点の値から取る（セル中心より大きい角の値が出る）', () => {
    let best = 0;
    let bestDisp = 0;
    for (let n = 0; n < mesh.nodeCount; n++) {
      const x = mesh.coords[2 * n];
      const y = mesh.coords[2 * n + 1];
      best = Math.max(best, vm(...s(x, y)));
      bestDisp = Math.max(bestDisp, Math.hypot(...u(x, y)));
    }
    expect(scalar(mapped, 'maxVonMises') / best).toBeCloseTo(1, 6);
    expect(scalar(mapped, 'maxDisplacement')).toBeCloseTo(bestDisp, 9);
    let cellMax = 0;
    for (let c = 0; c < 800; c++) cellMax = Math.max(cellMax, field(mapped, 'vonMises').data[c]);
    expect(scalar(mapped, 'maxVonMises')).toBeGreaterThan(cellMax);
    expect(scalar(mapped, 'minSafety')).toBeCloseTo(245e6 / best, 3);
    expect(mapped.maxVonMises).toBe(scalar(mapped, 'maxVonMises'));
  });

  it('質量・要素数・反力（支持の節点の反力。荷重は支持にかかっていない）', () => {
    expect(scalar(mapped, 'mass')).toBeCloseTo(7850 * 0.4 * 0.2 * 0.01, 9);
    expect(scalar(mapped, 'elementCount')).toBe(16);
    expect(scalar(mapped, 'reaction')).toBeCloseTo(Math.hypot(10, 1000), 9);
    expect(mapped.notes).toEqual([]);
  });

  it('塑性ひずみ: 要素の値がそのセルの値になり、降伏した面積の割合が出る', () => {
    const t = makeDat(mesh, { peeq: (e) => (e < 4 ? 0.002 : 0) });
    const m = mapShapedResults(mesh, t, parseDat(t), { plasticity: true });
    expect(m.fields.map((f) => f.key)).toContain('plasticStrain');
    expect(scalar(m, 'yieldedArea')).toBeCloseTo(4 / 16, 9);
    expect(scalar(m, 'maxPlasticStrain')).toBeCloseTo(0.002, 9);
    const p = field(m, 'plasticStrain').data;
    expect(p[0]).toBeCloseTo(0.002, 9); // 左下のセル（要素 0 の中）
    expect(p[799]).toBe(0);
    expect(m.yieldedArea).toBeCloseTo(0.25, 9);
  });

  it('応力・積分点の座標・変位が読めないときは、日本語のエラー', () => {
    const noCoords = text.replace(/ global coordinates[\s\S]*$/, '');
    expect(() => mapShapedResults(mesh, noCoords, parseDat(noCoords), { plasticity: false })).toThrow('読み取れませんでした');
    expect(() => mapShapedResults(mesh, '', [], { plasticity: false })).toThrow('読み取れませんでした');
  });

  it('ResultSet にまとめる', () => {
    const rs = toShapedResultSet(mesh, mapped, ['x']);
    expect(rs).toMatchObject({ analysis: 'stress', nx: 40, ny: 20, h: 0.01, warnings: ['x'], history: [] });
  });
});

describe('材料の境目では、節点の応力を材料ごとに分ける', () => {
  it('境目の節点で、材料の違う要素の応力を混ぜない（最大値が平均に削られない）', () => {
    const p = makeProject({
      width: 0.4,
      height: 0.2,
      nx: 40,
      thickness: 0.01,
      shapes: [shape('solid', rect(0, 0, 0.2, 0.2)), shape('solid', rect(0.2, 0, 0.2, 0.2), { materialId: 'al6061' }), shape('support', rect(0, 0, 0.1, 0.2))],
    });
    const m = buildShapedMesh({ project: p, gmsh: stripMesh({ w: 0.4, h: 0.2, nx: 4, ny: 2 }), grid: { nx: 40, ny: 20, h: 0.01 } });
    // 左（鉄）は 100 MPa、右（アルミ）は 10 MPa の一様な応力
    const t = makeDat(m).replace(/^( +\d+ +\d+) \S+ \S+ \S+ \S+ \S+ \S+$/gm, (_line, head: string) => {
      const e = Number(head.trim().split(/\s+/)[0]) - 1;
      const sx = m.elementMaterial[e] === 0 ? 100e6 : 10e6;
      return `${head} ${f12(sx)} ${f12(0)} ${f12(0)} ${f12(0)} ${f12(0)} ${f12(0)}`;
    });
    const r = mapShapedResults(m, t, parseDat(t), { plasticity: false });
    // 鉄の節点は 100 MPa のまま（アルミの 10 MPa と平均されない）
    expect(r.maxVonMises).toBeCloseTo(100e6, -3);
    // 鉄のセル（x < 0.2）とアルミのセル（x > 0.2）の値が、境目の近くでもそれぞれの値に近い
    const sxx = field(r, 'sxx').data;
    expect(sxx[10 * 40 + 19]).toBeCloseTo(100e6, -3);
    expect(sxx[10 * 40 + 20]).toBeCloseTo(10e6, -3);
    // 最小安全率: 鉄 245 / 100、アルミ 276 / 10 のうち小さいほう
    expect(r.minSafety).toBeCloseTo(2.45, 3);
  });
});
