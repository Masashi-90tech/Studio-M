// テスト用の試験体（コードで作る形）。本体のコードからは使わない。
import type { Mesh3D } from './types';

/** 緯度経度で分けた球（外向き、閉じている） */
export function uvSphere(r: number, rings: number, segs: number, c: [number, number, number] = [0, 0, 0]): Mesh3D {
  const pos: number[] = [c[0], c[1], c[2] + r, c[0], c[1], c[2] - r];
  const v = (i: number, j: number): number => 2 + (i - 1) * segs + (j % segs);
  for (let i = 1; i < rings; i++) {
    const th = (Math.PI * i) / rings;
    for (let j = 0; j < segs; j++) {
      const ph = (2 * Math.PI * j) / segs;
      pos.push(c[0] + r * Math.sin(th) * Math.cos(ph), c[1] + r * Math.sin(th) * Math.sin(ph), c[2] + r * Math.cos(th));
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < segs; j++) idx.push(0, v(1, j), v(1, j + 1));
  for (let i = 1; i < rings - 1; i++)
    for (let j = 0; j < segs; j++) idx.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i, j + 1));
  for (let j = 0; j < segs; j++) idx.push(1, v(rings - 1, j + 1), v(rings - 1, j));
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}
