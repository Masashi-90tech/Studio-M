// 流れの 3D 表示に重ねる線の形（風洞の枠・風の向きの矢印）。DOM に依存しない純粋な関数だけを置く。
// 返すのは線分の端点の並び（x y z を 2 点で 1 本。ビューアの setLines にそのまま渡せる）。
import { flowAxis, type Box3D } from '../core/grid3d';
import type { FlowDirection3D } from '../core/types';

/** 直方体の 12 本の辺 */
export function boxEdges(box: Box3D): Float32Array {
  const { min, max } = box;
  const corner = (i: number): [number, number, number] => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
  const out: number[] = [];
  for (let i = 0; i < 8; i++)
    for (let bit = 1; bit <= 4; bit <<= 1) {
      if (i & bit) continue; // 各辺は、その軸の座標が小さい側の頂点から 1 回だけ数える
      out.push(...corner(i), ...corner(i | bit));
    }
  return Float32Array.from(out);
}

export interface WindArrowOptions {
  box: Box3D;
  direction: FlowDirection3D;
  /** 矢印の長さ（風洞の流れの向きの長さに対する割合。既定 0.22） */
  length?: number;
  /** 矢印の位置の広がり（風洞の断面の半分の大きさに対する割合。既定 0.55） */
  spread?: number;
}

/** 矢印の根もと（流入の面の少し内側。断面の中心と、四隅に寄せた 4 か所） */
export function windArrowStarts(opts: WindArrowOptions): [number, number, number][] {
  const { box, direction } = opts;
  const { axis, sign } = flowAxis(direction);
  const spread = opts.spread ?? 0.55;
  const len = box.max[axis] - box.min[axis];
  const cross = [0, 1, 2].filter((a) => a !== axis);
  const mid = (a: number): number => (box.min[a] + box.max[a]) / 2;
  const half = (a: number): number => ((box.max[a] - box.min[a]) / 2) * spread;
  const inlet = (sign > 0 ? box.min[axis] : box.max[axis]) + sign * 0.03 * len;
  const offsets: [number, number][] = [
    [0, 0],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  return offsets.map(([a, b]) => {
    const p: [number, number, number] = [0, 0, 0];
    p[axis] = inlet;
    p[cross[0]] = mid(cross[0]) + a * half(cross[0]);
    p[cross[1]] = mid(cross[1]) + b * half(cross[1]);
    return p;
  });
}

/** 風の向きの矢印（軸の向きの線 + 先端の矢じり 4 本）。流入の側に何本か並べる */
export function windArrows(opts: WindArrowOptions): Float32Array {
  const { box, direction } = opts;
  const { axis, sign } = flowAxis(direction);
  const len = box.max[axis] - box.min[axis];
  const l = (opts.length ?? 0.22) * len;
  const head = 0.28 * l;
  const wing = 0.12 * l;
  const cross = [0, 1, 2].filter((a) => a !== axis);
  const out: number[] = [];
  for (const p0 of windArrowStarts(opts)) {
    const tip: [number, number, number] = [p0[0], p0[1], p0[2]];
    tip[axis] += sign * l;
    out.push(...p0, ...tip);
    for (const c of cross) {
      for (const s of [1, -1]) {
        const back: [number, number, number] = [tip[0], tip[1], tip[2]];
        back[axis] -= sign * head;
        back[c] += s * wing;
        out.push(...tip, ...back);
      }
    }
  }
  return Float32Array.from(out);
}
