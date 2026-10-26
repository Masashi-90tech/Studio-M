// 3D の定常熱伝導（Lite、ボクセル）。【仮】入口だけ。中身は別の作業で差し替える。
// 契約: types.ts の Solver3DFactory。格子は grid3d.ts の studyGrid（エンジンと同じ格子）。
import { studyGrid } from '../core/grid3d';
import type { ResultSet3D, Solver3D, Solver3DFactory, Study3D } from '../core/types';

export const createHeat3DSolver: Solver3DFactory = (study: Study3D): Solver3D => {
  const grid = studyGrid(study);
  const n = grid.nx * grid.ny * grid.nz;
  const temp = new Float32Array(n).fill(study.heat.ambientC);
  const mask = new Uint8Array(n).fill(1);
  const result: ResultSet3D = {
    analysis: 'heat',
    grid,
    fields: [{ key: 'temp', label: '温度', unit: '°C', data: temp, mask }],
    scalars: [{ key: 'maxTemp', label: '最高温度', unit: '°C', value: study.heat.ambientC }],
    history: [],
    warnings: ['3D の熱解析はまだ仮の実装です（周囲の温度を返すだけ）'],
  };
  return {
    analysis: 'heat',
    step: () => ({ done: true, progress: 1, iteration: 0 }),
    result: () => result,
  };
};
