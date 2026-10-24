// NACA 4桁翼型の輪郭点を生成する。
import type { Pt } from './geometry';

/**
 * NACA 4桁翼型（例 "0012", "2412"）の多角形の頂点を返す。
 * - chord: 翼弦長 [m]
 * - aoaDeg: 迎角 [度]。正で前縁が上がる（後縁が下がる）。前縁(x, y)まわりに回転する
 * - (x, y): 前縁の位置 [m]（回転前も後も前縁はここ）
 * - n: 上面・下面それぞれの点数（余弦間隔で前縁側を細かくする）
 * 後縁は閉じた形（厚さ 0）で、点列は 後縁(上) → 前縁 → 後縁(下の手前) の順。点数は 2n - 2。
 */
export function nacaAirfoil(code: string, chord: number, aoaDeg: number, x: number, y: number, n = 40): Pt[] {
  if (!/^\d{4}$/.test(code)) throw new Error(`NACA 4桁の番号ではありません: ${code}`);
  const m = Number(code[0]) / 100; // 最大キャンバー
  const p = Number(code[1]) / 10; // 最大キャンバー位置
  const t = Number(code.slice(2)) / 100; // 最大厚さ

  const thickness = (xc: number): number =>
    5 * t * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
  const camber = (xc: number): { yc: number; dyc: number } => {
    if (m === 0 || p === 0) return { yc: 0, dyc: 0 };
    return xc < p
      ? { yc: (m / (p * p)) * (2 * p * xc - xc * xc), dyc: ((2 * m) / (p * p)) * (p - xc) }
      : { yc: (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * xc - xc * xc), dyc: ((2 * m) / ((1 - p) ** 2)) * (p - xc) };
  };

  const upper: Pt[] = [];
  const lower: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const beta = (Math.PI * i) / (n - 1);
    const xc = (1 - Math.cos(beta)) / 2; // 0 → 1（前縁 → 後縁）
    const yt = thickness(xc);
    const { yc, dyc } = camber(xc);
    const th = Math.atan(dyc);
    upper.push([xc - yt * Math.sin(th), yc + yt * Math.cos(th)]);
    lower.push([xc + yt * Math.sin(th), yc - yt * Math.cos(th)]);
  }
  // 後縁(上) → 前縁 → 下面（前縁と後縁の重複を除く）
  const loop: Pt[] = [...upper.slice().reverse(), ...lower.slice(1, n - 1)];

  const a = (aoaDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  return loop.map(([xc, yc]): Pt => {
    const px = xc * chord;
    const py = yc * chord;
    // 迎角 α のとき、流れに対して翼を時計回りに α 回す
    return [x + px * ca + py * sa, y - px * sa + py * ca];
  });
}
