// エンジン（engine/）の層の約束の確認:
//  - src/core だけを import してよい（画面・ワークベンチ・ソルバー・出力・学び・基板は import しない）
//  - アダプターは自分でプロセスを起動しない（child_process を使わず、必ず ctx.run を通す）
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = __dirname;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sources = walk(ROOT).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts') && !/test-context|testing\.ts/.test(f));

describe('engine の層', () => {
  it('src/core 以外の src/ を import していない', () => {
    const hits: string[] = [];
    for (const f of sources) {
      for (const m of strip(readFileSync(f, 'utf8')).matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2];
        if (/(^|\/)src\//.test(spec) && !/(^|\/)src\/core(\/|$)/.test(spec)) hits.push(`${relative(ROOT, f)}: ${spec}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('アダプターは child_process を使わない（実行は ctx.run だけ）', () => {
    const hits = sources
      .filter((f) => relative(ROOT, f).startsWith('adapters'))
      .filter((f) => /child_process/.test(strip(readFileSync(f, 'utf8'))))
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });

  it('サーバーで child_process を使うのは、実行を受け持つ exec.ts だけ', () => {
    const hits = sources
      .filter((f) => relative(ROOT, f).startsWith('server'))
      .filter((f) => /child_process/.test(strip(readFileSync(f, 'utf8'))))
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([join('server', 'exec.ts')]);
  });
});
