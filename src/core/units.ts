// 単位の換算。DOM に触れない。

/** 重力加速度 [m/s²] */
export const GRAVITY = 9.81;

/** 重さ [kg] → 力 [N] */
export const kgToNewton = (kg: number): number => kg * GRAVITY;

/** 力 [N] → 重さ [kg] */
export const newtonToKg = (n: number): number => n / GRAVITY;
