// src/sim3d の層の約束を確かめる（CLAUDE.md の層の表）:
// core と mesh3d の一部（型・ビューア・カメラ・断面）だけに依存し、ソルバーは遅延 import だけで読む。
// DOM を触るのは画面のファイルだけ。mesh3d・solvers・workbench などの逆向きの import はない。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = __dirname;
/** DOM・WebGL・タイマーを触ってよい画面のファイル */
const DOM_FILES = new Set(['screen.ts', 'panel.ts', 'view.ts', 'runner.ts']);
const sources = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const text = (f: string): string => strip(readFileSync(join(DIR, f), 'utf8'));
const staticSpecs = (f: string): string[] => [...text(f).matchAll(/from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2]);
const dynamicSpecs = (f: string): string[] => [...text(f).matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);

describe('src/sim3d の依存の向き', () => {
  it('静的な import は、同じフォルダ・src/core・src/mesh3d の一部だけ。純粋なファイルは型と DOM に触れない部品だけ', () => {
    const hits: string[] = [];
    for (const f of sources) {
      for (const s of staticSpecs(f)) {
        if (s.startsWith('./')) continue;
        if (/^\.\.\/core\//.test(s)) continue;
        if (/^\.\.\/mesh3d\/types$/.test(s)) continue;
        if (/^\.\.\/ui\/(colormap|format)$/.test(s)) continue; // DOM に触れない部品
        if (DOM_FILES.has(f) && /^\.\.\/mesh3d\/(viewer|slice|camera)$/.test(s)) continue;
        if (DOM_FILES.has(f) && /^\.\.\/ui\/(dom|lazy)$/.test(s)) continue;
        hits.push(`${f}: ${s}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('ソルバーは静的に import しない。遅延 import（import()）は runner.ts の 1 か所だけ', () => {
    const staticHits = sources.flatMap((f) => staticSpecs(f).filter((s) => /solvers\//.test(s)).map((s) => `${f}: ${s}`));
    expect(staticHits).toEqual([]);
    const lazy = sources.filter((f) => dynamicSpecs(f).some((s) => /solvers\//.test(s)));
    expect(lazy).toEqual(['runner.ts']);
  });

  it('ワークベンチ・学び・基板・Excel 出力・エンジン・外部のライブラリには依存しない', () => {
    const hits: string[] = [];
    for (const f of sources) {
      for (const s of [...staticSpecs(f), ...dynamicSpecs(f)]) {
        if (/(^|\/)(workbench|learn|pcb|export|engine)(\/|$)/.test(s)) hits.push(`${f}: ${s}`);
        if (!s.startsWith('.')) hits.push(`${f}: ${s}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('DOM・WebGL を触るのは screen・panel・view・runner だけ', () => {
    const hits = sources.filter((f) => !DOM_FILES.has(f) && /\b(document|window|HTMLElement|HTMLCanvasElement|navigator|WebGLRenderingContext|requestAnimationFrame|setTimeout)\b/.test(text(f)));
    expect(hits).toEqual([]);
  });

  it('計算・状態・条件・判定は、画面のファイルを import しない', () => {
    const hits: string[] = [];
    for (const f of sources.filter((x) => !DOM_FILES.has(x) && x !== 'index.ts')) {
      for (const s of staticSpecs(f)) if (/\/(screen|panel|view|runner)$/.test(s)) hits.push(`${f}: ${s}`);
    }
    expect(hits).toEqual([]);
  });

  it('src/mesh3d は src/sim3d を知らない（取り込みダイアログには、コールバックで渡す）', () => {
    const mesh = join(DIR, '..', 'mesh3d');
    const hits = readdirSync(mesh)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /sim3d/.test(strip(readFileSync(join(mesh, f), 'utf8'))));
    expect(hits).toEqual([]);
  });
});
