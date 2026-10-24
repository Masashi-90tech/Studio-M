// 生データ出力: 現在の場を CSV（表計算向け）と legacy VTK（ParaView 向け）にする。
// 文字列を作る部分は純粋関数。保存は dom.ts の downloadBlob を通す。
import type { Field, ResultSet } from '../core/types';
import { downloadBlob } from './dom';

const MM = 1000;

/** 7 桁の有効数字で、余分な桁を落とした文字列 */
export function num(v: number): string {
  return Number.isFinite(v) ? String(Number(v.toPrecision(7))) : '';
}

/** CSV の 1 欄（カンマ・引用符・改行を含むときだけ引用符で囲む） */
function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 現在の場の CSV: i, j, x[mm], y[mm], value。x, y はセルの中心。無効なセルの値は空欄 */
export function fieldToCsv(r: Pick<ResultSet, 'nx' | 'ny' | 'h'>, f: Field): string {
  const { nx, ny, h } = r;
  const lines: string[] = [`i,j,x[mm],y[mm],${csvCell(f.unit ? `${f.label}[${f.unit}]` : f.label)}`];
  for (let j = 0; j < ny; j++) {
    const y = num((j + 0.5) * h * MM);
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const ok = !f.mask || f.mask[c] !== 0;
      lines.push(`${i},${j},${num((i + 0.5) * h * MM)},${y},${ok ? num(f.data[c]) : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** VTK の配列名に使える文字だけにする（空白は不可） */
export function vtkName(key: string): string {
  const s = key.replace(/[^A-Za-z0-9_]/g, '_');
  return s || 'field';
}

/**
 * legacy VTK（ASCII, STRUCTURED_POINTS）。座標は mm、点はセル中心。
 * 結果のすべての場を SCALARS として入れ、無効なセルは 0 にして、別に valid（1/0）を付ける。
 */
export function resultToVtk(r: Pick<ResultSet, 'nx' | 'ny' | 'h' | 'fields'>, title: string): string {
  const { nx, ny, h } = r;
  const n = nx * ny;
  const out: string[] = [
    '# vtk DataFile Version 3.0',
    title.replace(/[\r\n]+/g, ' ').slice(0, 250) || 'Studio M',
    'ASCII',
    'DATASET STRUCTURED_POINTS',
    `DIMENSIONS ${nx} ${ny} 1`,
    `ORIGIN ${num(0.5 * h * MM)} ${num(0.5 * h * MM)} 0`,
    `SPACING ${num(h * MM)} ${num(h * MM)} 1`,
    `POINT_DATA ${n}`,
  ];
  const used = new Set<string>();
  const array = (name: string, values: (c: number) => number): void => {
    let nm = vtkName(name);
    while (used.has(nm)) nm += '_';
    used.add(nm);
    out.push(`SCALARS ${nm} float 1`, 'LOOKUP_TABLE default');
    // 1 行 9 個ずつ並べる
    for (let c = 0; c < n; c += 9) {
      const row: string[] = [];
      for (let k = c; k < Math.min(n, c + 9); k++) row.push(num(values(k)) || '0');
      out.push(row.join(' '));
    }
  };
  let valid: Uint8Array | null = null;
  for (const f of r.fields) {
    if (f.data.length !== n) continue;
    array(f.key, (c) => ((!f.mask || f.mask[c] !== 0) && Number.isFinite(f.data[c]) ? f.data[c] : 0));
    if (!valid && f.mask) valid = f.mask;
  }
  array('valid', (c) => (valid ? (valid[c] !== 0 ? 1 : 0) : 1));
  return `${out.join('\n')}\n`;
}

export function saveCsv(r: ResultSet, f: Field, baseName: string): void {
  downloadBlob(new Blob([fieldToCsv(r, f)], { type: 'text/csv;charset=utf-8' }), `${baseName}_${vtkName(f.key)}.csv`);
}

export function saveVtk(r: ResultSet, baseName: string): void {
  downloadBlob(new Blob([resultToVtk(r, `Studio M ${baseName}`)], { type: 'text/plain;charset=utf-8' }), `${baseName}.vtk`);
}
