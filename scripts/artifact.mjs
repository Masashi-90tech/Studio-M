// dist/index.html を claude.ai Artifact 用の形に変換する（公開時に骨組みが付くので外す）
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1];
const keep = head
  .replace(/<meta charset[^>]*>/i, '')
  .replace(/<meta name="viewport"[^>]*>/i, '')
  .replace(/<link\s+rel="icon"[\s\S]*?\/>/i, '');
// 依存ライブラリの文字列リテラルにある U+FFFD は公開時に拒否されるのでエスケープ表記にする
const out = `${keep.trim()}\n${body.trim()}\n`.replaceAll("\uFFFD", "\\uFFFD");
writeFileSync("dist/artifact.html", out);
console.log('dist/artifact.html', Math.round((keep.length + body.length) / 1024), 'KB');
