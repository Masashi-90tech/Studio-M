// デスクトップ版（desktop/）の層の約束の確認:
//  - import してよいのは src/core と engine/server・engine/types だけ（画面・ワークベンチ・ソルバー・アダプターは import しない）
//  - electron を import してよいのは src/main.ts と src/preload.ts だけ
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = __dirname;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== 'node_modules' && e.name !== 'dist')
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sources = walk(ROOT).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts') && !f.endsWith('vite.config.ts'));
const specsOf = (f: string): string[] =>
  [...strip(readFileSync(f, 'utf8')).matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]);

describe('desktop の層', () => {
  it('src/core・engine/server・engine/types 以外の src/・engine/ を import していない', () => {
    const hits: string[] = [];
    for (const f of sources) {
      for (const spec of specsOf(f)) {
        const coreOk = /(^|\/)src\/core(\/|$)/.test(spec);
        const engineOk = /(^|\/)engine\/(server\/|types$)/.test(spec);
        if (/(^|\/)(src|engine)\//.test(spec) && !coreOk && !engineOk) hits.push(`${relative(ROOT, f)}: ${spec}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('electron を import するのは main.ts と preload.ts だけ', () => {
    const hits = sources.filter((f) => specsOf(f).some((s) => s === 'electron')).map((f) => relative(ROOT, f));
    expect(hits.sort()).toEqual([join('src', 'main.ts'), join('src', 'preload.ts')]);
  });
});
