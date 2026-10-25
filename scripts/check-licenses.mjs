// OSS 台帳（docs/oss-ledger.json）と、実際に入っている npm パッケージを突き合わせる。
//   1. package.json の直接の依存が、すべて台帳に載っているか
//   2. 配布物に入りうる依存（devDependencies 以外）のライセンスが、ポリシーで許可されているか
// 問題があれば一覧を出して終了コード 1 を返す。台帳で review 済みのものは注意として表示するだけ。
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ledger = JSON.parse(readFileSync('docs/oss-ledger.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const byName = new Map(ledger.entries.map((e) => [e.name, e]));
const { bundle_allowed, bundle_conditional } = ledger.policy;

const problems = [];
const notes = [];

// 1. 直接の依存が台帳にあるか
for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) {
  if (!byName.has(name)) problems.push(`台帳に未登録: ${name}（docs/oss-ledger.json に追加してください）`);
}

// 2. 配布物に入りうる依存のライセンス
const licenseOf = (p) =>
  typeof p.license === 'string' ? p.license : p.license?.type ?? p.licenses?.map((x) => x.type).join(' OR ') ?? 'UNKNOWN';

// "(MIT OR GPL-3.0)" のような式を、許可された組み合わせかどうかで判定する（OR はどれか1つ、AND は全部）
const allowed = (expr) =>
  expr
    .replace(/[()]/g, '')
    .split(/\s+OR\s+/)
    .some((alt) => alt.split(/\s+AND\s+/).every((id) => bundle_allowed.includes(id.trim())));

const dirs = execSync('npm ls --omit=dev --all --parseable', { encoding: 'utf8' }).trim().split('\n').slice(1);
const seen = new Set();
for (const dir of dirs) {
  const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const key = `${p.name}@${p.version}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const lic = licenseOf(p);
  if (allowed(lic)) continue;
  const entry = byName.get(p.name);
  if (entry?.shipped === false) {
    notes.push(`${key}: ${lic} → 配布物には含まれない（確認済み）`);
  } else if (entry?.review || entry?.chosen) {
    notes.push(`${key}: ${lic} → ${entry.chosen ? `${entry.chosen} を選択` : `要確認: ${entry.review}`}`);
  } else if (bundle_conditional.some((c) => lic.includes(c))) {
    problems.push(`条件付きライセンス: ${key}（${lic}）。組み込み方を確認して台帳に記録してください`);
  } else {
    problems.push(`許可されていないライセンス: ${key}（${lic}）`);
  }
}

console.log(`配布物に入りうる依存: ${seen.size} パッケージを確認`);
for (const n of notes) console.log(`  注意  ${n}`);
for (const p of problems) console.log(`  問題  ${p}`);
if (problems.length > 0) process.exit(1);
console.log('OK: 台帳とライセンスのポリシーに沿っています');
