// 流れの判定。DOM に触れない純粋関数だけを置く。
import type { History, Project } from '../../core/types';
import { formatNumber, formatQuantity } from '../../ui/format';
import { isFinished, makeVerdict, scalarOf, waitingVerdict } from '../verdict-kit';
import type { Verdict, VerdictAction, VerdictInput } from '../types';
import { marginLevel, partRows, PART_OK_MARGIN_K, type PartRow } from './heat';

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
  return makeVerdict('info', head, lines);
}

// ---------- 温度（風で冷やす） ----------

/** 流入温度の既定 [°C]（ソルバーの既定と同じ） */
const INLET_DEFAULT_C = 25;

/** 流入する風の温度 [°C] */
export function inletTempOf(project: Project): number {
  const t = project.flow.thermal?.inletTempC;
  return t !== undefined && Number.isFinite(t) ? t : INLET_DEFAULT_C;
}

/** 平均をとる（空なら NaN） */
function mean(values: number[], from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += values[i];
  return to > from ? s / (to - from) : NaN;
}

/**
 * 最高温度の推移が落ち着いたか。サンプルが十分あり、直近（最後の 10%）の平均と、少し前（60〜70%）の平均の差が、
 * 風の温度からの上昇の 1.5% + 0.05 K 以内なら落ち着いたとみなす（渦で脈打つので平均で比べる）
 */
export function tempSettled(history: History | undefined, inletC: number): boolean {
  const v = history?.values;
  if (!v || v.length < 30) return false;
  const n = v.length;
  const now = mean(v, Math.floor(n * 0.9), n);
  const before = mean(v, Math.floor(n * 0.6), Math.floor(n * 0.7));
  if (!Number.isFinite(now) || !Number.isFinite(before)) return false;
  return Math.abs(now - before) <= 0.015 * Math.max(0, now - inletC) + 0.05;
}

/** いまより強い風の速さ [m/s]（1.5 倍。有効数字 2 桁に丸める） */
export function nextWindSpeed(current: number): number {
  const base = current > 0 ? current : 1;
  return Number((base * 1.5).toPrecision(2));
}

export interface FlowThermalVerdictInput {
  /** 物体の最高温度 [°C] */
  maxC: number;
  /** 流入する風の温度 [°C] */
  inletC: number;
  /** 上限温度のある部品（余裕の少ない順） */
  limited: PartRow[];
  /** 発熱が最も大きい部品（見直しの候補）。なければ undefined */
  hottestHeat?: PartRow;
  /** 温度が落ち着いたか */
  settled: boolean;
  /** 流入速度 [m/s] */
  speed: number;
  /** 発熱の合計と、風が運び出している熱 [W] */
  heatInW?: number;
  heatOutW?: number;
}

const deg = (v: number): string => `${formatNumber(v, 3)}°C`;

