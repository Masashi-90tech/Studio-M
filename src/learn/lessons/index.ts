// プリセットごとのレッスンと、学ぶ順（中学 → 高校 → 大学）。
import type { LearningStage, Lesson } from '../types';
import { boardLesson } from './board';
import { cantileverLesson } from './cantilever';
import { fanHeatsinkLesson } from './fan-heatsink';
import { heatsinkLesson } from './heatsink';
import { karmanLesson } from './karman';
import { lBracketLesson } from './l-bracket';
import { metalShadowLesson } from './metal-shadow';
import { nacaLesson } from './naca0012';
import { radarCoverLesson } from './radar-cover';
import { squareColumnLesson } from './square-column';
import { wifiRoomLesson } from './wifi-room';

/** プリセットごとに 1 つ。id は presetId と同じ */
export const LESSONS: Lesson[] = [
  heatsinkLesson,
  fanHeatsinkLesson,
  boardLesson,
  lBracketLesson,
  cantileverLesson,
  radarCoverLesson,
  wifiRoomLesson,
  metalShadowLesson,
  karmanLesson,
  nacaLesson,
  squareColumnLesson,
];

/** おすすめの学ぶ順。やさしい比例の話から、微積分・数値解析へ */
export const LEARNING_PATH: LearningStage[] = [
  {
    level: '中学',
    title: '比例と反比例で、熱と力を読む',
    description: '中学の数学だけで、ヒートシンクや風での冷却、基板、ブラケットの「なぜ」が分かります。',
    lessonIds: ['heatsink', 'fan-heatsink', 'board', 'l-bracket'],
  },
  {
    level: '高校',
    title: '累乗・三角関数・対数で、梁と電波を読む',
    description: '3 乗の世界、sin と cos、dB（対数）を、たわみ・レーダー・Wi-Fi・流れで使います。',
    lessonIds: ['cantilever', 'radar-cover', 'wifi-room', 'metal-shadow', 'karman'],
  },
  {
    level: '大学',
    title: '積分と数値解析で、流れを解く',
    description: '圧力の足し合わせ（積分）と、微分方程式を Excel の 1 行にする方法を学びます。',
    lessonIds: ['naca0012', 'square-column'],
  },
];

export function findLesson(id: string): Lesson | undefined {
  return LESSONS.find((l) => l.id === id);
}

/** プリセットに対応するレッスン */
export function lessonForPreset(presetId: string): Lesson | undefined {
  return LESSONS.find((l) => l.presetId === presetId);
}

/** 学ぶ順に平らにした id の並び */
export const LEARNING_ORDER: string[] = LEARNING_PATH.flatMap((s) => s.lessonIds);
