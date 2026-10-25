// 電磁波の判定。DOM に触れない純粋関数だけを置く。
import { slabTransmission } from '../../core/slab';
import type { Material, Project, Shape } from '../../core/types';
import { setSlabThicknessMm } from '../../ui/easy-logic';
import { formatNumber } from '../../ui/format';
import type { Prefs } from '../../ui/modes';
import { isFinished, makeVerdict, scalarOf, tryMaterial, waitingVerdict } from '../verdict-kit';
import type { SlabFn, Verdict, VerdictAction, VerdictInput, VerdictLevel } from '../types';

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
    return makeVerdict('info', `反射 ${R}、通過 ${T}`, lines.filter((l) => !l.startsWith('反射')), []);
  }
  return makeVerdict(level, text, lines, actions);
}

/** ワークベンチの判定 */
export function emWorkbenchVerdict(inp: VerdictInput): Verdict | null {
  const { project, result, status, prefs } = inp;
  if (!result || !status || !isFinished(status)) return waitingVerdict(status);
  const t = scalarOf(result, 'transmission');
  if (t === undefined) {
    // 点波源では透過率を出さない（波が四方に広がるため）
    return makeVerdict('info', '点波源（アンテナ）の電波の広がりです', ['色の濃いところが電波の強いところです。壁や物体のかげ、出入口からの漏れを探してみましょう。']);
  }
  const slab = findSlab(project);
  let rec: SlabRecommendation | null = null;
  if (slab && project.em.mediumId === 'air') {
    rec = recommendSlab(slab.material.epsR ?? 1, slab.material.tanD ?? 0, project.em.frequencyGHz * 1e9, inp.slab ?? slabTransmission);
  }
  const hasConductor = project.shapes.some((s) => (s.role === 'solid' || s.role === 'heatSource') && tryMaterial(s.materialId)?.conductor === true);
  return emVerdict(t, scalarOf(result, 'reflection'), prefs.emGoal, hasConductor, rec, slab ? slab.thicknessM * 1000 : null);
}

/** 次の一手を反映する */
export function applyEmAction(opts: { project: Project; action: VerdictAction }): void {
  const { project, action } = opts;
  if (action.kind !== 'slab') return;
  const s = findSlab(project);
  if (s) setSlabThicknessMm(s.shape, action.thicknessMm);
}
