// ワークベンチの契約テスト: 登録された全モジュールが、型どおりの値を返すかを確かめる。
// 解析を足してもこのテストが自動で対象にするので、モジュールを登録するだけで契約を満たしているか分かる。
import { describe, expect, it } from 'vitest';
import { ANALYSIS_INFO, ANALYSIS_KINDS } from '../core/analyses';
import { resolveProject } from '../core/auto';
import { MATERIALS } from '../core/materials';
import { rasterize } from '../core/raster';
import type { AnalysisKind, Project, Raster, ResultSet, SolverStatus } from '../core/types';
import { DEFAULT_PREFS } from '../ui/modes';
import { PRESETS } from '../ui/presets';
import { createSolver, getWorkbench, listWorkbenches, loadMathProvider, loadSolverFactory, registerWorkbench } from './index';
import type { Verdict, VerdictInput, WorkbenchModule } from './types';
import { CHIP_TEXT } from './verdict-kit';

const LEVELS = Object.keys(CHIP_TEXT);
/** 契約テスト用に粗くした格子の横のセル数（速く終わらせるため） */
const TEST_NX = 48;

/** そのワークベンチの先頭のプリセットを、粗い格子で小さくした計算用プロジェクトと格子化結果 */
function smallCase(wb: WorkbenchModule): { project: Project; raster: Raster } {
  const preset = PRESETS.find((p) => p.id === wb.presets?.[0]);
  if (!preset) throw new Error(`${wb.kind}: presets の先頭がプリセット一覧にありません`);
  const base = preset.build();
  base.domain = { ...base.domain, nx: TEST_NX, autoGrid: false };
  const { project } = resolveProject(base, wb.kind);
  return { project, raster: rasterize(project) };
}

function expectValidResult(r: ResultSet, kind: AnalysisKind): void {
  expect(r.analysis).toBe(kind);
  expect(r.nx).toBeGreaterThan(0);
  expect(r.ny).toBeGreaterThan(0);
  expect(r.h).toBeGreaterThan(0);
  expect(r.fields.length).toBeGreaterThan(0);
  const keys = new Set<string>();
  for (const f of r.fields) {
    expect(f.key, '場の key').not.toBe('');
    expect(keys.has(f.key), `場の key が重複: ${f.key}`).toBe(false);
    keys.add(f.key);
    expect(f.label.length, `${f.key} の label`).toBeGreaterThan(0);
    expect(typeof f.unit, `${f.key} の unit`).toBe('string');
    expect(f.data.length, `${f.key} の data の長さ`).toBe(r.nx * r.ny);
    if (f.mask) expect(f.mask.length, `${f.key} の mask の長さ`).toBe(r.nx * r.ny);
    let bad = 0;
    for (let c = 0; c < f.data.length; c++) {
      if (f.mask && f.mask[c] === 0) continue; // 無効なセルは値を問わない
      if (!Number.isFinite(f.data[c])) bad++;
    }
    expect(bad, `${f.key} に有限でない値が ${bad} 個`).toBe(0);
  }
  for (const s of r.scalars) {
    expect(s.key).not.toBe('');
    expect(s.label.length, `${s.key} の label`).toBeGreaterThan(0);
    expect(typeof s.unit).toBe('string');
    expect(typeof s.value).toBe('number');
  }
  for (const w of r.warnings) expect(typeof w).toBe('string');
}

function expectValidVerdict(v: Verdict | null): void {
  if (v === null) return;
  expect(LEVELS).toContain(v.level);
  expect(v.chip).toBe(CHIP_TEXT[v.level]);
  expect(v.headline.length).toBeGreaterThan(0);
  expect(Array.isArray(v.lines)).toBe(true);
  for (const l of v.lines) expect(typeof l).toBe('string');
  for (const a of v.actions) {
    expect(a.label.length).toBeGreaterThan(0);
    expect(typeof a.kind).toBe('string');
  }
}

describe('登録表', () => {
  it('全ての解析の種類にワークベンチが 1 つずつ登録され、order の昇順で返る', () => {
    const list = listWorkbenches();
    expect(list.map((w) => w.kind)).toEqual([...ANALYSIS_KINDS]);
    expect(new Set(list.map((w) => w.kind)).size).toBe(list.length);
    expect(new Set(list.map((w) => w.order)).size).toBe(list.length);
    for (let i = 1; i < list.length; i++) expect(list[i].order).toBeGreaterThan(list[i - 1].order);
  });
  it('同じ種類を 2 回登録するとエラー', () => {
    const wb = getWorkbench('flow')!;
    expect(() => registerWorkbench({ ...wb })).toThrow();
  });
  it('未登録の種類は undefined', () => {
    expect(getWorkbench('nothing' as AnalysisKind)).toBeUndefined();
  });
});

