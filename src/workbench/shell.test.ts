// 画面（ハーネス）に解析ごとの分岐が残っていないことの確認。
// 解析ごとの知識は src/workbench に置き、画面は登録表（src/workbench の index / registry）だけを見る。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

/** 解析の種類を直接書いてよい画面側のファイル（データ・スキーマ・純粋な補助関数。分岐ではない） */
const ALLOWED = new Set([
  'ui/presets.ts', // プリセットの一覧（各プリセットがどの解析で開くかのデータ）
  'ui/project-utils.ts', // プロジェクト JSON の検証（設定の項目名を並べる）
  'ui/easy-logic.ts', // かんたんパネル用の純粋関数（解析ごとのパネルが使う）
]);

function shellFiles(): string[] {
  const ui = readdirSync(join(SRC, 'ui'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => `ui/${f}`);
  return ['main.ts', ...ui].filter((f) => !ALLOWED.has(f));
}

const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('画面（ハーネス）のシェル', () => {
  it('解析の種類の文字列（\'em\' など）を直接書いていない', () => {
    const hits: string[] = [];
    for (const f of shellFiles()) {
      strip(read(f))
        .split('\n')
        .forEach((line, i) => {
          if (/['"`](flow|heat|stress|em|scalar)['"`]/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('project.flow / .heat / .stress / .em / .scalar を直接読み書きしていない', () => {
    const hits: string[] = [];
    for (const f of shellFiles()) {
      strip(read(f))
        .split('\n')
        .forEach((line, i) => {
          if (/\.(flow|heat|stress|em|scalar)\b/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('ソルバー・解析ごとのモジュール・パネルを直接 import していない（登録表だけを見る）', () => {
    const hits: string[] = [];
    for (const f of shellFiles()) {
      for (const m of read(f).matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2];
        if (/solvers\/|workbench\/(modules|panels|verdicts|verdict-kit)/.test(spec)) hits.push(`${f}: ${spec}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('ソルバーは workbench/modules の loadSolver（遅延 import）からだけ読み込まれる', () => {
    // 画面以外（workbench の中）でも、モジュールとテスト以外はソルバーを import しない
    const hits: string[] = [];
    const walk = (dir: string): string[] =>
      readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
    for (const f of walk('workbench').filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      if (f.startsWith('workbench/modules/')) {
        // モジュールは静的 import（from '…solvers/…'）を使わず、import() だけを使う
        if (/from\s+['"][^'"]*solvers\//.test(read(f))) hits.push(f);
      } else if (/solvers\//.test(strip(read(f)))) hits.push(f);
    }
    expect(hits).toEqual([]);
  });

  it('学びモード（src/learn）は、画面から遅延 import か型としてだけ読み込む', () => {
    // 静的な import（型以外）で learn を読むと、起動時に学びモード全体が入ってしまう
    const hits: string[] = [];
    for (const f of shellFiles()) {
      for (const m of strip(read(f)).matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+['"]([^'"]*learn\/[^'"]*)['"]/gm)) {
        if (!m[1]) hits.push(`${f}: ${m[2]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('KiCad 基板（src/pcb）は、画面から遅延 import か型としてだけ読み込む', () => {
    // 静的な import（型以外・副作用だけの import も含む）で pcb を読むと、起動時に基板の取り込み一式が入ってしまう
    const hits: string[] = [];
    for (const f of shellFiles()) {
      for (const m of strip(read(f)).matchAll(/^\s*import\s+(type\s+)?(?:[^;'"]*?from\s+)?['"]([^'"]*(?:^|\/)pcb(?:\/[^'"]*)?)['"]/gm)) {
        if (!m[1]) hits.push(`${f}: ${m[2]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('画面が KiCad 基板を読む入口は、遅延 import の 1 か所（pcb-open.ts）に集まっている', () => {
    const files = shellFiles().filter((f) => /import\(\s*['"][^'"]*\/pcb\//.test(strip(read(f))));
    expect(files).toEqual(['ui/pcb-open.ts']);
  });

  it('3D モデルの取り込み（src/mesh3d）は、画面から遅延 import か型としてだけ読み込む', () => {
    // 静的な import（型以外・副作用だけの import も含む）で mesh3d を読むと、起動時に 3D ビューアや断面の計算一式が入ってしまう
    const hits: string[] = [];
    for (const f of shellFiles()) {
      for (const m of strip(read(f)).matchAll(/^\s*import\s+(type\s+)?(?:[^;'"]*?from\s+)?['"]([^'"]*(?:^|\/)mesh3d(?:\/[^'"]*)?)['"]/gm)) {
        if (!m[1]) hits.push(`${f}: ${m[2]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('画面が 3D モデルの取り込みを読む入口は、遅延 import の 1 か所（mesh-open.ts）に集まっている', () => {
    const files = shellFiles().filter((f) => /import\(\s*['"][^'"]*\/mesh3d\//.test(strip(read(f))));
    expect(files).toEqual(['ui/mesh-open.ts']);
  });

  it('3D 解析（src/sim3d）は、画面から遅延 import か型としてだけ読み込む', () => {
    // 静的な import（型以外・副作用だけの import も含む）で sim3d を読むと、起動時に 3D 解析の画面・計算の部品一式が入ってしまう
    const hits: string[] = [];
    for (const f of shellFiles()) {
      for (const m of strip(read(f)).matchAll(/^\s*import\s+(type\s+)?(?:[^;'"]*?from\s+)?['"]([^'"]*(?:^|\/)sim3d(?:\/[^'"]*)?)['"]/gm)) {
        if (!m[1]) hits.push(`${f}: ${m[2]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('画面が 3D 解析を読む入口は、遅延 import の 1 か所（sim3d-open.ts）に集まっている', () => {
    const files = shellFiles().filter((f) => /import\(\s*['"][^'"]*\/sim3d\//.test(strip(read(f))));
    expect(files).toEqual(['ui/sim3d-open.ts']);
  });

  it('3D の取り込みダイアログから 3D 解析を開くのは、画面側の入口（mesh-open.ts）がコールバックで渡している', () => {
    expect(strip(read('ui/mesh-open.ts'))).toMatch(/onAnalyze3D[\s\S]*openSim3D/);
    // 取り込みダイアログ自身は sim3d を import しない
    expect(strip(read('mesh3d/import-dialog.ts'))).not.toMatch(/sim3d/);
  });

  it('src/learn は core だけに依存する（ui・workbench・solvers を import しない。テストは除く）', () => {
    const hits: string[] = [];
    const walk = (dir: string): string[] =>
      readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
    for (const f of walk('learn').filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      for (const m of read(f).matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2];
        if (/(^|\/)(ui|workbench|solvers|export)(\/|$)/.test(spec)) hits.push(`${f}: ${spec}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('ワークベンチが learn から読むのは、型（import type）と遅延 import() だけ', () => {
    const hits: string[] = [];
    const walk = (dir: string): string[] =>
      readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
    for (const f of walk('workbench').filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
      for (const m of strip(read(f)).matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+['"]([^'"]*learn\/[^'"]*)['"]/gm)) {
        if (!m[1]) hits.push(`${f}: ${m[2]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
