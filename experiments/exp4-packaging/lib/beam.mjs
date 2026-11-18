// CalculiX の小さな計算: 片持ち梁（先端荷重）。たわみを梁の理論値 PL^3/(3EI) と比べる。
//   node beam.mjs write <フォルダー>   … beam.inp を書く
//   node beam.mjs parse <フォルダー>   … beam.dat を読んで JSON を出す
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const L = 100, B = 10, H = 10, E = 210000, NU = 0.3, P = 100, N = 8;
const I = (B * H ** 3) / 12;
const theory = (P * L ** 3) / (3 * E * I);

const [cmd, dir] = process.argv.slice(2);
if (cmd === 'write') {
  const nodes = [];
  for (let i = 0; i <= N; i++) nodes.push(`${i + 1}, ${(L * i / N).toFixed(6)}, 0., 0.`);
  const elems = [];
  for (let i = 0; i < N; i++) elems.push(`${i + 1}, ${i + 1}, ${i + 2}`);
  const inp = `*NODE
${nodes.join('\n')}
*ELEMENT, TYPE=B31, ELSET=EALL
${elems.join('\n')}
*NSET, NSET=NFIX
1
*NSET, NSET=NTIP
${N + 1}
*MATERIAL, NAME=STEEL
*ELASTIC
${E}., ${NU}
*BEAM SECTION, ELSET=EALL, MATERIAL=STEEL, SECTION=RECT
${B}., ${H}.
0., 0., 1.
*STEP
*STATIC
*BOUNDARY
NFIX, 1, 6, 0.
*CLOAD
NTIP, 2, ${P}.
*NODE PRINT, NSET=NTIP
U
*END STEP
`;
  writeFileSync(join(dir, 'beam.inp'), inp);
} else if (cmd === 'parse') {
  const dat = readFileSync(join(dir, 'beam.dat'), 'utf8');
  const lines = dat.split('\n');
  const i = lines.findIndex((l) => l.includes('displacements (vx,vy,vz)'));
  if (i < 0) { console.error('beam.dat に変位が出ていません'); process.exit(1); }
  const row = lines.slice(i + 1).find((l) => l.trim() !== '').trim().split(/\s+/);
  const uy = Math.abs(Number(row[2]));
  console.log(JSON.stringify({ deflection_mm: uy, theory_mm: theory, rel_error: Math.abs(uy - theory) / theory }));
} else {
  console.error('使い方: beam.mjs write|parse <フォルダー>');
  process.exit(2);
}
