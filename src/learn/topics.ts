// 数学の分野の既定の段階と、作成用の小さな関数。
import type { MathLevel, MathTopic, MathTopicName } from './types';

/** 分野ごとの、いちばん入り口に近い段階 */
export const TOPIC_LEVEL: Record<MathTopicName, MathLevel> = {
  '比例・一次関数': '中学',
  '三平方・ベクトル': '中学',
  '三角関数': '高校',
  '指数・対数': '高校',
  '微分': '高校',
  '積分': '高校',
  '数列・収束': '高校',
  '連立方程式・行列': '大学',
  '偏微分方程式': '大学',
  '複素数・フーリエ': '大学',
  '数値解析': '大学',
};

export const TOPIC_NAMES = Object.keys(TOPIC_LEVEL) as MathTopicName[];

export const LEVEL_ORDER: MathLevel[] = ['中学', '高校', '大学'];

/** 分野を作る。level を省略すると既定の段階 */
export function topic(name: MathTopicName, level?: MathLevel): MathTopic {
  return { name, level: level ?? TOPIC_LEVEL[name] };
}

/** 段階の強さ（0 = 中学）。並べ替えに使う */
export function levelRank(level: MathLevel): number {
  return LEVEL_ORDER.indexOf(level);
}
