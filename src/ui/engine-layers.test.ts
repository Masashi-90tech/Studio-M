// PC のエンジンまわりの画面の約束の確認:
//  - 通信・ロジック・設定（engine-client / engine-logic / remote-results）は DOM に触れない
//  - 通信・パネル・結果カード・セッションは、入口（engine-open.ts）から遅延 import だけで読む
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI = __dirname;
const read = (f: string): string => readFileSync(join(UI, f), 'utf8');
const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('PC のエンジンの画面', () => {
  it('engine-client / engine-logic / remote-results は DOM に触れない', () => {
    for (const f of ['engine-client.ts', 'engine-logic.ts', 'remote-results.ts']) {
      const t = strip(read(f));
      expect(t, f).not.toMatch(/\bdocument\b|\bwindow\b|from '\.\/dom'/);
    }
  });

  it('engine-session / engine-panel / engine-view を静的に import するのは、型だけ（実体は engine-open の import()）', () => {
    const hits: string[] = [];
    const files = ['main.ts', ...['prefs-popover.ts', 'engine-open.ts', 'results.ts', 'header.ts', 'runner.ts'].map((f) => `ui/${f}`)];
    for (const f of files) {
      const text = strip(readFileSync(join(UI, '..', f), 'utf8'));
      for (const m of text.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+['"]\.{1,2}\/(?:ui\/)?(engine-(?:session|panel|view|client))['"]/gm)) {
        if (!m[1]) hits.push(`${f}: ${m[2]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('画面の入口 engine-open.ts は、通信・パネル・カードを import() で読む', () => {
    const t = strip(read('engine-open.ts'));
    for (const name of ['engine-session', 'engine-view', 'engine-panel']) expect(t).toContain(`import('./${name}')`);
  });
});