/** 温度（風で冷やす）の判定。上限温度のある部品があれば、いちばん余裕の少ない部品で OK / 注意 / NG を決める */
export function flowThermalVerdict(inp: FlowThermalVerdictInput): Verdict {
  const { maxC, inletC, limited, settled, speed } = inp;
  const rise = (t: number): string => `風の温度 ${deg(inletC)} より ${formatNumber(Math.max(0, t - inletC), 2)} K 高くなります。`;
  const balance =
    inp.heatInW !== undefined && inp.heatInW > 0 && inp.heatOutW !== undefined
      ? `発熱 ${formatQuantity(inp.heatInW, 'W')} のうち、風が運び出しているのは ${formatQuantity(Math.max(0, inp.heatOutW), 'W')} です。`
      : undefined;
  const lines: string[] = [];

  const worst = limited[0];
  if (!worst || worst.marginC === undefined) {
    lines.push(rise(maxC));
    if (balance) lines.push(balance);
    if (!settled) lines.push('温度はまだ変わっていきます。落ち着くまで計算を続けてください。');
    return makeVerdict('info', `いちばん熱いところは ${deg(maxC)} です`, lines);
  }

  const margin = worst.marginC;
  const level = marginLevel(margin);
  const lim = deg(worst.limitC ?? 0);
  const others = limited.slice(1).filter((r) => (r.marginC ?? Infinity) < PART_OK_MARGIN_K);
  if (level === 'ng') lines.push(`上限より ${formatNumber(-margin, 2)} K 高くなっています。風を強くするか、発熱を減らしてください。`);
  else if (level === 'warn') lines.push(`上限まであと ${formatNumber(margin, 2)} K です。風が弱い日や長時間の動作で超えるかもしれません。`);
  else lines.push(`いちばん厳しい部品でも、上限まで ${formatNumber(margin, 2)} K の余裕があります。`);
  if (others.length > 0) {
    const names = others.slice(0, 3).map((r) => `${r.label}（${deg(r.maxC)} / 上限 ${deg(r.limitC ?? 0)}）`);
    lines.push(`ほかに余裕の少ない部品: ${names.join('、')}${others.length > 3 ? ` ほか ${others.length - 3} 個` : ''}`);
  }
  lines.push(`${worst.label}: ${rise(worst.maxC)}`);
  if (balance) lines.push(balance);

  if (level === 'ng') {
    if (!settled) lines.push('温度はまだ上がる途中です。落ち着くとさらに高くなるかもしれません。');
    return makeVerdict('ng', `${worst.label} が ${deg(worst.maxC)} で、上限 ${lim} を超えます`, lines, flowThermalActions({ speed, hottest: inp.hottestHeat }));
  }
  if (level === 'warn') {
    if (!settled) lines.push('温度はまだ上がる途中です。落ち着くとさらに高くなるかもしれません。');
    return makeVerdict('warn', `${worst.label} は ${deg(worst.maxC)} で、上限 ${lim} ぎりぎりです`, lines, flowThermalActions({ speed, hottest: inp.hottestHeat }));
  }
  // OK は、温度が落ち着いてから言う（途中の低い温度で安心させない）
  if (!settled) {
    return makeVerdict('pending', '温度が落ち着くまで計算中…', [`いまの最高は ${worst.label} の ${deg(worst.maxC)}（上限 ${lim}）です。温度はまだ上がっていきます。`, ...lines.slice(1)]);
  }
  return makeVerdict('ok', `すべての部品が上限に収まっています（最大 ${worst.label} ${deg(worst.maxC)} / 上限 ${lim}）`, lines);
}

/** 次の一手: 風を強くする、発熱する部品を見直す */
export function flowThermalActions(opts: { speed: number; hottest?: PartRow }): VerdictAction[] {
  const speed = nextWindSpeed(opts.speed);
  const out: VerdictAction[] = [{ kind: 'wind', speed, label: `風を強くする（${speed} m/s に）` }];
  if (opts.hottest && opts.hottest.heatW > 0) out.push({ kind: 'review', shapeId: opts.hottest.shapeId, label: `発熱を見直す（${opts.hottest.label} を選ぶ）` });
  return out;
}

/** ワークベンチの判定: 流れは終わりのない計算なので、途中経過でも数字を見せる（時間が進んでいれば） */
export function flowWorkbenchVerdict(inp: VerdictInput): Verdict | null {
  const { project, result, status } = inp;
  if (!result || !status || status.iteration < 1) return waitingVerdict(status);
  const flowLines = flowVerdict(scalarOf(result, 'Re'), scalarOf(result, 'drag'), scalarOf(result, 'lift'));

  // 温度も計算しているとき: 部品の上限温度と比べる
  const maxT = scalarOf(result, 'maxTemp');
  if (project.flow.thermal?.enabled === true && maxT !== undefined) {
    const inletC = inletTempOf(project);
    const rows = partRows(result);
    const limited = rows.filter((r) => r.marginC !== undefined);
    const hottestHeat = [...rows].sort((a, b) => b.heatW - a.heatW)[0];
    const v = flowThermalVerdict({
      maxC: maxT,
      inletC,
      limited,
      hottestHeat,
      settled: tempSettled(result.history.find((h) => h.key === 'maxTemp'), inletC),
      speed: project.flow.inletVelocity,
      heatInW: scalarOf(result, 'heatIn'),
      heatOutW: scalarOf(result, 'heatOut'),
    });
    v.lines.push(flowLines.headline);
    return v;
  }

  const v = flowLines;
  if (!isFinished(status)) v.lines.push('計算は続いています。値は時間とともに少し変わります。');
  return v;
}

/** 次の一手を反映する。流れでは風を強くする（発熱の見直しは部品を選ぶだけ） */
export function applyFlowAction(opts: { project: Project; action: VerdictAction; selectShape?: (shapeId: string | null) => void }): void {
  const { project, action } = opts;
  if (action.kind === 'wind') project.flow.inletVelocity = action.speed;
  else if (action.kind === 'review') opts.selectShape?.(action.shapeId);
}
