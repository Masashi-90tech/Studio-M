// 3D の流れのかんたんな判定（DOM に依存しない）。2D の流れの判定（workbench/verdicts/flow.ts）にならい、
// レイノルズ数で流れのようすを言葉にして、抗力・揚力を知らせる。OK / NG は決めず、目安（info）として出す。
import type { ResultSet3D } from '../core/types';
import { formatNumber, formatQuantity } from '../ui/format';
import type { Verdict3D } from './verdict';

/** レイノルズ数を言葉にする（目安の境界: 40 で渦ができ始め、1000 を超えると乱れる。2D の判定と同じ） */
export function reynoldsWords3D(re: number): string {
  if (!Number.isFinite(re) || re < 0) return '流れのようすは不明です';
  if (re < 40) return 'なめらかな流れ';
  if (re < 1000) return '渦ができる流れ';
  return '乱れた流れ';
}

/** 代表値を key で探す（有限なものだけ） */
export function flowScalar(result: ResultSet3D, key: string): number | undefined {
  const s = result.scalars.find((x) => x.key === key);
  return s && Number.isFinite(s.value) ? s.value : undefined;
}

/** 揚力の代表値（key は lift で始まり、軸の名前が付く。複数あれば先頭）。なければ undefined */
export function liftScalar(result: ResultSet3D): { label: string; value: number } | undefined {
  const s = result.scalars.find((x) => /^lift/i.test(x.key) && Number.isFinite(x.value));
  return s ? { label: s.label, value: s.value } : undefined;
}

export interface FlowVerdict3DInput {
  result: ResultSet3D;
  /** 風が部品を何回通り抜けたか（SolverStatus.progress）。わかれば、まだ落ち着いていないことを知らせる */
  flowThroughs?: number;
  /** 計算が続いているか */
  running?: boolean;
}

/** 風が何回通り抜けたら、値が落ち着き始めるとみなすか（目安） */
export const SETTLED_FLOW_THROUGHS = 3;

export function flowVerdict3D(opts: FlowVerdict3DInput): Verdict3D {
  const { result } = opts;
  const re = flowScalar(result, 'Re');
  const drag = flowScalar(result, 'drag');
  const cd = flowScalar(result, 'Cd');
  const lift = liftScalar(result);
  const lines: string[] = [];
  if (drag !== undefined) lines.push(`抗力（流れに押される力）: ${formatQuantity(drag, 'N')}${cd !== undefined ? `（抗力係数 Cd = ${formatNumber(cd, 3)}）` : ''}`);
  if (lift !== undefined) lines.push(`${lift.label}（横に持ち上げる力）: ${formatQuantity(lift.value, 'N')}`);
  if (re !== undefined && re >= 1000) lines.push('流れが乱れているので、力は時間とともに大きくゆらぎます。しばらく走らせて、平均で見てください。');
  else if (re !== undefined && re >= 40) lines.push('渦が出ると、力は時間とともに周期的にゆらぎます。');
  const t = opts.flowThroughs;
  if (t !== undefined && t < SETTLED_FLOW_THROUGHS) lines.push(`風が部品をまだ ${formatNumber(Math.max(0, t), 2)} 回しか通り抜けていません。力の値は落ち着くまでしばらく変わります。`);
  else if (opts.running) lines.push('計算は続いています。値は時間とともに少し変わります。');
  const head = re === undefined ? '流れを計算しました' : `${reynoldsWords3D(re)}（レイノルズ数 ${formatNumber(re, 2)}）`;
  return { level: 'info', title: head, lines };
}

/** 流れの計算の進み具合の 1 行（経過時間・ステップ/秒・風が通り抜けた回数）。run は Sim3DModel の running / paused の状態 */
export function flowRunText(run: { kind: 'running' | 'paused'; iteration: number; progress: number; physTime?: number; stepsPerSec?: number }): string {
  const parts: string[] = [];
  if (run.kind === 'paused') parts.push('一時停止中');
  if (run.physTime !== undefined) parts.push(`経過時間 ${formatNumber(run.physTime, 3)} s`);
  if (run.kind === 'running' && run.stepsPerSec !== undefined) parts.push(`${formatNumber(run.stepsPerSec, 3)} ステップ/秒`);
  parts.push(`風が ${formatNumber(Math.max(0, run.progress), 2)} 回通り抜けました（${run.iteration.toLocaleString('ja-JP')} ステップ）`);
  return parts.join('・');
}
