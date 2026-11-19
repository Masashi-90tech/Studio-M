// 同梱物に入っているものの一覧（名前・ライセンス・版・入手先）を THIRD-PARTY.json に出す。
// ライセンス文そのものの同梱は、本番のビルドで行う（この計測キットでは一覧だけ）。
//   node third-party.mjs <payload のフォルダー>
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const payload = process.argv[2];
const items = [];

// pip で入れたもの: *.dist-info/METADATA から読む
for (const worker of ['shape', 'mesh']) {
  const sp = join(payload, 'workers', worker, 'site-packages');
  if (!existsSync(sp)) continue;
  for (const d of readdirSync(sp).filter((x) => x.endsWith('.dist-info'))) {
    const meta = readFileSync(join(sp, d, 'METADATA'), 'utf8');
    const field = (k) => (meta.match(new RegExp(`^${k}: (.+)$`, 'm')) ?? [])[1] ?? '';
    const cls = (meta.match(/^Classifier: License :: (?:OSI Approved :: )?(.+)$/m) ?? [])[1];
    const lic = field('License-Expression') || cls || field('License').split('\n')[0] || '要確認';
    items.push({ name: field('Name'), version: field('Version'), license: lic.slice(0, 120), source: field('Home-page') || `https://pypi.org/project/${field('Name')}/`, where: `workers/${worker}` });
  }
}

// pip 以外のもの
items.push(
  { name: 'CPython', version: '3.12', license: 'PSF-2.0', source: 'https://www.python.org/', where: 'runtime/python' },
  { name: 'python-build-standalone', version: '(Mac のビルドのみ)', license: 'MPL-2.0', source: 'https://github.com/astral-sh/python-build-standalone', where: 'runtime/python' },
  { name: 'OpenCASCADE Technology (OCCT)', version: '8.0.1', license: 'LGPL-2.1 with exception', source: 'https://github.com/Open-Cascade-SAS/OCCT', where: 'workers/shape（cadquery-ocp の中）' },
  { name: 'Gmsh', version: '4.15.2', license: 'GPL-2.0-or-later', source: 'https://gmsh.info', where: 'workers/mesh（別フォルダー・別プロセス）' },
  { name: 'CalculiX', version: '2.21〜2.22', license: 'GPL-2.0', source: 'http://www.calculix.de', where: 'engines/calculix（別プロセス）' },
  { name: 'SPOOLES・ARPACK・OpenBLAS・libgfortran など', version: '(ccx が使う共有ライブラリ)', license: '各自（SPOOLES は独自の公開許諾、ARPACK・OpenBLAS は BSD-3-Clause、libgfortran は GPL-3.0 + GCC Runtime Library Exception）', source: 'engines/calculix/lib の中身を実測のあとに確認', where: 'engines/calculix/lib' },
);
writeFileSync(join(payload, 'THIRD-PARTY.json'), JSON.stringify({ note: '計測キットが出した一覧。本番ではライセンス文を同梱する', items }, null, 2) + '\n');
console.log(`THIRD-PARTY.json: ${items.length} 件`);
