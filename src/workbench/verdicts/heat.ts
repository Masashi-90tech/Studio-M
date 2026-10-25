// 熱の判定。DOM に触れない純粋関数だけを置く。
import type { Field, Material, Project, Raster, ResultSet } from '../../core/types';
import { formatNumber } from '../../ui/format';
import { setBodyMaterial } from '../../ui/easy-logic';
import { isFinished, makeVerdict, scalarOf, tryMaterial, waitingVerdict } from '../verdict-kit';
import type { Verdict, VerdictAction, VerdictInput, VerdictLevel } from '../types';

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

/** 余裕 [K] がこれ以上なら OK、0 以上なら注意、負なら NG */
export const PART_OK_MARGIN_K = 10;

/** 部品ごとの結果（ResultSet.perShape）を表と判定で使いやすい形にしたもの */
export interface PartRow {
  shapeId: string;
  label: string;
  /** 発熱 [W] */
  heatW: number;
  maxC: number;
  avgC: number;
  /** 上限温度 [°C]。決まっていなければ undefined */
  limitC?: number;
  /** 上限 − 最高 [K]。上限がなければ undefined */
  marginC?: number;
}

/** 余裕から OK / 注意 / NG を決める（表の色分けと判定で共通） */
export function marginLevel(marginC: number): VerdictLevel {
  return marginC >= PART_OK_MARGIN_K ? 'ok' : marginC >= 0 ? 'warn' : 'ng';
}

/** 部品ごとの結果を行にする。余裕の少ない順（上限のない部品は最後に、高温の順） */
export function partRows(result: ResultSet | null): PartRow[] {
  const rows: PartRow[] = [];
  for (const p of result?.perShape ?? []) {
    const v = (key: string): number | undefined => {
      const x = p.values.find((s) => s.key === key);
      return x && Number.isFinite(x.value) ? x.value : undefined;
    };
    const maxC = v('maxTemp');
    if (maxC === undefined) continue;
    rows.push({ shapeId: p.shapeId, label: p.label, heatW: v('heatW') ?? 0, maxC, avgC: v('avgTemp') ?? maxC, limitC: v('limitC'), marginC: v('marginC') });
  }
  return rows.sort((a, b) => {
    if (a.marginC !== undefined && b.marginC !== undefined) return a.marginC - b.marginC;
    if (a.marginC !== undefined) return -1;
    if (b.marginC !== undefined) return 1;
    return b.maxC - a.maxC;
  });
}

const deg = (v: number): string => `${formatNumber(v, 3)}°C`;

/** 部品ごとの上限で判定する。いちばん余裕の少ない部品の名前を出す。rows は上限のある部品だけを余裕の少ない順に */
export function partsVerdict(rows: PartRow[], ambientC: number): Verdict {
  const worst = rows[0];
  const margin = worst.marginC ?? 0;
  const level = marginLevel(margin);
  const lim = deg(worst.limitC ?? 0);
  const others = rows.slice(1).filter((r) => (r.marginC ?? Infinity) < PART_OK_MARGIN_K);
  const lines: string[] = [];
  if (level === 'ng') lines.push(`上限より ${formatNumber(-margin, 2)} K 高くなっています。冷やすか、発熱を減らしてください。`);
  else if (level === 'warn') lines.push(`上限まであと ${formatNumber(margin, 2)} K です。周囲が暑い日や長時間の動作で超えるかもしれません。`);
  else lines.push(`いちばん厳しい部品でも、上限まで ${formatNumber(margin, 2)} K の余裕があります。`);
  if (others.length > 0) {
    const names = others.slice(0, 3).map((r) => `${r.label}（${deg(r.maxC)} / 上限 ${deg(r.limitC ?? 0)}）`);
    lines.push(`ほかに余裕の少ない部品: ${names.join('、')}${others.length > 3 ? ` ほか ${others.length - 3} 個` : ''}`);
  }
  lines.push(`室温 ${deg(ambientC)} より ${formatNumber(Math.max(0, worst.maxC - ambientC), 2)} K 高くなります（${worst.label}）。`);
  if (level === 'ng') return makeVerdict('ng', `${worst.label} が ${deg(worst.maxC)} で、上限 ${lim} を超えます`, lines);
  if (level === 'warn') return makeVerdict('warn', `${worst.label} は ${deg(worst.maxC)} で、上限 ${lim} ぎりぎりです`, lines);
  return makeVerdict('ok', `すべての部品が上限に収まっています（最大 ${worst.label} ${deg(worst.maxC)} / 上限 ${lim}）`, lines);
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

/** 銅箔の厚さを何倍にするか（1oz = 35 µm → 2oz = 70 µm） */
const COPPER_FACTOR = 2;

/** 基板（KiCad から取り込んだ project.pcb）の判定で出す次の一手 */
export function pcbActions(project: Project, hottest: PartRow | undefined): VerdictAction[] {
  const out: VerdictAction[] = [];
  const next = nextCooling(project.heat.surfaceH);
  if (next) out.push({ kind: 'cooling', h: next.h, label: `ファンで冷やす（冷やし方を「${next.label}」に）` });
  const layers = project.pcb?.layers ?? [];
  if (layers.length > 0 && Math.max(...layers.map((l) => l.thicknessUm)) < 35 * COPPER_FACTOR - 1) {
    out.push({ kind: 'copper', factor: COPPER_FACTOR, label: '2oz 銅箔にする（銅箔の厚さを 2 倍）' });
  }
  if (hottest && hottest.heatW > 0) out.push({ kind: 'review', shapeId: hottest.shapeId, label: `発熱を見直す（${hottest.label} を選ぶ）` });
  return out;
}

/** ワークベンチの判定 */
export function heatWorkbenchVerdict(inp: VerdictInput): Verdict | null {
  const { project, result, status } = inp;
  if (!result || !status || !isFinished(status)) return waitingVerdict(status);
  const maxT = scalarOf(result, 'maxTemp');
  if (maxT === undefined) return null;
  // 部品ごとに上限温度が分かるとき（基板など）は、いちばん余裕の少ない部品で判定する
  const limited = partRows(result).filter((r) => r.marginC !== undefined);
  if (limited.length > 0) {
    const v = partsVerdict(limited, project.heat.ambientC);
    if (v.level === 'warn' || v.level === 'ng') {
      if (project.pcb) {
        v.lines.push('銅ベタ（広い銅箔）を部品の下に広げると、熱が基板全体に広がって最高温度が下がります。銅箔の形は基板エディタ（KiCad）側で直してください。');
        v.actions.push(...pcbActions(project, limited[0]));
      } else v.actions.push(...heatActions(project));
    }
    return v;
  }
  const temp = result.fields.find((f) => f.key === 'temperature');
  const v = heatVerdict(maxT, project.heat.ambientC, materialTempLimits(temp, inp.raster));
  if (v.level === 'warn' || v.level === 'ng') v.actions.push(...heatActions(project));
  return v;
}

/** 次の一手を反映する。熱では、発熱体（チップなど）の材料は変えずに、まわりの部品だけを替える */
export function applyHeatAction(opts: { project: Project; action: VerdictAction; selectShape?: (shapeId: string | null) => void }): void {
  const { project, action } = opts;
  if (action.kind === 'material') setBodyMaterial(project, action.materialId, ['solid']);
  else if (action.kind === 'cooling') project.heat.surfaceH = action.h;
  else if (action.kind === 'copper') for (const l of project.pcb?.layers ?? []) l.thicknessUm *= action.factor;
  else if (action.kind === 'review') opts.selectShape?.(action.shapeId);
}
