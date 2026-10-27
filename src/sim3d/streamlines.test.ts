import { describe, expect, it } from 'vitest';
import { cellCenter3D, cellIndex3D } from '../core/grid3d';
import type { Grid3D, ResultSet3D } from '../core/types';
import { colormapRGB } from '../ui/colormap';
import { buildStreamlines, flowSeeds, sampleVelocity, streamlineSegments, streamlineSpeedRange, traceStreamline, velocityFieldOf, type VelocityField } from './streamlines';

const grid: Grid3D = { nx: 24, ny: 24, nz: 24, h: 0.1, origin: [0, 0, 0] };

/** 格子のセルの中心で関数 f を読んで速度場にする。solid が true を返すセルは固体 */
function makeField(f: (x: number, y: number, z: number) => [number, number, number], solid?: (x: number, y: number, z: number) => boolean): VelocityField {
  const n = grid.nx * grid.ny * grid.nz;
  const ux = new Float32Array(n);
  const uy = new Float32Array(n);
  const uz = new Float32Array(n);
  const mask = new Uint8Array(n).fill(1);
  for (let k = 0; k < grid.nz; k++)
    for (let j = 0; j < grid.ny; j++)
      for (let i = 0; i < grid.nx; i++) {
        const [x, y, z] = cellCenter3D(grid, i, j, k);
        const c = cellIndex3D(grid, i, j, k);
        if (solid?.(x, y, z)) {
          mask[c] = 0;
          continue;
        }
        [ux[c], uy[c], uz[c]] = f(x, y, z);
      }
  return { grid, ux, uy, uz, mask };
}

describe('速度の読み取り', () => {
  it('一様流はどこで読んでも同じ。線形に変わる場は 3 次元の線形補間で正確に読める', () => {
    const uni = makeField(() => [2, -1, 0.5]);
    const out: [number, number, number] = [0, 0, 0];
    expect(sampleVelocity(uni, [1.234, 0.77, 1.9], out)).toBe(true);
    expect(out[0]).toBeCloseTo(2, 5);
    expect(out[1]).toBeCloseTo(-1, 5);
    expect(out[2]).toBeCloseTo(0.5, 5);
    const lin = makeField((x, y, z) => [x + 2 * y, 0, z]);
    expect(sampleVelocity(lin, [1.2, 0.9, 1.1], out)).toBe(true);
    expect(out[0]).toBeCloseTo(1.2 + 1.8, 4);
    expect(out[2]).toBeCloseTo(1.1, 4);
  });

  it('格子の外と固体のセルの中は読めない。壁のそばでも固体の値は混ざらない', () => {
    const f = makeField(() => [1, 0, 0], (x) => x > 1.2 && x < 1.6);
    const out: [number, number, number] = [0, 0, 0];
    expect(sampleVelocity(f, [-0.1, 1, 1], out)).toBe(false);
    expect(sampleVelocity(f, [2.5, 1, 1], out)).toBe(false); // x = 2.4 が格子の端
    expect(sampleVelocity(f, [2.3, 1, 1], out)).toBe(true);
    expect(sampleVelocity(f, [1.4, 1, 1], out)).toBe(false);
    expect(sampleVelocity(f, [1.7, 1, 1], out)).toBe(true);
    expect(out[0]).toBeCloseTo(1, 6); // 固体の 0 を混ぜない
  });

  it('結果の fields から ux・uy・uz を取り出す（なければ null）', () => {
    const vf = makeField(() => [1, 0, 0]);
    const mk = (keys: string[]): ResultSet3D => ({
      analysis: 'flow',
      grid,
      fields: keys.map((key) => ({ key, label: key, unit: 'm/s', data: key === 'ux' ? vf.ux : vf.uy, mask: vf.mask })),
      scalars: [],
      history: [],
      warnings: [],
    });
    expect(velocityFieldOf(mk(['speed', 'pressure']))).toBeNull();
    const got = velocityFieldOf(mk(['ux', 'uy', 'uz']))!;
    expect(got.grid).toBe(grid);
    expect(got.ux).toBe(vf.ux);
  });
});

