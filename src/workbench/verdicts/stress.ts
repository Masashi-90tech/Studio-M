// 強度の判定。DOM に触れない純粋関数だけを置く。
import type { Project } from '../../core/types';
import { kgToNewton, newtonToKg } from '../../core/units';
import { formatNumber, formatQuantity } from '../../ui/format';
import { setBodyMaterial } from '../../ui/easy-logic';
import type { Prefs } from '../../ui/modes';
import { isFinished, makeVerdict, scalarOf, waitingVerdict } from '../verdict-kit';
import type { Verdict, VerdictAction, VerdictInput, VerdictLevel } from '../types';

export { kgToNewton, newtonToKg };

export function stressVerdict(safety: number, maxDispM: number, target: number, goal: Prefs['stressGoal'], hasStress = true): Verdict {
  if (!hasStress || !Number.isFinite(safety)) {
    return makeVerdict('info', '力がほとんどかかっていません', ['荷重を置くか、重さを入れてみましょう。']);
  }
  const s = formatNumber(safety, 2);
  const disp = formatQuantity(maxDispM, 'm', 3);
  const bend = `いちばん動くところで ${disp} たわみます。`;
  let level: VerdictLevel;
  let text: string;
  if (safety >= target) {
    level = 'ok';
    text = `余裕があります（安全率 ${s}）`;
  } else if (safety >= 1) {
    level = 'warn';
    text = `使えますが余裕が足りません（安全率 ${s}、目標 ${formatNumber(target, 2)}）`;
  } else {
    level = 'ng';
    text = `壊れる可能性が高いです（安全率 ${s}）`;
  }
  if (goal === 'bend') {
    return makeVerdict(level, `いちばん動くところで ${disp} たわみます`, [text]);
  }
  return makeVerdict(level, text, [bend]);
}

/** 代表の材料（最初の物体） */
function mainMaterialId(project: Project): string | undefined {
  return project.shapes.find((s) => s.role === 'solid' || s.role === 'heatSource')?.materialId;
}

export function stressActions(project: Project): VerdictAction[] {
  const cur = mainMaterialId(project);
  const out: VerdictAction[] = [{ kind: 'thicker', factor: 1.5, label: '厚みを増やす（奥行き ×1.5）' }];
  if (cur !== 'petg') out.push({ kind: 'material', materialId: 'petg', label: '材料を PETG にする（粘りがある）' });
  if (cur !== 'al6061') out.push({ kind: 'material', materialId: 'al6061', label: '材料をアルミにする' });
  else out.push({ kind: 'material', materialId: 'ss400', label: '材料を鉄にする' });
  return out;
}

/** ワークベンチの判定 */
export function stressWorkbenchVerdict(inp: VerdictInput): Verdict | null {
  const { project, result, status, prefs } = inp;
  if (!result || !status || !isFinished(status)) return waitingVerdict(status);
  const safety = scalarOf(result, 'minSafety');
  const disp = scalarOf(result, 'maxDisplacement') ?? 0;
  const vm = scalarOf(result, 'maxVonMises') ?? 0;
  const v = stressVerdict(safety ?? NaN, disp, prefs.safetyTarget, prefs.stressGoal, vm > 0);
  if (v.level === 'warn' || v.level === 'ng') v.actions.push(...stressActions(project));
  return v;
}

/** 次の一手を反映する */
export function applyStressAction(opts: { project: Project; action: VerdictAction }): void {
  const { project, action } = opts;
  if (action.kind === 'thicker') project.thickness *= action.factor;
  else if (action.kind === 'material') setBodyMaterial(project, action.materialId);
}
