// テスト用のプロジェクトの作り方（片持ち梁など）。Lite のテストと同じ形に揃えてある。

import { defaultProject } from '../../../src/core/project';
import type { Project, Shape } from '../../../src/core/types';

export const rect = (x: number, y: number, w: number, h: number) => ({ kind: 'rect' as const, x, y, w, h });

let counter = 0;
export function shape(role: Shape['role'], geom: Shape['geom'], extra: Partial<Shape> = {}): Shape {
  counter += 1;
  return { id: `t${counter}`, name: role, role, materialId: 'ss400', geom, ...extra };
}

/** 格子を手動で固定したプロジェクト（autoGrid = false）。nx がそのまま使われる */
export function makeProject(opts: {
  width: number;
  height: number;
  nx: number;
  thickness: number;
  shapes: Shape[];
  selfWeight?: boolean;
}): Project {
  const p = defaultProject();
  p.name = 'CalculiX テスト';
  p.domain = { width: opts.width, height: opts.height, nx: opts.nx, autoGrid: false };
  p.thickness = opts.thickness;
  p.shapes = opts.shapes;
  p.stress = { selfWeight: opts.selfWeight ?? false };
  return p;
}

/** Lite の強度テストと同じ片持ち梁: L = 1 m, H = 0.1 m, 厚さ 0.01 m の鉄（SS400）。左端を固定、右端に下向き P [N] */
export const BEAM = { L: 1.0, H: 0.1, T: 0.01, E: 206e9, yield: 245e6 };

export function steelBeam(opts: { P: number; nx?: number; selfWeight?: boolean }): Project {
  const { L, H, T } = BEAM;
  const nx = opts.nx ?? 100;
  const cell = L / nx;
  return makeProject({
    width: L,
    height: H,
    nx,
    thickness: T,
    selfWeight: opts.selfWeight,
    shapes: [
      shape('solid', rect(0, 0, L, H)),
      shape('support', rect(0, 0, cell, H)), // 左端 1 セル列を固定
      shape('load', rect(L - cell, 0, cell, H), { force: { fx: 0, fy: -opts.P } }), // 右端 1 セル列に下向き荷重
    ],
  });
}

/** 「片持ち梁（アルミ）」プリセットと同じ形: 200 × 10 mm、奥行き 10 mm、先端 100 N */
export function aluminumBeamPreset(): Project {
  const mm = (v: number) => v / 1000;
  const r = (x: number, y: number, w: number, h: number) => rect(mm(x), mm(y), mm(w), mm(h));
  return makeProject({
    width: mm(240),
    height: mm(60),
    nx: 360,
    thickness: mm(10),
    shapes: [
      shape('solid', r(30, 25, 200, 10), { materialId: 'al6061' }),
      shape('support', r(28, 20, 3, 20), { materialId: 'al6061' }),
      shape('load', r(229, 25, 3, 10), { materialId: 'al6061', force: { fx: 0, fy: -100 } }),
    ],
  });
}

export const mm = (v: number) => v / 1000;

/**
 * 熱解析のテスト用: 100 × 60 mm の領域に、板（既定は 80 × 40 mm）と、中央の 10 × 10 mm・5 W の発熱体。
 * 格子は 1 mm（nx = 100）に固定。周囲 25 °C、表面熱伝達率 10、表裏の放熱あり
 */
export function heatPlate(opts: { material?: string; surfaceH?: number; faceCooling?: boolean; fullDomain?: boolean } = {}): Project {
  const mat = opts.material ?? 'al6061';
  const solid = opts.fullDomain ? rect(0, 0, mm(100), mm(60)) : rect(mm(10), mm(10), mm(80), mm(40));
  const chip = opts.fullDomain ? rect(mm(60), mm(25), mm(10), mm(10)) : rect(mm(45), mm(25), mm(10), mm(10));
  const p = makeProject({
    width: mm(100),
    height: mm(60),
    nx: 100,
    thickness: mm(3),
    shapes: [shape('solid', solid, { materialId: mat }), shape('heatSource', chip, { materialId: mat, heatW: 5, name: 'チップ' })],
  });
  p.heat.ambientC = 25;
  p.heat.surfaceH = opts.surfaceH ?? 10;
  p.heat.faceCooling = opts.faceCooling ?? true;
  return p;
}
