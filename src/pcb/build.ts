// 読み込んだ基板（KicadBoard）を、Studio M の熱プロジェクトにする。DOM に依存しない。
//
// 基板の外形 → FR-4 の物体、切り抜き → 穴、銅箔 → project.pcb.layers、
// 発熱する部品 → heatSource（部品の占める範囲の四角。下の基板も熱を伝えるよう材料は FR-4 のまま）
import { defaultProject } from '../core/project';
import type { CopperLayer, Project, Shape } from '../core/types';
import { bboxOf, type BBox, type Pt } from './geom';
import type { KicadBoard, KicadFootprint } from './kicad';
import { matchPart } from './parts';

/** 部品ごとの、利用者による書き換え */
export interface PartOverride {
  /** 熱源として入れるか。省略時は「発熱 > 0 W、または温度を見張る部品」なら入れる */
  included?: boolean;
  watts?: number;
  maxTempC?: number;
}

export interface BuildOptions {
  board: KicadBoard;
  /** 取り込んだファイル名（プロジェクト名と meta に使う） */
  fileName: string;
  /** 解析領域の端から基板までの余白 [mm]。省略時は読み込み時の余白（5） */
  domainMarginMm?: number;
  /** 発熱 0 W の部品も熱源（0 W）として入れて、温度を見られるようにする。省略時 false */
  includeZeroPowerParts?: boolean;
  /** 基板の厚さ [mm]。省略時は基板ファイルの値 */
  boardThicknessMm?: number;
  /** 銅箔の厚さ [µm]。全層に同じ値を使う。省略時は基板ファイルの値（無ければ 35） */
  copperThicknessUm?: number;
  /** 周囲温度 [°C]。省略時 25 */
  ambientC?: number;
  /** 表面の熱伝達率 [W/(m²·K)]。省略時 10（自然対流） */
  surfaceH?: number;
  /** 部品ごとの書き換え。キーは PartAssignment.key */
  overrides?: Record<string, PartOverride>;
  /** 格子の 1 セルの大きさの目標 [mm]。省略時 0.25 */
  targetCellMm?: number;
  /** 格子の最大セル数。省略時 120000 */
  maxCells?: number;
}

export interface PartAssignment {
  /** 部品を見分ける印（基板ファイルでの順番。部品番号が重複しても区別できる） */
  key: string;
  ref: string;
  value: string;
  footprint: string;
  side: 'front' | 'back';
  /** ライブラリの項目 ID。見つからなければ空文字 */
  partType: string;
  /** 種類名（見つからなければ「ライブラリにない部品」） */
  partLabel: string;
  matched: boolean;
  watts: number;
  maxTempC: number;
  /** ライブラリの注意書き。見つからなければ空文字 */
  note: string;
  /** 熱源として入れるか */
  included: boolean;
  /** 部品の範囲 [m]（Studio M の座標。余白の変更を反映済み） */
  bbox: BBox;
}

export interface BuildResult {
  project: Project;
  parts: PartAssignment[];
  warnings: string[];
}

const DEFAULT_MAX_TEMP_C = 105;
const UNMATCHED_LABEL = 'ライブラリにない部品';

function fileBase(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').replace(/\.kicad_pcb$/i, '');
  return base || 'KiCad 基板';
}

