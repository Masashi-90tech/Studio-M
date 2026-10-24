// 結果の判定（OK / 注意 / NG）。DOM に触れない純粋関数だけを置く。
// 「大丈夫？」にまず答え、数字は後から見せるための部品。
import { getMaterial } from '../core/materials';
import type { AnalysisKind, Field, Material, Project, Raster, ResultSet, Shape, SolverStatus } from '../core/types';
import { formatNumber, formatQuantity } from './format';
import type { Prefs } from './modes';

export type VerdictLevel = 'ok' | 'warn' | 'ng' | 'info' | 'pending';

/** 次の一手（かんたんモードのボタン）。適用は verdict-card.ts */
export type VerdictAction =
  | { kind: 'thicker'; factor: number; label: string }
  | { kind: 'material'; materialId: string; label: string }
  | { kind: 'cooling'; h: number; label: string }
  | { kind: 'slab'; thicknessMm: number; label: string };

export interface Verdict {
  level: VerdictLevel;
  /** チップに出す短い文字（OK / 注意 / NG / 目安 / 計算中） */
  chip: string;
  /** いちばん大きく見せる一文 */
  headline: string;
  /** 補足の行 */
  lines: string[];
  actions: VerdictAction[];
}

export const CHIP_TEXT: Record<VerdictLevel, string> = { ok: 'OK', warn: '注意', ng: 'NG', info: '目安', pending: '計算中' };

/** 平板（空気中）の電力透過率。solvers/em.ts の slabTransmission と同じ形 */
export type SlabFn = (epsR: number, tanD: number, thicknessM: number, freqHz: number) => { transmission: number; reflection: number };

/** 重さ [kg] → 力 [N]（重力加速度 9.81 m/s²） */
export const GRAVITY = 9.81;
export const kgToNewton = (kg: number): number => kg * GRAVITY;
export const newtonToKg = (n: number): number => n / GRAVITY;

export function scalarOf(r: ResultSet | null, key: string): number | undefined {
  const s = r?.scalars.find((x) => x.key === key);
  return s && Number.isFinite(s.value) ? s.value : undefined;
}

const verdict = (level: VerdictLevel, headline: string, lines: string[] = [], actions: VerdictAction[] = []): Verdict => ({
  level,
  chip: CHIP_TEXT[level],
  headline,
  lines,
  actions,
});

// ---------- 強度 ----------

export function stressVerdict(safety: number, maxDispM: number, target: number, goal: Prefs['stressGoal'], hasStress = true): Verdict {
  if (!hasStress || !Number.isFinite(safety)) {
    return verdict('info', '力がほとんどかかっていません', ['荷重を置くか、重さを入れてみましょう。']);
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
    return verdict(level, `いちばん動くところで ${disp} たわみます`, [text]);
  }
  return verdict(level, text, [bend]);
}

// ---------- 熱 ----------

export interface TempLimit {
  materialId: string;
  name: string;
  /** その材料の部分の最高温度 [°C] */
  maxC: number;
  /** 使用上限の目安 [°C] */
  limitC: number;
}

const SOFTENING = new Set(['pla', 'petg', 'abs']);

function tryMaterial(id: string): Material | undefined {
  try {
    return getMaterial(id);
  } catch {
    return undefined;
  }
}

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
  if (!worst) return verdict('info', `いちばん熱いところは ${T} です`, [rise]);
  const lim = `${worst.name}の耐熱の目安は ${formatNumber(worst.limitC, 3)}°C`;
  const partT = `${worst.name}の部分は最高 ${formatNumber(worst.maxC, 3)}°C`;
  const name = worst.name.replace(/（.*$/, '');
  if (worst.maxC <= worst.limitC - 10) {
    return verdict('ok', `${name}の耐熱温度に余裕があります（最高 ${T}）`, [`${partT}。${lim}。`, rise]);
  }
  if (worst.maxC <= worst.limitC) {
    return verdict('warn', `${name}の耐熱温度ぎりぎりです（最高 ${T}）`, [`${partT}。${lim}。`, rise]);
  }
  const what = SOFTENING.has(worst.materialId) ? `${name}が軟化する温度を超えます` : `${name}の耐熱温度を超えます`;
  return verdict('ng', `${what}（最高 ${T}）`, [`${partT}。${lim}。`, rise]);
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

// ---------- 電磁波 ----------

