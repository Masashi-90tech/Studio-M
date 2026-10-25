// スライダーの位置 ↔ 値の変換（線形 / 対数）。DOM に触れない。
import type { MathVar } from './types';

/** スライダーの段数（0〜SLIDER_STEPS）。対数で ×1/4〜×4 の範囲なら、×2 と ×1/2 がちょうど段に乗る */
export const SLIDER_STEPS = 200;

function bounds(v: MathVar): { lo: number; hi: number } {
  const lo = v.min ?? v.value / 4;
  const hi = v.max ?? v.value * 4;
  return lo < hi ? { lo, hi } : { lo: v.value - 1, hi: v.value + 1 };
}

/** 値 → スライダーの位置（0〜SLIDER_STEPS の整数） */
export function sliderPos(v: MathVar, value: number): number {
  const { lo, hi } = bounds(v);
  let t: number;
  if (v.log && lo > 0 && value > 0) t = Math.log(value / lo) / Math.log(hi / lo);
  else t = (value - lo) / (hi - lo);
  return Math.min(SLIDER_STEPS, Math.max(0, Math.round(t * SLIDER_STEPS)));
}

/**
 * スライダーの位置 → 値。step があれば刻みに丸める。
 * 元の値の位置（base の位置）に戻したときは、丸め誤差を出さないよう元の値そのものを返す。
 */
export function sliderValue(v: MathVar, pos: number): number {
  const { lo, hi } = bounds(v);
  const p = Math.min(SLIDER_STEPS, Math.max(0, pos));
  if (p === sliderPos(v, v.value)) return v.value;
  const t = p / SLIDER_STEPS;
  let value = v.log && lo > 0 ? lo * (hi / lo) ** t : lo + (hi - lo) * t;
  if (v.step && v.step > 0) value = lo + Math.round((value - lo) / v.step) * v.step;
  // 有効数字 6 桁に丸めて、0.20000000000000004 のような見た目を避ける
  return Number(value.toPrecision(6));
}
