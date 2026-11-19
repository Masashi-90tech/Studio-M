// フォルダー直下の項目を大きい順に並べて JSON で出す（シェルから使う。du -sk と同じ KB 単位）。
//   node sizes.mjs <フォルダー> [上位の数]
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const [dir, n = '10'] = process.argv.slice(2);
const rows = readdirSync(dir).map((name) => {
  const out = execFileSync('du', ['-sk', join(dir, name)], { encoding: 'utf8' });
  return { name, kb: Number(out.split('\t')[0]) };
});
rows.sort((a, b) => b.kb - a.kb);
console.log(JSON.stringify(rows.slice(0, Number(n))));