describe('流線の追跡', () => {
  it('一様流ではまっすぐ進み、流れの向きの外には出ない。点の間隔は一定', () => {
    const vf = makeField(() => [1, 0, 0]);
    const line = traceStreamline(vf, [0.2, 1.1, 1.3]);
    const n = line.speeds.length;
    expect(n).toBeGreaterThan(30);
    for (let i = 0; i < n; i++) {
      expect(line.points[i * 3 + 1]).toBeCloseTo(1.1, 5);
      expect(line.points[i * 3 + 2]).toBeCloseTo(1.3, 5);
      expect(line.speeds[i]).toBeCloseTo(1, 5);
    }
    // 格子の外（x = 2.4）に出る手前で止まる
    expect(line.points[(n - 1) * 3]).toBeGreaterThan(2.2);
    expect(line.points[(n - 1) * 3]).toBeLessThanOrEqual(2.4 + 1e-6);
    expect(line.points[3] - line.points[0]).toBeCloseTo(grid.h * 0.5, 5);
  });

  it('斜めの一様流は、その向きにまっすぐ', () => {
    const vf = makeField(() => [1, 1, 0]);
    const line = traceStreamline(vf, [0.3, 0.3, 1]);
    for (let i = 0; i < line.speeds.length; i++) expect(line.points[i * 3 + 1] - 0.3).toBeCloseTo(line.points[i * 3] - 0.3, 4);
  });

  it('剛体回転の渦（z まわり）では、円を描く（半径が 1% 以内で保たれる）', () => {
    const cx = 1.2;
    const cy = 1.2;
    const omega = 2;
    const vf = makeField((x, y) => [-omega * (y - cy), omega * (x - cx), 0]);
    const r0 = 0.6;
    const line = traceStreamline(vf, [cx + r0, cy, 1.2], { maxLength: 2 * Math.PI * r0 * 1.02 });
    const n = line.speeds.length;
    expect(n).toBeGreaterThan(60);
    let minR = Infinity;
    let maxR = 0;
    let turned = 0;
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const dx = line.points[i * 3] - cx;
      const dy = line.points[i * 3 + 1] - cy;
      const r = Math.hypot(dx, dy);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      const a = Math.atan2(dy, dx);
      let da = a - prev;
      if (i > 0) {
        while (da < -Math.PI) da += 2 * Math.PI;
        while (da > Math.PI) da -= 2 * Math.PI;
        turned += da; // 反時計回り（omega > 0）に進む
      }
      prev = a;
      expect(line.points[i * 3 + 2]).toBeCloseTo(1.2, 4);
    }
    expect(minR).toBeGreaterThan(r0 * 0.99);
    expect(maxR).toBeLessThan(r0 * 1.01);
    expect(turned).toBeGreaterThan(2 * Math.PI * 0.95); // ほぼ 1 周した
    expect(line.speeds[0]).toBeCloseTo(omega * r0, 4);
  });

  it('固体のセルに入る手前で止まる。種の点が固体の中なら点は 0 個。よどみ点（速さ 0）でも止まる', () => {
    const vf = makeField(() => [1, 0, 0], (x, y, z) => x > 1 && x < 1.5 && y > 0.8 && y < 1.6 && z > 0.8 && z < 1.6);
    const hit = traceStreamline(vf, [0.2, 1.2, 1.2]);
    const last = hit.points[(hit.speeds.length - 1) * 3];
    expect(last).toBeGreaterThan(0.8);
    expect(last).toBeLessThan(1.05);
    expect(traceStreamline(vf, [1.2, 1.2, 1.2]).speeds.length).toBe(0);
    expect(traceStreamline(vf, [0.2, 2.2, 2.2]).speeds.length).toBeGreaterThan(30); // 脇を通る線は抜ける
    const still = makeField(() => [0, 0, 0]);
    expect(traceStreamline(still, [1, 1, 1]).speeds.length).toBe(1);
  });

  it('buildStreamlines は、すぐ止まった線（点が 1 つ以下）を捨てる', () => {
    const vf = makeField(() => [1, 0, 0], (x) => x > 1 && x < 1.5);
    const lines = buildStreamlines(vf, [[0.2, 1, 1], [1.2, 1, 1], [1.7, 1, 1]]);
    expect(lines).toHaveLength(2);
  });
});

