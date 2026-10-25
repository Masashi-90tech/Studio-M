// セルごとの結果を、ParaView で開ける legacy VTK（ASCII、等間隔の格子）にする。
// 格子は Studio M の格子そのもの（セル = 物体セル、物体でないセルは値 0 で mask = 0）。

import type { Field } from '../../../src/core/types';

export interface VtkInput {
  nx: number;
  ny: number;
  h: number;
  /** 奥行き（厚さ）[m]。セルの z 方向の幅になる */
  thickness: number;
  title: string;
  fields: Field[];
  /** 物体として解いたセル */
  mask: Uint8Array;
}

const fmt = (x: number): string => (Number.isFinite(x) ? Number(x.toPrecision(7)).toString() : '0');

export function writeVtk(input: VtkInput): string {
  const { nx, ny, h } = input;
  const nCells = nx * ny;
  const out: string[] = [
    '# vtk DataFile Version 3.0',
    input.title.replace(/[\r\n]+/g, ' ').slice(0, 250),
    'ASCII',
    'DATASET STRUCTURED_POINTS',
    `DIMENSIONS ${nx + 1} ${ny + 1} 2`,
    'ORIGIN 0 0 0',
    `SPACING ${fmt(h)} ${fmt(h)} ${fmt(input.thickness)}`,
    `CELL_DATA ${nCells}`,
  ];
  const scalar = (name: string, data: ArrayLike<number>, mask?: Uint8Array): void => {
    out.push(`SCALARS ${name} float 1`, 'LOOKUP_TABLE default');
    // 1 行 1 値だと長いので、10 個ずつ並べる
    for (let i = 0; i < nCells; i += 10) {
      const row: string[] = [];
      for (let k = i; k < Math.min(nCells, i + 10); k++) row.push(mask && !mask[k] ? '0' : fmt(data[k]));
      out.push(row.join(' '));
    }
  };
  scalar('solid', input.mask);
  for (const f of input.fields) scalar(f.key, f.data, f.mask ?? input.mask);
  return out.join('\n') + '\n';
}
