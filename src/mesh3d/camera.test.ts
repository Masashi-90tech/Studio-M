import { describe, expect, it } from 'vitest';
import { DEFAULT_ORBIT, DIST_MAX, DIST_MIN, cameraPosition, orbitBy, orbitMatrices, project, wheelFactor, zoomBy } from './camera';

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
