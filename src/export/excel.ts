// Excel (.xlsx) 出力。UI はここの2関数だけを呼ぶ（契約: contract.ts）。
//  - exportResultsWorkbook: 解析結果のまとめ（概要・条件・形状・材料・場ごとのヒートマップ・履歴）
//  - exportFormulaWorkbook: 動画（@CFDbyHand）と同じ、Excel が反復計算で対流拡散を解く数式ブック
//
// exceljs はブラウザ（Vite でバンドル）と Node（テスト）の両方で動く。
// 反復計算の設定（<calcPr iterate="1" .../>）は exceljs が書けないため、jszip で xl/workbook.xml を後処理する。

import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { analysisLabel, ANALYSIS_KINDS } from '../core/analyses';
import { getMaterial } from '../core/materials';
import type {
  AnalysisKind,
  EdgeBC,
  Field,
  Material,
  Project,
  Raster,
  ResultSet,
  Shape,
  ShapeGeom,
  ShapeRole,
} from '../core/types';

// ---------- 定数 ----------

/** 場シートで、格子が始まる前のヘッダー行数（格子は FIELD_HEADER_ROWS + 1 行目から） */
export const FIELD_HEADER_ROWS = 4;
/** これより大きい格子は平均化で間引く（1辺のセル数） */
const MAX_FIELD_CELLS = 250;
/** 数式ブックの格子上限 */
export const FORMULA_MAX_NX = 120;
export const FORMULA_MAX_NY = 80;
/** 数式ブックのシート名 */
export const FORMULA_SHEET_NAME = '対流拡散';

/** 解析の名前（画面のタブと同じ。core/analyses.ts） */
const ANALYSIS_NAME: Record<AnalysisKind, string> = Object.fromEntries(ANALYSIS_KINDS.map((k) => [k, analysisLabel(k)])) as Record<AnalysisKind, string>;

/** シート名に使う短い名前。PC のエンジンの結果（label あり）は「強度本計算」のように Lite と区別する */
function sheetPrefix(rs: ResultSet): string {
  return rs.label ? `${ANALYSIS_NAME[rs.analysis]}本計算` : ANALYSIS_NAME[rs.analysis];
}

/** 見出しに使う名前（label があれば添える） */
function titleName(rs: ResultSet): string {
  return rs.label ? `${ANALYSIS_NAME[rs.analysis]}・${rs.label}` : ANALYSIS_NAME[rs.analysis];
}

const ROLE_NAME: Record<ShapeRole, string> = {
  solid: '物体',
  heatSource: '発熱体',
  hole: '穴',
  fixedTemp: '固定温度',
  support: '固定支持',
  load: '荷重',
};

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDE6F0' } };
const GRAY_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBFBFBF' } };
const LIGHT_GRAY_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4E4E4' } };
const INPUT_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8D6' } };
const BLUE = 'FF2F5FBF';
const WHITE = 'FFFFFFFF';
const RED = 'FFD0412E';

// ---------- 共通ヘルパー ----------

/** 1始まりの列番号 → 列名（1 → A, 27 → AA） */
function colName(c: number): string {
  let s = '';
  let n = c;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function addr(row: number, col: number, absolute = false): string {
  return absolute ? `$${colName(col)}$${row}` : `${colName(col)}${row}`;
}

/** シート名に使えない文字を除き、31文字以内・大文字小文字を区別せず一意にする */
function makeSheetName(base: string, used: Set<string>): string {
  let name = base.replace(/[\\/?*[\]:]/g, '_').replace(/^'+|'+$/g, '').trim();
  if (name === '') name = 'シート';
  name = name.slice(0, 31);
  let candidate = name;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `_${n}`;
    candidate = name.slice(0, 31 - suffix.length) + suffix;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.border = { bottom: { style: 'thin' } };
  });
}

async function toBytes(wb: ExcelJS.Workbook): Promise<Uint8Array> {
  const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer | Uint8Array;
  return new Uint8Array(buf);
}

function dateString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function safeMaterial(id: string): Material | null {
  try {
    return getMaterial(id);
  } catch {
    return null;
  }
}

