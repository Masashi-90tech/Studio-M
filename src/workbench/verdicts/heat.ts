// 熱の判定。DOM に触れない純粋関数だけを置く。
import type { Field, Material, Project, Raster } from '../../core/types';
import { formatNumber } from '../../ui/format';
import { setBodyMaterial } from '../../ui/easy-logic';
import { isFinished, makeVerdict, scalarOf, tryMaterial, waitingVerdict } from '../verdict-kit';
import type { Verdict, VerdictAction, VerdictInput } from '../types';

export interface TempLimit {
  materialId: string;
  name: string;
  /** その材料の部分の最高温度 [°C] */
  maxC: number;
  /** 使用上限の目安 [°C] */
  limitC: number;
}

const SOFTENING = new Set(['pla', 'petg', 'abs']);

/** 耐熱温度が決まっている材料ごとに、その部分の最高温度を調べる。余裕の少ない順 */
export function materialTempLimits(temp: Field | undefined, raster: Raster | null, lookup: (id: string) => Material | undefined = tryMaterial): TempLimit[] {
  if (!temp || !raster || temp.data.length !== raster.solid.length) return [];
  const best = new Map<string, number>();
  for (let c = 0; c < temp.data.length; c++) {
    const id = raster.materialId[c];
    if (!id || (temp.mask && temp.mask[c] === 0)) continue;
    const v = temp.data[c];
    if (!Number.isFinite(v)) continue;
    const prev = best.get(id);
    if (prev === undefined || v > prev) best.set(id, v);
  }
  const out: TempLimit[] = [];
  for (const [id, maxC] of best) {
    const m = lookup(id);
    if (m && m.maxTempC !== undefined) out.push({ materialId: id, name: m.name, maxC, limitC: m.maxTempC });
  }
  return out.sort((a, b) => a.limitC - a.maxC - (b.limitC - b.maxC));
}

export function heatVerdict(maxTemp: number, ambientC: number, limits: TempLimit[]): Verdict {
  const T = `${formatNumber(maxTemp, 3)}°C`;
  const rise = `室温 ${formatNumber(ambientC, 3)}°C より ${formatNumber(Math.max(0, maxTemp - ambientC), 2)}°C 高くなります。`;
  const worst = limits[0];
  if (!worst) return makeVerdict('info', `いちばん熱いところは ${T} です`, [rise]);
  const lim = `${worst.name}の耐熱の目安は ${formatNumber(worst.limitC, 3)}°C`;
  const partT = `${worst.name}の部分は最高 ${formatNumber(worst.maxC, 3)}°C`;
  const name = worst.name.replace(/（.*$/, '');
  if (worst.maxC <= worst.limitC - 10) {
    return makeVerdict('ok', `${name}の耐熱温度に余裕があります（最高 ${T}）`, [`${partT}。${lim}。`, rise]);
  }
  if (worst.maxC <= worst.limitC) {
    return makeVerdict('warn', `${name}の耐熱温度ぎりぎりです（最高 ${T}）`, [`${partT}。${lim}。`, rise]);
  }
  const what = SOFTENING.has(worst.materialId) ? `${name}が軟化する温度を超えます` : `${name}の耐熱温度を超えます`;
  return makeVerdict('ng', `${what}（最高 ${T}）`, [`${partT}。${lim}。`, rise]);
}

/** 冷やし方の目安（W/m²K）。かんたんモードの 3 段階 */
export const COOLING_LEVELS: { h: number; label: string }[] = [
  { h: 7, label: '自然放置' },
  { h: 25, label: '小型ファン' },
  { h: 60, label: '強いファン' },
];

/** いまより強い冷やし方（なければ undefined） */
export function nextCooling(currentH: number): { h: number; label: string } | undefined {
  return COOLING_LEVELS.find((c) => c.h > currentH * 1.2);
}

/** 代表の材料（最初の物体） */
function mainMaterialId(project: Project): string | undefined {
  return project.shapes.find((s) => s.role === 'solid' || s.role === 'heatSource')?.materialId;
}

export function heatActions(project: Project): VerdictAction[] {
  const out: VerdictAction[] = [];
  const next = nextCooling(project.heat.surfaceH);
  if (next) out.push({ kind: 'cooling', h: next.h, label: `冷やし方を「${next.label}」にする` });
  const cur = mainMaterialId(project);
  if (cur !== 'al6061') out.push({ kind: 'material', materialId: 'al6061', label: '材料をアルミにする（熱を逃がす）' });
  return out;
}

/** ワークベンチの判定 */
export function heatWorkbenchVerdict(inp: VerdictInput): Verdict | null {
  const { project, result, status } = inp;
  if (!result || !status || !isFinished(status)) return waitingVerdict(status);
  const maxT = scalarOf(result, 'maxTemp');
  if (maxT === undefined) return null;
  const temp = result.fields.find((f) => f.key === 'temperature');
  const v = heatVerdict(maxT, project.heat.ambientC, materialTempLimits(temp, inp.raster));
  if (v.level === 'warn' || v.level === 'ng') v.actions.push(...heatActions(project));
  return v;
}

/** 次の一手を反映する。熱では、発熱体（チップなど）の材料は変えずに、まわりの部品だけを替える */
export function applyHeatAction(opts: { project: Project; action: VerdictAction }): void {
  const { project, action } = opts;
  if (action.kind === 'material') setBodyMaterial(project, action.materialId, ['solid']);
  else if (action.kind === 'cooling') project.heat.surfaceH = action.h;
}