/** 平板と見なせる物体: 金属でない長方形が 1 つだけで、領域の高さの大半に渡る */
export function findSlab(project: Project): { shape: Shape; thicknessM: number; material: Material } | null {
  const bodies = project.shapes.filter((s) => s.role === 'solid' || s.role === 'heatSource');
  if (bodies.length !== 1) return null;
  const shape = bodies[0];
  if (shape.geom.kind !== 'rect') return null;
  const material = tryMaterial(shape.materialId);
  if (!material || material.conductor || material.kind !== 'solid') return null;
  if (shape.geom.h < project.domain.height * 0.5 || shape.geom.h < shape.geom.w * 2) return null;
  return { shape, thicknessM: shape.geom.w, material };
}

export interface SlabRecommendation {
  thicknessMm: number;
  /** その厚みでの透過 [%] */
  transmissionPct: number;
}

/**
 * 厚み 0.5〜10 mm を 0.1 mm 刻みで調べ、1 mm 以上でいちばん薄く、透過が最大になる厚みを返す。
 * （薄いほど軽く安いので、同じ透過率なら薄い方）
 */
export function recommendSlab(epsR: number, tanD: number, freqHz: number, slab: SlabFn, minMm = 1, maxMm = 10): SlabRecommendation | null {
  const steps: { mm: number; t: number }[] = [];
  for (let k = 5; k <= Math.round(maxMm * 10); k++) {
    const mm = k / 10;
    const t = slab(epsR, tanD, mm / 1000, freqHz).transmission;
    if (Number.isFinite(t)) steps.push({ mm, t });
  }
  const eligible = steps.filter((s) => s.mm >= minMm - 1e-9);
  if (eligible.length === 0) return null;
  const peak = Math.max(...eligible.map((s) => s.t));
  const pick = eligible.find((s) => s.t >= peak - 0.002) ?? eligible[0];
  return { thicknessMm: pick.mm, transmissionPct: pick.t * 100 };
}

/** 割合 [%] の表示。物理的には 100% を超えないので、2D 計算の端の影響で超えた分は 100% に丸める */
export function pctText(v: number): string {
  return `${formatNumber(Math.min(100, Math.max(0, v)), 3)}%`;
}

export function emVerdict(
  transmissionPct: number,
  reflectionPct: number | undefined,
  goal: Prefs['emGoal'],
  hasConductor: boolean,
  rec: SlabRecommendation | null,
  currentMm: number | null,
): Verdict {
  const T = pctText(transmissionPct);
  const lines: string[] = [];
  if (reflectionPct !== undefined) lines.push(`反射 ${pctText(reflectionPct)}、通過 ${T}。残りは材料に吸収されたり、まわりへ回り込んだりします。`);
  if (transmissionPct > 105) lines.push('2D の計算では、物体の縁で電波が回り込んで集まり、100% を超えて見えることがあります。');
  if (hasConductor) lines.push('金属は電波をほとんど通さず、反射します。');
  const actions: VerdictAction[] = [];
  let level: VerdictLevel;
  let text: string;
  if (transmissionPct >= 90) {
    level = 'ok';
    text = `電波はほとんど素通りします（透過 ${T}）`;
  } else if (transmissionPct >= 70) {
    level = 'warn';
    text = `電波がやや弱くなります（透過 ${T}）`;
  } else {
    level = 'ng';
    text = `電波がかなり弱くなります（透過 ${T}）`;
  }
  if (rec) {
    lines.push(`おすすめの厚み: ${formatNumber(rec.thicknessMm, 3)} mm（透過 ${formatNumber(rec.transmissionPct, 3)}%）`);
    const differs = currentMm === null || Math.abs(rec.thicknessMm - currentMm) > 0.049;
    if (level !== 'ok' && differs) actions.push({ kind: 'slab', thicknessMm: rec.thicknessMm, label: `厚みを ${formatNumber(rec.thicknessMm, 3)} mm にする` });
  }
  if (goal === 'reflect') {
    const R = reflectionPct !== undefined ? pctText(reflectionPct) : '—';
    return verdict('info', `反射 ${R}、通過 ${T}`, lines.filter((l) => !l.startsWith('反射')), []);
  }
  return verdict(level, text, lines, actions);
}

// ---------- 流れ ----------

/** レイノルズ数を言葉にする（目安の境界: 40 で渦ができ始め、1000 を超えると乱れる） */
export function reynoldsWords(re: number): string {
  if (!Number.isFinite(re) || re < 0) return '流れのようすは不明です';
  if (re < 40) return 'なめらかな流れ';
  if (re < 1000) return '渦ができる流れ';
  return '乱れた流れ';
}

