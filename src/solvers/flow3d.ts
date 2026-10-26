// 3D の流れ（Lite、ボクセルの格子ボルツマン法）。【仮】入口だけ。中身は別の作業で差し替える。
// 契約: types.ts の Solver3DFactory と Flow3DSettings。格子は grid3d.ts の studyGrid（風洞全体）。
import { flow3DDefaults, flowAxis, studyGrid } from '../core/grid3d';
import type { ResultSet3D, Solver3D, Solver3DFactory, Study3D } from '../core/types';

export const createFlow3DSolver: Solver3DFactory = (study: Study3D): Solver3D => {
  const grid = studyGrid(study);
  const flow = study.flow ?? flow3DDefaults();
  const { axis, sign } = flowAxis(flow.direction);
  const n = grid.nx * grid.ny * grid.nz;
  const mask = new Uint8Array(n).fill(1);
  const speed = new Float32Array(n).fill(flow.inletVelocity);
  const comp = [0, 1, 2].map((a) => new Float32Array(n).fill(a === axis ? sign * flow.inletVelocity : 0));
  const result: ResultSet3D = {
    analysis: 'flow',
    grid,
    fields: [
      { key: 'speed', label: '流速', unit: 'm/s', data: speed, mask },
      { key: 'ux', label: '流速 x', unit: 'm/s', data: comp[0], mask },
      { key: 'uy', label: '流速 y', unit: 'm/s', data: comp[1], mask },
      { key: 'uz', label: '流速 z', unit: 'm/s', data: comp[2], mask },
      { key: 'pressure', label: '圧力', unit: 'Pa', data: new Float32Array(n), mask, diverging: true },
    ],
    scalars: [{ key: 'drag', label: '抗力', unit: 'N', value: 0 }],
    history: [],
    warnings: ['3D の流れはまだ仮の実装です（一様な流れを返すだけ）'],
  };
  return { analysis: 'flow', step: () => ({ done: false, progress: 0, iteration: 0 }), result: () => result };
};
