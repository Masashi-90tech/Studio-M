// ワークベンチの入口。組み込みの 5 つの解析をここで登録する。画面は './workbench' だけを import する。
import { registerWorkbench } from './registry';
import { emWorkbench } from './modules/em';
import { flowWorkbench } from './modules/flow';
import { heatWorkbench } from './modules/heat';
import { scalarWorkbench } from './modules/scalar';
import { stressWorkbench } from './modules/stress';

for (const wb of [flowWorkbench, heatWorkbench, stressWorkbench, emWorkbench, scalarWorkbench]) registerWorkbench(wb);

export * from './registry';
export type * from './types';
