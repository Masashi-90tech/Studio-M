// JSON ファイルへ値を書き足す小さな道具（シェルから使う）。
//   node rec.mjs <ファイル> <a.b.c> <JSON の値>
//   node rec.mjs <ファイル> <a.b.c> --str <文字列>
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [file, key, a, b] = process.argv.slice(2);
if (!file || !key || a === undefined) {
  console.error('使い方: rec.mjs <ファイル> <a.b.c> <JSON の値> | --str <文字列>');
  process.exit(2);
}
let value;
if (a === '--str') value = b ?? '';
else {
  try { value = JSON.parse(a); } catch { value = a; }
}
let data = {};
if (existsSync(file)) {
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { data = {}; }
}
let cur = data;
const parts = key.split('.');
for (const p of parts.slice(0, -1)) {
  if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
  cur = cur[p];
}
cur[parts[parts.length - 1]] = value;
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
