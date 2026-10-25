// src/pcb の層の約束を確かめる: core だけに依存し、DOM を使うのは画面のファイル（import-dialog・preview）だけ。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = __dirname;
const DOM_FILES = new Set(['import-dialog.ts', 'preview.ts']);
const sources = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'fixtures.ts');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const specs = (f: string): string[] => [...strip(readFileSync(join(DIR, f), 'utf8')).matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2] ?? m[3]);

describe('src/pcb の依存の向き', () => {
  it('同じフォルダと src/core だけを import する（画面のファイルは src/ui/dom と src/ui/format も可）', () => {
    const hits: string[] = [];
    for (const f of sources) {
      for (const s of specs(f)) {
        if (s.startsWith('./')) continue;
        if (/^\.\.\/core\//.test(s)) continue;
        if (DOM_FILES.has(f) && /^\.\.\/ui\/(dom|format)$/.test(s)) continue;
        hits.push(`${f}: ${s}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('DOM を触るのは import-dialog と preview だけ', () => {
    const hits = sources.filter((f) => !DOM_FILES.has(f) && /\b(document|window|HTMLElement|navigator)\b/.test(strip(readFileSync(join(DIR, f), 'utf8'))));
    expect(hits).toEqual([]);
  });

  it('パーサーと組み立ては、画面のファイルを import しない', () => {
    const hits: string[] = [];
    for (const f of sources.filter((x) => !DOM_FILES.has(x) && x !== 'index.ts')) {
      for (const s of specs(f)) if (/import-dialog|preview/.test(s)) hits.push(`${f}: ${s}`);
    }
    expect(hits).toEqual([]);
  });
});