describe('種の点の並べ方', () => {
  const part = { min: [1.0, 1.0, 1.0] as [number, number, number], max: [1.4, 1.2, 1.2] as [number, number, number] };

  it('既定は 12 × 12 = 144 個。+x の流れなら、上流（x が小さい側）の同じ面に並ぶ', () => {
    const seeds = flowSeeds({ grid, part, direction: '+x' });
    expect(seeds).toHaveLength(144);
    const x0 = seeds[0][0];
    expect(x0).toBeCloseTo(3 * grid.h, 6);
    for (const s of seeds) {
      expect(s[0]).toBeCloseTo(x0, 6);
      for (let a = 0; a < 3; a++) {
        expect(s[a]).toBeGreaterThan(grid.origin[a]);
        expect(s[a]).toBeLessThan(grid.origin[a] + [grid.nx, grid.ny, grid.nz][a] * grid.h);
      }
    }
  });

  it('向きが −z なら上流は z の大きい側。数は count で変えられる', () => {
    const seeds = flowSeeds({ grid, part, direction: '-z', count: [4, 3] });
    expect(seeds).toHaveLength(12);
    for (const s of seeds) expect(s[2]).toBeCloseTo(grid.origin[2] + (grid.nz - 3) * grid.h, 6);
  });

  it('部品の中心のまわりに寄っている（真ん中の間隔が、外側の間隔より狭い）。中心に対して対称', () => {
    const seeds = flowSeeds({ grid, part, direction: '+x', count: [12, 1] });
    const ys = seeds.map((s) => s[1]);
    const mid = ys[6] - ys[5];
    const edge = ys[1] - ys[0];
    expect(mid).toBeLessThan(edge);
    expect((ys[0] + ys[11]) / 2).toBeCloseTo(1.1, 5); // 中心 y = 1.1 の両側
  });

  it('部品が薄い方向にも、ある程度の広がりを持つ（D の 3 割以上）', () => {
    const seeds = flowSeeds({ grid, part, direction: '+x', count: [1, 12] });
    const zs = seeds.map((s) => s[2]);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.3 * 0.2);
  });
});

describe('線分と色', () => {
  it('隣り合う点ごとに 1 本。速い線ほど高い色番号', () => {
    const lines = [
      { points: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]), speeds: Float32Array.from([1, 1, 1]) },
      { points: Float32Array.from([0, 1, 0, 1, 1, 0]), speeds: Float32Array.from([3, 3]) },
    ];
    const range = streamlineSpeedRange(lines);
    expect(range).toEqual({ min: 1, max: 3 });
    const seg = streamlineSegments(lines, range);
    expect(seg.count).toBe(3);
    expect(seg.positions.length).toBe(18);
    expect(seg.colors.length).toBe(18);
    // 最初の線は最小の色、2 本目は最大の色（turbo は青系 → 赤系）
    const rgb = (t: number): number[] => colormapRGB('turbo', t).map((c) => c / 255);
    expect(Array.from(seg.colors.slice(0, 3))).toEqual(rgb(0).map((c) => Math.fround(c)));
    expect(Array.from(seg.colors.slice(12, 15))).toEqual(rgb(1).map((c) => Math.fround(c)));
    expect(streamlineSpeedRange([])).toEqual({ min: 0, max: 1 });
  });
});
