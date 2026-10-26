import { describe, expect, it } from 'vitest';
import { DEFAULT_ORBIT, DIST_MAX, DIST_MIN, cameraPosition, fitOrbit, orbitBy, orbitMatrices, project, screenRay, wheelFactor, zoomBy, type Vec3 } from './camera';

describe('軌道カメラ', () => {
  it('注視点（原点）は画面の中央に、カメラの前（奥行き -1～1 の内側）に映る', () => {
    const { viewProj } = orbitMatrices(DEFAULT_ORBIT, 1.5);
    const [x, y, z] = project(viewProj, [0, 0, 0]);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(0, 5);
    expect(z).toBeGreaterThan(-1);
    expect(z).toBeLessThan(1);
  });

  it('Z が上: +Z の点は画面の上、カメラに近い点ほど手前（奥行きが小さい）', () => {
    const { viewProj } = orbitMatrices({ yaw: 0.3, pitch: 0.2, dist: 3 }, 1);
    expect(project(viewProj, [0, 0, 0.5])[1]).toBeGreaterThan(project(viewProj, [0, 0, 0])[1]);
    const cam = cameraPosition({ yaw: 0.3, pitch: 0.2, dist: 3 });
    const near = project(viewProj, [cam[0] * 0.2, cam[1] * 0.2, cam[2] * 0.2]);
    const far = project(viewProj, [-cam[0] * 0.2, -cam[1] * 0.2, -cam[2] * 0.2]);
    expect(near[2]).toBeLessThan(far[2]);
  });

  it('ドラッグで回り、仰角は真上・真下を越えない', () => {
    const r = orbitBy(DEFAULT_ORBIT, 100, 0);
    expect(r.yaw).not.toBe(DEFAULT_ORBIT.yaw);
    expect(r.pitch).toBe(DEFAULT_ORBIT.pitch);
    expect(orbitBy(DEFAULT_ORBIT, 0, 1e6).pitch).toBeLessThan(Math.PI / 2);
    expect(orbitBy(DEFAULT_ORBIT, 0, -1e6).pitch).toBeGreaterThan(-Math.PI / 2);
  });

  it('拡大縮小は範囲内に収まる。ホイールの向きで遠ざかる / 近づく', () => {
    expect(zoomBy(DEFAULT_ORBIT, 1e-6).dist).toBe(DIST_MIN);
    expect(zoomBy(DEFAULT_ORBIT, 1e6).dist).toBe(DIST_MAX);
    expect(wheelFactor(100)).toBeGreaterThan(1);
    expect(wheelFactor(-100)).toBeLessThan(1);
    expect(wheelFactor(1e9)).toBeLessThan(2);
  });
});

describe('画面の位置を通る光線', () => {
  const dist = (r: { origin: Vec3; dir: Vec3 }, p: Vec3): number => {
    const w: Vec3 = [p[0] - r.origin[0], p[1] - r.origin[1], p[2] - r.origin[2]];
    const t = w[0] * r.dir[0] + w[1] * r.dir[1] + w[2] * r.dir[2];
    return Math.hypot(w[0] - t * r.dir[0], w[1] - t * r.dir[1], w[2] - t * r.dir[2]);
  };

  it('画面の中央を通る光線は、注視点（原点）に向かう', () => {
    const r = screenRay(DEFAULT_ORBIT, 1.5, 0, 0);
    expect(dist(r, [0, 0, 0])).toBeLessThan(1e-9);
    expect(Math.hypot(...r.dir)).toBeCloseTo(1, 9);
  });

  it('点を画面に映した位置から光線を作ると、その点を通る（project と逆の関係）', () => {
    for (const orbit of [DEFAULT_ORBIT, { yaw: 1.2, pitch: -0.4, dist: 5 }, { yaw: -2.5, pitch: 0.9, dist: 2 }]) {
      const aspect = 1.7;
      const { viewProj } = orbitMatrices(orbit, aspect);
      for (const p of [[0.3, -0.4, 0.2], [-0.5, 0.1, 0.6], [0.7, 0.7, -0.3]] as Vec3[]) {
        const [x, y] = project(viewProj, p);
        expect(dist(screenRay(orbit, aspect, x, y), p)).toBeLessThan(1e-4);
      }
    }
  });
});

describe('縦長の画面', () => {
  it('横長・正方形はそのまま。縦長は、はみ出さないよう遠ざける（下限あり）', () => {
    expect(fitOrbit(DEFAULT_ORBIT, 1.5)).toBe(DEFAULT_ORBIT);
    expect(fitOrbit(DEFAULT_ORBIT, 0.5).dist).toBeCloseTo(DEFAULT_ORBIT.dist * 2, 9);
    expect(fitOrbit(DEFAULT_ORBIT, 0.1).dist).toBeCloseTo(DEFAULT_ORBIT.dist / 0.4, 9);
  });
});