function materialName(id: string): string {
  return safeMaterial(id)?.name ?? `不明(${id})`;
}

function geomText(g: ShapeGeom): string {
  switch (g.kind) {
    case 'rect':
      return `矩形 左下(${g.x}, ${g.y}) m、幅 ${g.w} m × 高さ ${g.h} m`;
    case 'circle':
      return `円 中心(${g.cx}, ${g.cy}) m、半径 ${g.r} m`;
    case 'polygon':
      return `多角形 ${g.points.length}点 ` + g.points.map(([x, y]) => `(${+x.toFixed(4)}, ${+y.toFixed(4)})`).join(' ');
  }
}

function edgeText(e: EdgeBC): string {
  switch (e.type) {
    case 'adiabatic':
      return '断熱';
    case 'temp':
      return `温度固定 ${e.tempC} °C`;
    case 'convection':
      return `対流 h = ${e.h} W/(m²·K)`;
  }
}

// ---------- 場シート ----------

interface GridData {
  nx: number;
  ny: number;
  /** 長さ nx*ny、j * nx + i。無効セルは NaN */
  values: Float64Array;
  /** 間引き率（1 = 間引きなし） */
  factor: number;
}

/** 無効セルを NaN にして、大きければブロック平均で間引く */
function prepareGrid(field: Field, nx: number, ny: number): GridData {
  const n = nx * ny;
  const src = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const ok = (field.mask ? field.mask[k] !== 0 : true) && Number.isFinite(field.data[k]);
    src[k] = ok ? field.data[k] : NaN;
  }
  const factor = Math.max(1, Math.ceil(Math.max(nx, ny) / MAX_FIELD_CELLS));
  if (factor === 1) return { nx, ny, values: src, factor };
  const ox = Math.ceil(nx / factor);
  const oy = Math.ceil(ny / factor);
  const out = new Float64Array(ox * oy);
  for (let jo = 0; jo < oy; jo++) {
    for (let io = 0; io < ox; io++) {
      let sum = 0;
      let cnt = 0;
      for (let j = jo * factor; j < Math.min(ny, (jo + 1) * factor); j++) {
        for (let i = io * factor; i < Math.min(nx, (io + 1) * factor); i++) {
          const v = src[j * nx + i];
          if (!Number.isNaN(v)) {
            sum += v;
            cnt += 1;
          }
        }
      }
      out[jo * ox + io] = cnt > 0 ? sum / cnt : NaN;
    }
  }
  return { nx: ox, ny: oy, values: out, factor };
}

/** 絶対値の大きさに応じて有効数字3桁程度になる表示形式 */
function pickNumFmt(absMax: number): string {
  if (absMax === 0) return '0.000';
  if (absMax >= 1000 || absMax < 0.01) return '0.00E+00';
  if (absMax >= 100) return '0.0';
  if (absMax >= 10) return '0.00';
  return '0.000';
}

function colorScaleRule(diverging: boolean, mid: number): ExcelJS.ConditionalFormattingRule {
  return {
    type: 'colorScale',
    priority: 1,
    cfvo: [{ type: 'min' }, diverging ? { type: 'num', value: mid } : { type: 'percentile', value: 50 }, { type: 'max' }],
    color: [{ argb: BLUE }, { argb: WHITE }, { argb: RED }],
  };
}