describe('プリセットとの対応', () => {
  it('モジュールの presets は実在し、その解析のプリセットである', () => {
    for (const wb of listWorkbenches()) {
      for (const id of wb.presets ?? []) {
        const p = PRESETS.find((x) => x.id === id);
        expect(p, `${wb.kind}: プリセット ${id}`).toBeDefined();
        expect(p!.analysis, `${id} の analysis`).toBe(wb.kind);
      }
    }
  });
  it('全てのプリセットがどれかのモジュールの presets に載っている（ちょうど 1 つ）', () => {
    for (const p of PRESETS) {
      const owners = listWorkbenches().filter((w) => w.presets?.includes(p.id));
      expect(owners.map((w) => w.kind), `プリセット ${p.id}`).toEqual([p.analysis]);
    }
  });
});

describe.each(listWorkbenches().map((w) => [w.kind, w] as const))('ワークベンチ %s', (kind, wb) => {
  it('名前・説明・並び順が core/analyses.ts と合っている', () => {
    expect(wb.label.length).toBeGreaterThan(0);
    expect(wb.label).toBe(ANALYSIS_INFO[kind].label);
    expect(wb.order).toBe(ANALYSIS_INFO[kind].order);
    expect(wb.shortHint.length).toBeGreaterThan(0);
    expect(getWorkbench(kind)).toBe(wb);
  });

  it('材料の表示名が空にならない', () => {
    for (const m of MATERIALS.filter((x) => x.kind === 'solid')) {
      expect((wb.materialLabel?.(m) ?? m.name).length).toBeGreaterThan(0);
    }
  });

  it('パネルと重ね描きのローダーが関数を返す', async () => {
    const ui = wb.ui;
    const loaded = await Promise.all([ui?.loadSettings?.(), ui?.loadEasy?.(), ui?.loadPro?.(), ui?.loadOverlay?.(), ui?.loadResultsExtra?.()]);
    for (const f of loaded) if (f !== undefined) expect(typeof f).toBe('function');
    // 数学の窓は省略可。付いているなら読み込める形であること
    if (wb.math) expect(typeof wb.math.loadProvider).toBe('function');
  });

  it('数学の窓の式の提供者を登録表から読み込め、種類が合っていて、結果なしでも式を返す', async () => {
    expect(wb.math, `${kind}: math.loadProvider`).toBeDefined();
    const provider = await loadMathProvider(kind);
    expect(provider?.kind).toBe(kind);
    expect(await loadMathProvider(kind)).toBe(provider); // 2 回目は同じもの
    const { project } = smallCase(wb);
    const formulas = provider!.formulas({ project, result: null });
    expect(formulas.length).toBeGreaterThan(0);
    for (const f of formulas) expect(Number.isFinite(f.evaluate(Object.fromEntries(f.vars.map((v) => [v.key, v.value]))))).toBe(true);
  });

  it('ソルバーが契約どおりの ResultSet を返し、判定が妥当な値を返す', async () => {
    const factory = await wb.loadSolver();
    expect(typeof factory).toBe('function');
    expect(await loadSolverFactory(kind)).toBe(factory);

    const { project, raster } = smallCase(wb);
    expect(Array.isArray(wb.hints?.({ project, raster }) ?? [])).toBe(true);

    const solver = await createSolver({ kind, project, raster });
    expect(solver.analysis).toBe(kind);
    expectValidResult(solver.result(), kind); // 最初の結果（step の前）

    let status: SolverStatus = solver.step(40);
    for (let i = 0; i < 3 && !status.done; i++) status = solver.step(40);
    expect(Number.isFinite(status.progress)).toBe(true);
    expect(status.iteration).toBeGreaterThanOrEqual(0);
    const result = solver.result();
    expectValidResult(result, kind);
    expect(result.nx * result.ny).toBe(raster.nx * raster.ny);

    // 既定の場は、結果にある場の key
    if (wb.defaultField) expect(result.fields.map((f) => f.key)).toContain(wb.defaultField);

    // 判定: 途中経過と「終わった」状態の両方で、null か妥当な Verdict を返す
    const base: Omit<VerdictInput, 'status'> = { kind, project, result, raster, prefs: DEFAULT_PREFS };
    const finished: SolverStatus = { done: true, progress: 1, iteration: Math.max(1, status.iteration) };
    if (wb.verdict) expect(wb.verdictTitle, `${kind}: verdict があるなら verdictTitle も`).toBeTruthy();
    for (const st of [null, status, finished]) {
      const v = wb.verdict?.({ ...base, status: st }) ?? null;
      expectValidVerdict(v);
      // 次の一手は、複製したプロジェクトに適用しても壊れない
      for (const a of v?.actions ?? []) {
        expect(wb.applyAction, `${kind}: action ${a.kind} を扱う applyAction`).toBeDefined();
        const copy = structuredClone(project);
        expect(() => wb.applyAction!({ project: copy, action: a })).not.toThrow();
      }
    }
  });
});
