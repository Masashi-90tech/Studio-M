// 流れの判定。DOM に触れない純粋関数だけを置く。
import { formatNumber, formatQuantity } from '../../ui/format';
import { isFinished, makeVerdict, scalarOf, waitingVerdict } from '../verdict-kit';
import type { Verdict, VerdictInput } from '../types';

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

/** ワークベンチの判定: 流れは終わりのない計算なので、途中経過でも数字を見せる（時間が進んでいれば） */
export function flowWorkbenchVerdict(inp: VerdictInput): Verdict | null {
  const { result, status } = inp;
  if (!result || !status || status.iteration < 1) return waitingVerdict(status);
  const v = flowVerdict(scalarOf(result, 'Re'), scalarOf(result, 'drag'), scalarOf(result, 'lift'));
  if (!isFinished(status)) v.lines.push('計算は続いています。値は時間とともに少し変わります。');
  return v;
}