function addFieldSheet(wb: ExcelJS.Workbook, name: string, rs: ResultSet, field: Field): void {
  const ws = wb.addWorksheet(name);
  const g = prepareGrid(field, rs.nx, rs.ny);
  const unit = field.unit ? ` [${field.unit}]` : '';

  let min = Infinity;
  let max = -Infinity;
  for (const v of g.values) {
    if (Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const hasData = min <= max;
  const absMax = hasData ? Math.max(Math.abs(min), Math.abs(max)) : 0;
  const numFmt = pickNumFmt(absMax);

  // ヘッダー領域（セル幅が狭いので文字は右へあふれて表示される）
  ws.getCell(1, 1).value = `${field.label}${unit}`;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.getCell(2, 1).value = hasData
    ? `最小 ${+min.toPrecision(4)} ／ 最大 ${+max.toPrecision(4)}${unit}`
    : '有効なセルがありません';
  const notes = [`解析: ${titleName(rs)}　格子 ${rs.nx}×${rs.ny}、セル幅 ${rs.h} m。上端が領域の上（j = ny-1）、左端が i = 0。`];
  if (field.diverging) notes.push('0 を中心に青（負）・赤（正）で色分け。');
  if (g.factor > 1) notes.push(`格子が大きいため ${g.factor}×${g.factor} セルの平均で間引いています（${g.nx}×${g.ny}）。`);
  if (field.mask) notes.push('灰色のセルは値が無効（物体の外・内など）。');
  ws.getCell(3, 1).value = notes.join(' ');
  ws.getCell(3, 1).font = { color: { argb: 'FF666666' }, size: 9 };

  // 列幅・行高さ（正方形に近いセル）
  for (let c = 1; c <= g.nx; c++) ws.getColumn(c).width = 2.6;
  const top = FIELD_HEADER_ROWS + 1;
  for (let jo = 0; jo < g.ny; jo++) {
    const rowIdx = top + (g.ny - 1 - jo); // 上端 = j が最大
    const row = ws.getRow(rowIdx);
    row.height = 16;
    for (let io = 0; io < g.nx; io++) {
      const v = g.values[jo * g.nx + io];
      const cell = row.getCell(io + 1);
      if (Number.isNaN(v)) {
        if (field.mask) cell.fill = LIGHT_GRAY_FILL;
        continue;
      }
      cell.value = v;
      cell.numFmt = numFmt;
      cell.font = { size: 4 };
    }
  }

  if (hasData && g.nx > 0 && g.ny > 0) {
    ws.addConditionalFormatting({
      ref: `A${top}:${colName(g.nx)}${top + g.ny - 1}`,
      rules: [colorScaleRule(!!field.diverging, 0)],
    });
  }
}

// ---------- 概要・条件・形状・材料 ----------

function addOverviewSheet(wb: ExcelJS.Workbook, project: Project, results: ResultSet[]): void {
  const ws = wb.addWorksheet('概要');
  ws.columns = [{ width: 28 }, { width: 22 }, { width: 14 }, { width: 40 }];

  const title = ws.addRow(['Studio M 解析結果']);
  title.font = { bold: true, size: 16 };
  ws.addRow([]);

  const kv = (k: string, v: string | number, unit = '') => {
    const r = ws.addRow([k, v, unit]);
    r.getCell(1).font = { bold: true };
    return r;
  };
  const { width, height, nx } = project.domain;
  const ny = results[0]?.ny ?? Math.max(1, Math.round(height / (width / nx)));
  kv('プロジェクト名', project.name);
  kv('出力日時', dateString(new Date()));
  kv('解析領域 幅', width, 'm');
  kv('解析領域 高さ', height, 'm');
  kv('格子 nx', nx);
  kv('格子 ny', ny);
  kv('セル幅 h', width / nx, 'm');
  kv('奥行き厚さ', project.thickness, 'm');

  for (const rs of results) {
    ws.addRow([]);
    const head = ws.addRow([`【${titleName(rs)}】 解析結果（格子 ${rs.nx}×${rs.ny}、h = ${rs.h} m）`]);
    head.font = { bold: true, size: 13 };
    const th = ws.addRow(['項目', '値', '単位']);
    styleHeaderRow(th);
    if (rs.scalars.length === 0) ws.addRow(['（代表値なし）']);
    for (const s of rs.scalars) {
      const r = ws.addRow([s.label, s.value, s.unit]);
      r.getCell(2).numFmt = '0.000E+00';
      if (Number.isFinite(s.value) && Math.abs(s.value) >= 0.01 && Math.abs(s.value) < 100000) r.getCell(2).numFmt = '0.000';
    }
    if (rs.warnings.length > 0) {
      const wh = ws.addRow(['注意']);
      wh.font = { bold: true, color: { argb: 'FFB45309' } };
      for (const w of rs.warnings) {
        const r = ws.addRow([w]);
        r.getCell(1).font = { color: { argb: 'FFB45309' } };
      }
    }
  }
}

function addConditionsSheet(wb: ExcelJS.Workbook, project: Project): void {
  const ws = wb.addWorksheet('条件');
  ws.columns = [{ width: 14 }, { width: 34 }, { width: 24 }, { width: 14 }];
  styleHeaderRow(ws.addRow(['区分', '項目', '値', '単位']));
  const f = project.flow;
  const h = project.heat;
  const sc = project.scalar;
  const rows: (string | number)[][] = [
    ['流れ', '流体', materialName(f.fluidId), ''],
    ['流れ', '流入速度（左端から一様流入）', f.inletVelocity, 'm/s'],
    ['流れ', '上下の壁', f.walls === 'slip' ? 'スリップ（対称）' : 'ノースリップ（壁面）', ''],
    ...(f.thermal?.enabled === true
      ? [
          ['流れ', '温度も計算する（風で冷やす）', 'する', ''],
          ['流れ', '流入する風の温度', f.thermal.inletTempC ?? 25, '°C'],
        ]
      : []),
    ['熱', '周囲温度', h.ambientC, '°C'],
    ['熱', '表面熱伝達率', h.surfaceH, 'W/(m²·K)'],
    ['熱', '板の表裏面からの放熱', h.faceCooling ? 'あり' : 'なし', ''],
    ['熱', '境界条件 左辺', edgeText(h.edges.left), ''],
    ['熱', '境界条件 右辺', edgeText(h.edges.right), ''],
    ['熱', '境界条件 上辺', edgeText(h.edges.top), ''],
    ['熱', '境界条件 下辺', edgeText(h.edges.bottom), ''],
    ['強度', '自重', project.stress.selfWeight ? '考慮する（-y 方向）' : '考慮しない', ''],
    ['対流拡散', '流速 u（x 方向、一様）', sc.u, 'm/s'],
    ['対流拡散', '拡散係数 Γ', sc.gamma, 'kg/(m·s)'],
    ['対流拡散', '密度 ρ', sc.rho, 'kg/m³'],
    ['対流拡散', '流入側の φ', sc.phiInlet, ''],
    ['対流拡散', '物体表面の φ', sc.phiBody, ''],
  ];
  for (const r of rows) ws.addRow(r);
}

function addShapesSheet(wb: ExcelJS.Workbook, project: Project): void {
  const ws = wb.addWorksheet('形状');
  ws.columns = [{ width: 18 }, { width: 12 }, { width: 20 }, { width: 56 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
  styleHeaderRow(ws.addRow(['名前', '役割', '材料', '形状', '発熱量 [W]', '固定温度 [°C]', '荷重 Fx [N]', '荷重 Fy [N]']));
  for (const s of project.shapes) {
    const hasMat = s.role === 'solid' || s.role === 'heatSource';
    ws.addRow([
      s.name,
      ROLE_NAME[s.role],
      hasMat ? materialName(s.materialId) : '-',
      geomText(s.geom),
      s.role === 'heatSource' ? (s.heatW ?? 0) : null,
      s.role === 'fixedTemp' ? (s.tempC ?? 20) : null,
      s.role === 'load' ? (s.force?.fx ?? 0) : null,
      s.role === 'load' ? (s.force?.fy ?? 0) : null,
    ]);
  }
  if (project.shapes.length === 0) ws.addRow(['（形状なし）']);
}

function usedMaterials(project: Project): Material[] {
  const ids: string[] = [project.flow.fluidId];
  for (const s of project.shapes as Shape[]) {
    if (s.role === 'solid' || s.role === 'heatSource') ids.push(s.materialId);
  }
  const seen = new Set<string>();
  const out: Material[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const m = safeMaterial(id);
    if (m) out.push(m);
  }
  return out;
}

function addMaterialsSheet(wb: ExcelJS.Workbook, project: Project): void {
  const ws = wb.addWorksheet('材料');
  ws.columns = [
    { width: 22 }, { width: 8 }, { width: 14 }, { width: 18 }, { width: 16 },
    { width: 18 }, { width: 12 }, { width: 18 }, { width: 18 }, { width: 44 },
  ];
  styleHeaderRow(
    ws.addRow([
      '名前', '種類', '密度 ρ [kg/m³]', '熱伝導率 k [W/(m·K)]', '比熱 cp [J/(kg·K)]',
      '縦弾性係数 E [Pa]', 'ポアソン比 ν', '降伏応力 [Pa]', '動粘性係数 [m²/s]', '備考',
    ]),
  );
  for (const m of usedMaterials(project)) {
    const r = ws.addRow([
      m.name, m.kind === 'fluid' ? '流体' : '固体', m.rho, m.k, m.cp,
      m.E ?? null, m.nu ?? null, m.yield ?? null, m.viscosity ?? null, m.note ?? '',
    ]);
    for (const c of [6, 8, 9]) r.getCell(c).numFmt = '0.00E+00';
  }
}

function addHistorySheet(wb: ExcelJS.Workbook, name: string, rs: ResultSet): void {
  const ws = wb.addWorksheet(name);
  // 履歴ごとの長さが違ってよいので、履歴ごとに t と値の2列のペアにする
  const header: string[] = [];
  rs.history.forEach((h) => {
    header.push('t', `${h.label}${h.unit ? ` [${h.unit}]` : ''}`);
  });
  styleHeaderRow(ws.addRow(header));
  const maxLen = Math.max(0, ...rs.history.map((h) => Math.min(h.t.length, h.values.length)));
  for (let k = 0; k < maxLen; k++) {
    const row = ws.getRow(k + 2);
    rs.history.forEach((h, idx) => {
      if (k < h.t.length && k < h.values.length) {
        row.getCell(idx * 2 + 1).value = h.t[k];
        row.getCell(idx * 2 + 2).value = h.values[k];
      }
    });
  }
  rs.history.forEach((_, idx) => {
    ws.getColumn(idx * 2 + 1).width = 12;
    ws.getColumn(idx * 2 + 2).width = 22;
  });
}

// ---------- 公開API 1: 結果ブック ----------

export async function exportResultsWorkbook(project: Project, results: ResultSet[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Studio M';
  wb.created = new Date();
  const used = new Set<string>();
  for (const n of ['概要', '条件', '形状', '材料']) used.add(n.toLowerCase());

  addOverviewSheet(wb, project, results);
  addConditionsSheet(wb, project);
  addShapesSheet(wb, project);
  addMaterialsSheet(wb, project);

  for (const rs of results) {
    for (const field of rs.fields) {
      const name = makeSheetName(`${sheetPrefix(rs)}_${field.label}`, used);
      addFieldSheet(wb, name, rs, field);
    }
    if (rs.history.length > 0) {
      addHistorySheet(wb, makeSheetName(`履歴_${sheetPrefix(rs)}`, used), rs);
    }
  }
  return toBytes(wb);
}

// ---------- 公開API 2: 数式ブック ----------

/** 数式ブックのレイアウト（列は B から格子。パラメータは固定の絶対参照） */
const GRID_COL0 = 2; // 格子の最初の列（A 列は「流入」ラベル）
const PARAM_VALUE_COL = 14; // N 列: パラメータの値（結合セル N:S）
const PARAM_LABEL_LAST = 13; // M 列まで: ラベル（結合セル B:M）
const PARAM_UNIT_COL = 20; // T 列から: 単位（結合セル T:W）
const PARAM_LAST_COL = 23; // W 列
const PARAM_ROW0 = 5;

/** パラメータ名 → 絶対参照 */
const P = {
  dx: addr(PARAM_ROW0, PARAM_VALUE_COL, true),
  u: addr(PARAM_ROW0 + 1, PARAM_VALUE_COL, true),
  gamma: addr(PARAM_ROW0 + 2, PARAM_VALUE_COL, true),
  rho: addr(PARAM_ROW0 + 3, PARAM_VALUE_COL, true),
  phiIn: addr(PARAM_ROW0 + 4, PARAM_VALUE_COL, true),
  phiBody: addr(PARAM_ROW0 + 5, PARAM_VALUE_COL, true),
  F: addr(PARAM_ROW0 + 6, PARAM_VALUE_COL, true),
  D: addr(PARAM_ROW0 + 7, PARAM_VALUE_COL, true),
  Pe: addr(PARAM_ROW0 + 8, PARAM_VALUE_COL, true),
  aW: addr(PARAM_ROW0 + 9, PARAM_VALUE_COL, true),
  aE: addr(PARAM_ROW0 + 10, PARAM_VALUE_COL, true),
  aN: addr(PARAM_ROW0 + 11, PARAM_VALUE_COL, true),
  aIn: addr(PARAM_ROW0 + 12, PARAM_VALUE_COL, true),
  aWall: addr(PARAM_ROW0 + 13, PARAM_VALUE_COL, true),
};

/** xl/workbook.xml の calcPr に反復計算の設定を書き込む */
async function enableIterativeCalc(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file('xl/workbook.xml');
  if (!file) throw new Error('xlsx の中に xl/workbook.xml が見つかりません');
  let xml = await file.async('string');
  const calcPr = '<calcPr calcId="171027" iterate="1" iterateCount="1000" iterateDelta="0.00001" fullCalcOnLoad="1"/>';
  if (/<calcPr\b[^>]*\/>/.test(xml)) {
    xml = xml.replace(/<calcPr\b[^>]*\/>/, calcPr);
  } else if (/<calcPr\b[^>]*>[\s\S]*?<\/calcPr>/.test(xml)) {
    xml = xml.replace(/<calcPr\b[^>]*>[\s\S]*?<\/calcPr>/, calcPr);
  } else {
    // calcPr が無い場合は workbook の閉じタグの前（extLst があればその前）へ入れる
    xml = xml.includes('<extLst') ? xml.replace('<extLst', `${calcPr}<extLst`) : xml.replace('</workbook>', `${calcPr}</workbook>`);
  }
  zip.file('xl/workbook.xml', xml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function exportFormulaWorkbook(project: Project, raster: Raster): Promise<Uint8Array> {
  const { nx, ny, h } = raster;
  if (nx > FORMULA_MAX_NX || ny > FORMULA_MAX_NY) {
    throw new Error(
      `格子が大きすぎます（${nx}×${ny}）。Excel数式版は ${FORMULA_MAX_NX}×${FORMULA_MAX_NY} セル以下にしてください。` +
        `解析領域の格子数 nx を小さく（例: nx = 60）して、格子を粗くしてから出力してください。`,
    );
  }

  const sc = project.scalar;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Studio M';
  wb.created = new Date();
  wb.calcProperties.fullCalcOnLoad = true;
  const ws = wb.addWorksheet(FORMULA_SHEET_NAME);

  const lastCol = Math.max(GRID_COL0 + nx - 1, PARAM_LAST_COL);
  ws.getColumn(1).width = 12;
  for (let c = GRID_COL0; c <= lastCol; c++) ws.getColumn(c).width = 2.6;

  const merged = (r: number, c1: number, c2: number, value: ExcelJS.CellValue, font?: Partial<ExcelJS.Font>) => {
    ws.mergeCells(r, c1, r, c2);
    const cell = ws.getCell(r, c1);
    cell.value = value;
    if (font) cell.font = font;
    return cell;
  };

  // タイトル
  merged(1, 1, PARAM_LAST_COL, 'Studio M — Excel で解く対流拡散（@CFDbyHand 方式）', { bold: true, size: 14 });
  merged(
    2,
    1,
    PARAM_LAST_COL,
    `${project.name}　格子 ${nx}×${ny}、セル幅 ${h} m。全セルが格子点で、Excel の反復計算が定常解を求めます。`,
    { color: { argb: 'FF666666' }, size: 9 },
  );

  // パラメータブロック
  merged(PARAM_ROW0 - 1, 2, PARAM_LAST_COL, 'パラメータ（黄色のセルは変更できます。変えると再計算されます）', { bold: true });
  const param = (
    idx: number,
    label: string,
    value: number | { formula: string; result: number },
    unit: string,
    input: boolean,
    numFmt = 'General',
  ) => {
    const r = PARAM_ROW0 + idx;
    merged(r, 2, PARAM_LABEL_LAST, label);
    const vc = merged(r, PARAM_VALUE_COL, PARAM_UNIT_COL - 1, value);
    vc.numFmt = numFmt;
    vc.alignment = { horizontal: 'right' };
    vc.border = { bottom: { style: 'thin' } };
    if (input) {
      vc.fill = INPUT_FILL;
      vc.font = { color: { argb: 'FF0000FF' }, bold: true };
    }
    merged(r, PARAM_UNIT_COL, PARAM_LAST_COL, unit, { color: { argb: 'FF666666' } });
  };

  const F0 = sc.rho * sc.u * h;
  const D0 = sc.gamma;
  const aW0 = Math.max(F0, D0 + F0 / 2, 0);
  const aE0 = Math.max(-F0, D0 - F0 / 2, 0);
  const aIn0 = Math.max(F0, 2 * D0 + F0 / 2, 0);
  param(0, 'dx = dy（格子幅）', h, 'm', true);
  param(1, 'u（x 方向の一様流速）', sc.u, 'm/s', true);
  param(2, 'Γ（拡散係数）', sc.gamma, 'kg/(m·s)', true);
  param(3, 'ρ（密度）', sc.rho, 'kg/m³', true);
  param(4, 'φ 流入（左端 Inlet）', sc.phiInlet, '', true);
  param(5, 'φ 物体（四角柱の表面）', sc.phiBody, '', true);
  param(6, 'F = ρ·u·dx（対流の流量）', { formula: `${P.rho}*${P.u}*${P.dx}`, result: F0 }, 'kg/(m·s)', false, '0.0000');
  param(7, 'D = Γ（拡散コンダクタンス、dx=dy・奥行1）', { formula: P.gamma, result: D0 }, 'kg/(m·s)', false, '0.0000');
  param(8, 'Pe = F / D（セルペクレ数）', { formula: `IF(${P.D}=0,0,${P.F}/${P.D})`, result: D0 === 0 ? 0 : F0 / D0 }, '', false, '0.000');
  param(9, 'aW 内部 = MAX(F, D+F/2, 0)', { formula: `MAX(${P.F},${P.D}+${P.F}/2,0)`, result: aW0 }, 'ハイブリッド差分', false, '0.0000');
  param(10, 'aE 内部 = MAX(-F, D-F/2, 0)', { formula: `MAX(-${P.F},${P.D}-${P.F}/2,0)`, result: aE0 }, 'ハイブリッド差分', false, '0.0000');
  param(11, 'aN = aS = D', { formula: P.D, result: D0 }, '', false, '0.0000');
  param(12, 'a 流入面 = MAX(F, 2D+F/2, 0)', { formula: `MAX(${P.F},2*${P.D}+${P.F}/2,0)`, result: aIn0 }, '半セル(h/2)で拡散2D', false, '0.0000');
  param(13, 'a 物体面 = 2D（対流なし）', { formula: `2*${P.D}`, result: 2 * D0 }, '半セル(h/2)で拡散2D', false, '0.0000');

  // 使い方
  const noteRow0 = PARAM_ROW0 + 15;
  const noteLast = Math.max(PARAM_LAST_COL, lastCol);
  merged(noteRow0, 2, noteLast, '使い方', { bold: true });
  const notes = [
    '1. 各セルは格子点の φ を求める数式（隣接4セルの加重平均）です。互いに参照し合う循環参照なので、反復計算を使います。',
    '2. Excel が「循環参照」の警告を出したら、ファイル > オプション > 数式 > 「反復計算を有効にする」にチェックを入れます（このファイルは設定済みですが、先に開いた別のブックの設定が優先されることがあります）。',
    '3. F9 を押すと反復が進みます。色が変わらなくなったら収束です。格子が細かいほど多くの回数が必要です。',
    '4. 左端は流入（φ = 流入値）、右端は流出（勾配ゼロ）、上下は対称、灰色のセルは物体（φ = 物体値）です。',
    '5. 離散化: 有限体積法・ハイブリッド差分。φP = (aW·φW + aE·φE + aN·φN + aS·φS + b) / aP。',
  ];
  notes.forEach((t, k) => merged(noteRow0 + 1 + k, 2, noteLast, t, { size: 9 }));

  // 格子
  const labelTop = noteRow0 + notes.length + 2; // 「対称（上）」ラベルの行
  const gridTop = labelTop + 1; // 領域の最上段 (j = ny-1)
  const rowOf = (j: number) => gridTop + (ny - 1 - j);
  const colOf = (i: number) => GRID_COL0 + i;
  const rightLabelCol = GRID_COL0 + nx;

  merged(labelTop, GRID_COL0, GRID_COL0 + nx - 1, 'Symmetry / 対称（上）', { bold: true, size: 9 }).alignment = { horizontal: 'center' };
  merged(rowOf(0) + 1, GRID_COL0, GRID_COL0 + nx - 1, 'Symmetry / 対称（下）', { bold: true, size: 9 }).alignment = { horizontal: 'center' };
  const midRow = gridTop + Math.floor(ny / 2);
  const inlet = ws.getCell(midRow, 1);
  inlet.value = 'Inlet / 流入 →';
  inlet.font = { bold: true, size: 9 };
  inlet.alignment = { horizontal: 'right' };
  const outlet = ws.getCell(midRow, rightLabelCol);
  outlet.value = '→ Outlet / 流出';
  outlet.font = { bold: true, size: 9 };
  if (rightLabelCol > PARAM_LAST_COL) ws.getColumn(rightLabelCol).width = 16;

  const isSolid = (i: number, j: number) => raster.solid[j * nx + i] !== 0;
  const ref = (i: number, j: number) => addr(rowOf(j), colOf(i));

  for (let j = 0; j < ny; j++) {
    const row = ws.getRow(rowOf(j));
    row.height = 16;
    for (let i = 0; i < nx; i++) {
      const cell = row.getCell(colOf(i));
      cell.numFmt = '0.00';
      cell.font = { size: 5 };
      if (isSolid(i, j)) {
        // 物体: φ = 物体値（参照のみ）
        cell.value = { formula: P.phiBody, result: sc.phiBody };
        cell.fill = GRAY_FILL;
        continue;
      }
      const num: string[] = [];
      const den: string[] = [];
      const neighbor = (ni: number, nj: number, aInner: string) => {
        if (isSolid(ni, nj)) {
          num.push(`${P.aWall}*${P.phiBody}`);
          den.push(P.aWall);
        } else {
          num.push(`${aInner}*${ref(ni, nj)}`);
          den.push(aInner);
        }
      };
      // 西: 左端は流入面（半セル離れた φ = 流入値）
      if (i === 0) {
        num.push(`${P.aIn}*${P.phiIn}`);
        den.push(P.aIn);
      } else neighbor(i - 1, j, P.aW);
      // 東: 右端は流出（勾配ゼロ → 係数なし）
      if (i < nx - 1) neighbor(i + 1, j, P.aE);
      // 北・南: 上下端は対称（係数なし）
      if (j < ny - 1) neighbor(i, j + 1, P.aN);
      if (j > 0) neighbor(i, j - 1, P.aN);
      cell.value = { formula: `(${num.join('+')})/(${den.join('+')})`, result: sc.phiInlet };
    }
  }

  // 3色スケール（青-白-赤）。物体セルは灰色のまま残すため、流体セルの連続区間だけを対象にする
  const runs: string[] = [];
  for (let j = ny - 1; j >= 0; j--) {
    let start = -1;
    for (let i = 0; i <= nx; i++) {
      const fluid = i < nx && !isSolid(i, j);
      if (fluid && start < 0) start = i;
      if (!fluid && start >= 0) {
        runs.push(start === i - 1 ? ref(start, j) : `${ref(start, j)}:${ref(i - 1, j)}`);
        start = -1;
      }
    }
  }
  if (runs.length > 0) {
    ws.addConditionalFormatting({ ref: runs.join(' '), rules: [colorScaleRule(false, 0)] });
  }

  return enableIterativeCalc(await toBytes(wb));
}