function finiteNonNegative(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** 部品の一覧（ライブラリの照合と書き換えを反映）を作る */
export function assignParts(opts: Pick<BuildOptions, 'board' | 'overrides' | 'includeZeroPowerParts'>, shift: [number, number] = [0, 0]): PartAssignment[] {
  const out: PartAssignment[] = [];
  opts.board.footprints.forEach((fp: KicadFootprint, index) => {
    // パッドも範囲も持たない飾り（ロゴなど）は部品として扱わない
    if (fp.padCount === 0) return;
    const key = `fp${index}`;
    const ref = fp.reference || '?';
    const m = matchPart({ ref: fp.reference, value: fp.value, footprint: fp.footprint });
    const ov = opts.overrides?.[key];
    const watts = finiteNonNegative(ov?.watts) ? ov.watts : (m?.entry.defaultW ?? 0);
    const maxTempC = finiteNonNegative(ov?.maxTempC) && ov.maxTempC > 0 ? ov.maxTempC : (m?.entry.maxTempC ?? DEFAULT_MAX_TEMP_C);
    const defaultIncluded = watts > 0 || !!m?.entry.watch || !!opts.includeZeroPowerParts;
    out.push({
      key,
      ref,
      value: fp.value,
      footprint: fp.footprint,
      side: fp.side,
      partType: m?.entry.id ?? '',
      partLabel: m?.entry.label ?? UNMATCHED_LABEL,
      matched: !!m,
      watts,
      maxTempC,
      note: m?.entry.note ?? '',
      included: ov?.included ?? defaultIncluded,
      bbox: { x0: fp.bbox.x0 + shift[0], y0: fp.bbox.y0 + shift[1], x1: fp.bbox.x1 + shift[0], y1: fp.bbox.y1 + shift[1] },
    });
  });
  return out;
}

export function buildPcbProject(opts: BuildOptions): BuildResult {
  const { board } = opts;
  const warnings: string[] = [...board.warnings];
  const marginMm = opts.domainMarginMm ?? board.marginMm;
  // 余白を変えたら、基板ごと平行移動する
  const dx = (marginMm - board.marginMm) * 1e-3;
  const shift = (p: Pt): Pt => (dx === 0 ? p : [p[0] + dx, p[1] + dx]);

  const outline = board.outline.map(shift);
  const holes = board.holes.map((h) => h.map(shift));
  const bb = bboxOf(outline);
  const width = bb.x1 + marginMm * 1e-3;
  const height = bb.y1 + marginMm * 1e-3;

  // ---------- 格子 ----------
  const widthMm = width * 1e3;
  const heightMm = height * 1e3;
  const target = Math.max(0.05, opts.targetCellMm ?? 0.25);
  const maxCells = Math.max(1000, opts.maxCells ?? 120000);
  const capped = Math.sqrt((widthMm * heightMm) / maxCells);
  const cellMm = Math.max(target, capped);
  const nx = Math.max(20, Math.round(widthMm / cellMm));
  const hMm = widthMm / nx;
  const ny = Math.max(1, Math.round(heightMm / hMm));
  warnings.push(
    `格子は 1 セル約 ${hMm.toFixed(2)} mm（${nx} × ${ny} セル）にしました。` +
      (cellMm > target + 1e-9 ? '基板が大きいため、計算が重くならないようセルを大きくしています。' : '') +
      '細い配線はセルの中の銅箔の割合として平均して扱うので、配線の幅そのものは再現されません。',
  );

  // ---------- 基板・銅箔 ----------
  const thicknessMm = opts.boardThicknessMm !== undefined && opts.boardThicknessMm > 0 ? opts.boardThicknessMm : board.thicknessMm;
  const layers: CopperLayer[] = board.layers.map((l) => ({
    name: l.name,
    thicknessUm: opts.copperThicknessUm !== undefined && opts.copperThicknessUm > 0 ? opts.copperThicknessUm : l.thicknessUm,
    polygons: dx === 0 ? l.polygons : l.polygons.map((p) => p.map(shift)),
  }));

  const project = defaultProject();
  project.name = fileBase(opts.fileName);
  project.thickness = thicknessMm * 1e-3;
  project.domain = { width, height, nx, autoGrid: false };
  project.pcb = { source: opts.fileName, boardThicknessMm: thicknessMm, substrateId: 'fr4', layers };
  project.heat = {
    ...project.heat,
    ambientC: opts.ambientC ?? 25,
    surfaceH: opts.surfaceH ?? 10,
    faceCooling: true,
    edges: { left: { type: 'adiabatic' }, right: { type: 'adiabatic' }, top: { type: 'adiabatic' }, bottom: { type: 'adiabatic' } },
  };

  const shapes: Shape[] = [
    { id: 'pcb-board', name: '基板', role: 'solid', materialId: 'fr4', geom: { kind: 'polygon', points: outline }, meta: { source: opts.fileName } },
  ];
  holes.forEach((points, k) => {
    shapes.push({ id: `pcb-hole-${k + 1}`, name: `切り抜き ${k + 1}`, role: 'hole', materialId: 'fr4', geom: { kind: 'polygon', points }, meta: { source: opts.fileName } });
  });

  // ---------- 部品 ----------
  const parts = assignParts(opts, [dx, dx]);
  const minSide = hMm * 1e-3 * 1.5; // 1 セル以上は必ず受け持つ大きさにする
  let enlarged = 0;
  let clipped = 0;
  const sources: { shape: Shape; area: number }[] = [];
  for (const p of parts) {
    if (!p.included) continue;
    // 基板の外にはみ出した分は削る
    let { x0, y0, x1, y1 } = p.bbox;
    x0 = Math.max(x0, bb.x0);
    y0 = Math.max(y0, bb.y0);
    x1 = Math.min(x1, bb.x1);
    y1 = Math.min(y1, bb.y1);
    if (x1 <= x0 || y1 <= y0) {
      warnings.push(`${p.ref} は基板の外にあるため、熱源に入れませんでした。`);
      continue;
    }
    if (x0 > p.bbox.x0 || y0 > p.bbox.y0 || x1 < p.bbox.x1 || y1 < p.bbox.y1) clipped++;
    if (x1 - x0 < minSide) {
      const c = (x0 + x1) / 2;
      x0 = c - minSide / 2;
      x1 = c + minSide / 2;
      enlarged++;
    }
    if (y1 - y0 < minSide) {
      const c = (y0 + y1) / 2;
      y0 = c - minSide / 2;
      y1 = c + minSide / 2;
      enlarged++;
    }
    const name = [p.ref, p.value].filter(Boolean).join(' ');
    sources.push({
      area: (x1 - x0) * (y1 - y0),
      shape: {
        id: `pcb-${p.key}`,
        name,
        role: 'heatSource',
        materialId: 'fr4',
        heatW: p.watts,
        maxTempC: p.maxTempC,
        geom: { kind: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
        meta: { ref: p.ref, value: p.value, footprint: p.footprint, side: p.side, partType: p.partType, source: opts.fileName },
      },
    });
  }
  // 大きい部品を先に置き、小さい部品を上に重ねる（重なっても小さい方が消えない）
  sources.sort((a, b) => b.area - a.area);
  for (const s of sources) shapes.push(s.shape);
  project.shapes = shapes;

  if (enlarged > 0) warnings.push(`小さな部品は、発熱を受け持つセルが確実にできるよう、1 セルより大きく扱っています（${enlarged} 辺）。`);
  if (clipped > 0) warnings.push(`基板の外にはみ出していた部品の範囲を、基板の内側に収めました（${clipped} 個）。`);
  const total = sources.reduce((s, x) => s + (x.shape.heatW ?? 0), 0);
  if (sources.length === 0) {
    warnings.push('発熱する部品が選ばれていません。部品の表で発熱（W）を入れるか、部品を選んでください。');
  } else if (total <= 0) {
    warnings.push('発熱の合計が 0 W です。部品の表で発熱（W）を入れてください。');
  }
  const unknownCount = parts.filter((p) => !p.matched && p.included).length;
  if (unknownCount > 0) warnings.push(`ライブラリにない部品が ${unknownCount} 個あります。発熱と上限温度を自分で入れてください。`);

  return { project, parts, warnings };
}
