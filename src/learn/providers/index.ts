// 解析の種類 → 数学の窓の式の提供者。
import type { AnalysisKind } from '../../core/types';
import type { MathProvider } from '../types';
import { emProvider } from './em';
import { flowProvider } from './flow';
import { heatProvider } from './heat';
import { scalarProvider } from './scalar';
import { stressProvider } from './stress';

export const MATH_PROVIDERS: Record<AnalysisKind, MathProvider> = {
  stress: stressProvider,
  heat: heatProvider,
  flow: flowProvider,
  em: emProvider,
  scalar: scalarProvider,
};

export function getMathProvider(kind: AnalysisKind): MathProvider {
  return MATH_PROVIDERS[kind];
}

export { emProvider, flowProvider, heatProvider, scalarProvider, stressProvider };
