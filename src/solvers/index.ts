// 互換用の同期ファクトリー（テストや Node スクリプトで、ソルバーをすぐ作りたいとき用）。
// 画面は使わない: 5 つのソルバーを全部静的に読み込んでしまうので、画面からは
// src/workbench の登録表（loadSolverFactory / createSolver）を使い、解析を開くときだけ遅延 import する。
import type { AnalysisKind, Project, Raster, Solver } from '../core/types';
import { createFlowSolver } from './flow';
import { createHeatSolver } from './heat';
import { createStressSolver } from './stress';
import { createScalarSolver } from './scalar';
import { createEMSolver } from './em';

export function createSolver(kind: AnalysisKind, project: Project, raster: Raster): Solver {
  switch (kind) {
    case 'flow':
      return createFlowSolver(project, raster);
    case 'heat':
      return createHeatSolver(project, raster);
    case 'stress':
      return createStressSolver(project, raster);
    case 'scalar':
      return createScalarSolver(project, raster);
    case 'em':
      return createEMSolver(project, raster);
  }
}
