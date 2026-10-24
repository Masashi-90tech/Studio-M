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