export function flowVerdict(re: number | undefined, drag: number | undefined, lift: number | undefined): Verdict {
  const lines: string[] = [];
  if (drag !== undefined) lines.push(`抗力（流れに押される力）: ${formatQuantity(drag, 'N')}`);
  if (lift !== undefined) lines.push(`揚力（横に持ち上げる力）: ${formatQuantity(lift, 'N')}`);
  const head = re === undefined ? '流れを計算しました' : `${reynoldsWords(re)}（レイノルズ数 ${formatNumber(re, 2)}）`;
  return verdict('info', head, lines);
}

// ---------- まとめ ----------

export interface VerdictInput {
  kind: AnalysisKind;
  project: Project;
  result: ResultSet | null;
  status: SolverStatus | null;
  raster: Raster | null;
  prefs: Prefs;
  /** 電磁波の「おすすめの厚み」に使う。なければ推薦しない */
  slab?: SlabFn;
}

/** 収束した、または進捗が 100% に届いたか */
export function isFinished(status: SolverStatus | null): boolean {
  return !!status && (status.done || status.progress >= 1);
}

export function computeVerdict(inp: VerdictInput): Verdict | null {
  const { kind, project, result, status, prefs } = inp;
  if (kind === 'scalar') return null;
  const waiting = (): Verdict => {
    const pct = status ? Math.round(Math.min(1, Math.max(0, status.progress)) * 100) : 0;
    return verdict('pending', '計算中…', [pct > 0 ? `進み具合 約 ${pct}%` : 'しばらくお待ちください。']);
  };
  if (!result || !status) return waiting();

  // 流れは終わりのない計算なので、途中経過でも数字を見せる（時間が進んでいれば）
  if (kind === 'flow') {
    if (status.iteration < 1) return waiting();
    const v = flowVerdict(scalarOf(result, 'Re'), scalarOf(result, 'drag'), scalarOf(result, 'lift'));
    if (!isFinished(status)) v.lines.push('計算は続いています。値は時間とともに少し変わります。');
    return v;
  }
  if (!isFinished(status)) return waiting();

  if (kind === 'stress') {
    const safety = scalarOf(result, 'minSafety');
    const disp = scalarOf(result, 'maxDisplacement') ?? 0;
    const vm = scalarOf(result, 'maxVonMises') ?? 0;
    const v = stressVerdict(safety ?? NaN, disp, prefs.safetyTarget, prefs.stressGoal, vm > 0);
    if (v.level === 'warn' || v.level === 'ng') v.actions.push(...stressActions(project));
    return v;
  }
  if (kind === 'heat') {
    const maxT = scalarOf(result, 'maxTemp');
    if (maxT === undefined) return null;
    const temp = result.fields.find((f) => f.key === 'temperature');
    const v = heatVerdict(maxT, project.heat.ambientC, materialTempLimits(temp, inp.raster));
    if (v.level === 'warn' || v.level === 'ng') v.actions.push(...heatActions(project));
    return v;
  }
  if (kind === 'em') {
    const t = scalarOf(result, 'transmission');
    if (t === undefined) {
      // 点波源では透過率を出さない（波が四方に広がるため）
      return verdict('info', '点波源（アンテナ）の電波の広がりです', ['色の濃いところが電波の強いところです。壁や物体のかげ、出入口からの漏れを探してみましょう。']);
    }
    const slab = findSlab(project);
    let rec: SlabRecommendation | null = null;
    if (slab && inp.slab && project.em.mediumId === 'air') {
      rec = recommendSlab(slab.material.epsR ?? 1, slab.material.tanD ?? 0, project.em.frequencyGHz * 1e9, inp.slab);
    }
    const hasConductor = project.shapes.some((s) => (s.role === 'solid' || s.role === 'heatSource') && tryMaterial(s.materialId)?.conductor === true);
    return emVerdict(t, scalarOf(result, 'reflection'), prefs.emGoal, hasConductor, rec, slab ? slab.thicknessM * 1000 : null);
  }
  return null;
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

export function heatActions(project: Project): VerdictAction[] {
  const out: VerdictAction[] = [];
  const next = nextCooling(project.heat.surfaceH);
  if (next) out.push({ kind: 'cooling', h: next.h, label: `冷やし方を「${next.label}」にする` });
  const cur = mainMaterialId(project);
  if (cur !== 'al6061') out.push({ kind: 'material', materialId: 'al6061', label: '材料をアルミにする（熱を逃がす）' });
  return out;
}
