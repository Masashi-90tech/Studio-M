// レッスンの確認（check）で使う小さな関数。アプリの状態（project / result）だけを見る。
import type { Project } from '../../core/types';
import { bodies, boxOf, scalarOf } from '../providers/common';
import type { LearnContext } from '../types';

export { scalarOf };

/** 荷重の合計 |fy| [N] */
export function totalLoad(project: Project): number {
  return project.shapes.filter((s) => s.role === 'load').reduce((a, s) => a + Math.abs(s.force?.fy ?? 0), 0);
}

/** 材料 ID が id の物体の面積の合計（bounding box で数える）[m²] */
export function areaOfMaterial(project: Project, materialId: string): number {
  return bodies(project)
    .filter((s) => s.materialId === materialId)
    .reduce((a, s) => {
      const b = boxOf(s.geom);
      return a + (b.x1 - b.x0) * (b.y1 - b.y0);
    }, 0);
}

/** 解析の種類が kind の結果が出ているか */
export function hasResult(ctx: LearnContext, kind: string): boolean {
  return ctx.result !== null && ctx.result.analysis === kind;
}

/** 物体の中で、名前が part を含む形の数 */
export function countNamed(project: Project, part: string): number {
  return bodies(project).filter((s) => s.name.includes(part)).length;
}
