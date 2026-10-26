// 3D の検討（Study3D）と 3D の結果（ResultSet3D）を JSON にする・JSON から戻す。
// ファイル（.studiom3d.json）と、将来の PC のエンジンとの通信の両方で使う。書き方は engine-wire.ts（2D）にそろえる。
//
// 型付き配列（Float32Array / Uint32Array / Uint8Array）は、そのままでは JSON にならないので
// { "$typed": "f32" | "u32" | "u8", length, b64 } に直す。受け取った側で元の型に戻す（NaN も壊れない）。
// 読み込みでは中身を検査し、壊れていたら何が悪いかを書いた日本語の Error を投げる。
import { base64ToBytes, bytesToBase64, decodeHistory, decodeScalars, encodeF32, encodeU8 } from './engine-wire';
import type { Analysis3DKind, Field3D, Grid3D, Region3D, Region3DRole, ResultSet3D, ShapeResult, Study3D } from './types';

/** ファイルの種類の印。別の JSON を取り違えないために入れる */
export const STUDY3D_FILE_KIND = 'studio-m-study3d';

interface WireU32 {
  $typed: 'u32';
  length: number;
  b64: string;
}

const ANALYSES: readonly Analysis3DKind[] = ['heat', 'stress'];
const REGION_ROLES: readonly Region3DRole[] = ['heatFlux', 'fixedTemp', 'convection', 'insulated', 'support', 'load'];

// ---------- 検査の小さな部品 ----------

function show(v: unknown): string {
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v) ?? String(v);
}

function needObj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what}が読めません（オブジェクトになっていません）`);
  return v as Record<string, unknown>;
}

function needArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what}が読めません（配列になっていません）`);
  return v;
}

function needStr(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`${what}が文字列になっていません（${show(v)}）`);
  return v;
}

function needBool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${what}が true か false になっていません（${show(v)}）`);
  return v;
}

/** 有限の数。JSON では NaN や Infinity は null などに化けるので、ここで止める */
function needNum(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what}が数ではありません（${show(v)}）`);
  return v;
}

function needPositive(v: unknown, what: string): number {
  const x = needNum(v, what);
  if (x <= 0) throw new Error(`${what}は 0 より大きい数にしてください（${x}）`);
  return x;
}

function needPositiveInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`${what}は 1 以上の整数にしてください（${show(v)}）`);
  return v;
}

function needOneOf<T extends string>(v: unknown, list: readonly T[], what: string): T {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) {
    throw new Error(`${what}が ${list.join(' / ')} のどれでもありません（${show(v)}）`);
  }
  return v as T;
}

// ---------- 型付き配列 ----------

function encodeU32(a: Uint32Array): WireU32 {
  return { $typed: 'u32', length: a.length, b64: bytesToBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) };
}

/** 型付き配列の包みを開いて、バイト列と要素数の検査までする */
function readTyped(v: unknown, type: 'f32' | 'u32' | 'u8', what: string): Uint8Array {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${what}のデータの形が違います（${type} の型付き配列になっていません）`);
  }
  const t = v as { $typed?: unknown; length?: unknown; b64?: unknown };
  if (t.$typed !== type || typeof t.b64 !== 'string' || typeof t.length !== 'number') {
    throw new Error(`${what}のデータの形が違います（${type} の型付き配列になっていません）`);
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(t.b64);
  } catch {
    throw new Error(`${what}のデータが壊れています（base64 として読めません）`);
  }
  const width = type === 'u8' ? 1 : 4;
  if (bytes.length !== t.length * width) {
    throw new Error(`${what}のデータの長さが合いません（宣言は ${t.length} 個、実際は ${bytes.length / width} 個）`);
  }
  return bytes;
}

function decodeF32Typed(v: unknown, what: string): Float32Array {
  const bytes = readTyped(v, 'f32', what);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
}

function decodeU32Typed(v: unknown, what: string): Uint32Array {
  const bytes = readTyped(v, 'u32', what);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
}

function decodeU8Typed(v: unknown, what: string): Uint8Array {
  return readTyped(v, 'u8', what);
}

// ---------- Study3D ----------

function decodeRegion(raw: unknown, n: number, triCount: number): Region3D {
  const where = `面の条件 ${n + 1} 番目`;
  const r = needObj(raw, where);
  const id = needStr(r.id, `${where}の id`);
  const name = needStr(r.name, `${where}の名前`);
  const role = needOneOf(r.role, REGION_ROLES, `${where}の種類（role）`);
  const faces = needArray(r.faces, `${where}の faces（三角形の番号）`).map((f) => {
    if (typeof f !== 'number' || !Number.isInteger(f) || f < 0) throw new Error(`${where}の faces に三角形の番号として正しくない値があります（${show(f)}）`);
    if (f >= triCount) throw new Error(`${where}の faces の番号（${f}）が三角形の数（${triCount}）を超えています`);
    return f;
  });
  const out: Region3D = { id, name, role, faces };
  if (r.heatW !== undefined) out.heatW = needNum(r.heatW, `${where}の heatW（発熱量 [W]）`);
  if (r.tempC !== undefined) out.tempC = needNum(r.tempC, `${where}の tempC（温度 [°C]）`);
  if (r.h !== undefined) out.h = needNum(r.h, `${where}の h（熱伝達率）`);
  if (r.force !== undefined) {
    const f = needObj(r.force, `${where}の force（荷重 [N]）`);
    out.force = {
      fx: needNum(f.fx, `${where}の force.fx`),
      fy: needNum(f.fy, `${where}の force.fy`),
      fz: needNum(f.fz, `${where}の force.fz`),
    };
  }
  return out;
}

/** JSON から来た値 → Study3D。壊れていたら日本語のエラーを投げる */
export function decodeStudy3D(raw: unknown): Study3D {
  const r = needObj(raw, '3D の検討（Study3D）');
  if (r.version !== 1) throw new Error(`検討データの版（version）が 1 ではありません（${show(r.version)}）。この版の Studio M では開けません`);
  const analysis = needOneOf(r.analysis, ANALYSES, '解析の種類（analysis）');

  const mesh = needObj(r.mesh, 'メッシュ（mesh）');
  const positions = decodeF32Typed(mesh.positions, '頂点の座標（positions）');
  if (positions.length % 3 !== 0) {
    throw new Error(`頂点の座標（positions）の数（${positions.length}）が 3 の倍数ではありません。x・y・z の組になっていません`);
  }
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new Error(`頂点の座標（positions）の ${i} 番目が数ではありません（NaN など）。ファイルが壊れている可能性があります`);
  }
  const indices = decodeU32Typed(mesh.indices, '三角形（indices）');
  if (indices.length % 3 !== 0) {
    throw new Error(`三角形の頂点番号（indices）の数（${indices.length}）が 3 の倍数ではありません。3 つずつで 1 つの三角形になっていません`);
  }
  const vertexCount = positions.length / 3;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vertexCount) {
      throw new Error(`三角形の頂点番号（indices）が頂点の数（${vertexCount}）を超えています（${indices[i]}）。ファイルが壊れている可能性があります`);
    }
  }
  const triCount = indices.length / 3;

  const heat = needObj(r.heat, '熱の条件（heat）');
  const heatOut: Study3D['heat'] = {
    ambientC: needNum(heat.ambientC, '周囲の温度（heat.ambientC）'),
    surfaceH: needNum(heat.surfaceH, '条件のない面の熱伝達率（heat.surfaceH）'),
  };
  if (heat.bodyHeatW !== undefined) heatOut.bodyHeatW = needNum(heat.bodyHeatW, '部品全体の発熱量（heat.bodyHeatW）');

  const stress = needObj(r.stress, '強度の条件（stress）');

  const study: Study3D = {
    version: 1,
    name: needStr(r.name, '検討の名前（name）'),
    analysis,
    mesh: { positions, indices },
    materialId: needStr(r.materialId, '材料（materialId）'),
    regions: needArray(r.regions, '面の条件（regions）').map((x, n) => decodeRegion(x, n, triCount)),
    heat: heatOut,
    stress: { selfWeight: needBool(stress.selfWeight, '自重の考慮（stress.selfWeight）') },
  };
  if (r.source !== undefined) study.source = needStr(r.source, '取り込み元（source）');
  if (r.grid !== undefined) {
    const g = needObj(r.grid, '格子の細かさ（grid）');
    const grid: NonNullable<Study3D['grid']> = {};
    if (g.cell !== undefined) grid.cell = needPositive(g.cell, '格子のセルの一辺（grid.cell）');
    if (g.maxCells !== undefined) grid.maxCells = needPositiveInt(g.maxCells, 'セル数の上限（grid.maxCells）');
    study.grid = grid;
  }
  return study;
}

/** Study3D → JSON にできる形 */
export function encodeStudy3D(study: Study3D): unknown {
  const out: Record<string, unknown> = {
    version: study.version,
    name: study.name,
    analysis: study.analysis,
    mesh: { positions: encodeF32(study.mesh.positions), indices: encodeU32(study.mesh.indices) },
    materialId: study.materialId,
    regions: study.regions,
    heat: study.heat,
    stress: study.stress,
  };
  if (study.source !== undefined) out.source = study.source;
  if (study.grid !== undefined) out.grid = study.grid;
  return out;
}

// ---------- ResultSet3D ----------

function decodeGrid3D(raw: unknown): Grid3D {
  const g = needObj(raw, '格子（grid）');
  const nx = needPositiveInt(g.nx, '格子の nx（x 方向のセル数）');
  const ny = needPositiveInt(g.ny, '格子の ny（y 方向のセル数）');
  const nz = needPositiveInt(g.nz, '格子の nz（z 方向のセル数）');
  const h = needPositive(g.h, '格子のセルの一辺（h）');
  const origin = needArray(g.origin, '格子の角（origin）');
  if (origin.length !== 3) throw new Error(`格子の角（origin）は x・y・z の 3 つの数にしてください（今は ${origin.length} 個）`);
  return {
    nx,
    ny,
    nz,
    h,
    origin: [needNum(origin[0], '格子の角 origin の x'), needNum(origin[1], '格子の角 origin の y'), needNum(origin[2], '格子の角 origin の z')],
  };
}

function decodeField3D(raw: unknown, n: number, grid: Grid3D, i: number): Field3D {
  const f = needObj(raw, `場 ${i + 1} 番目`);
  // 表示用の文字は、2D（engine-wire.ts）と同じく読めなければ空にする
  const key = typeof f.key === 'string' ? f.key : '';
  const label = typeof f.label === 'string' ? f.label : '';
  const unit = typeof f.unit === 'string' ? f.unit : '';
  const where = `「${key}」`;
  const data = decodeF32Typed(f.data, `${where}の値`);
  if (data.length !== n) {
    throw new Error(`${where}のセル数（${data.length}）が格子（${grid.nx}×${grid.ny}×${grid.nz} = ${n}）と合いません`);
  }
  if (f.mask === undefined || f.mask === null) throw new Error(`${where}の mask（部品の中かどうか）がありません`);
  const mask = decodeU8Typed(f.mask, `${where}の mask`);
  if (mask.length !== n) throw new Error(`${where}の mask の長さ（${mask.length}）が格子（${n}）と合いません`);
  const field: Field3D = { key, label, unit, data, mask };
  if (f.diverging === true) field.diverging = true;
  return field;
}

/** ResultSet3D → JSON にできる形 */
export function encodeResultSet3D(rs: ResultSet3D): unknown {
  const out: Record<string, unknown> = {
    analysis: rs.analysis,
    grid: rs.grid,
    fields: rs.fields.map((f) => {
      const w: Record<string, unknown> = { key: f.key, label: f.label, unit: f.unit, data: encodeF32(f.data), mask: encodeU8(f.mask) };
      if (f.diverging) w.diverging = true;
      return w;
    }),
    scalars: rs.scalars,
    history: rs.history,
    warnings: rs.warnings,
  };
  if (rs.label !== undefined) out.label = rs.label;
  if (rs.perRegion !== undefined) out.perRegion = rs.perRegion;
  return out;
}

/** JSON から来た値 → ResultSet3D。壊れていたら日本語のエラーを投げる */
export function decodeResultSet3D(raw: unknown): ResultSet3D {
  const r = needObj(raw, '3D の結果');
  const analysis = needOneOf(r.analysis, ANALYSES, '解析の種類（analysis）');
  const grid = decodeGrid3D(r.grid);
  const n = grid.nx * grid.ny * grid.nz;
  const fields = needArray(r.fields, '3D の結果の場（fields）').map((f, i) => decodeField3D(f, n, grid, i));
  const out: ResultSet3D = {
    analysis,
    grid,
    fields,
    scalars: decodeScalars(r.scalars),
    history: decodeHistory(r.history),
    warnings: Array.isArray(r.warnings) ? r.warnings.map((w) => (typeof w === 'string' ? w : '')) : [],
  };
  if (typeof r.label === 'string') out.label = r.label;
  if (Array.isArray(r.perRegion)) {
    out.perRegion = r.perRegion.map((p): ShapeResult => {
      const q = needObj(p, '面ごとの結果（perRegion）');
      return { shapeId: typeof q.shapeId === 'string' ? q.shapeId : '', label: typeof q.label === 'string' ? q.label : '', values: decodeScalars(q.values) };
    });
  }
  return out;
}

// ---------- ファイル（.studiom3d.json） ----------

/** Study3D → ファイルの中身（JSON の文字列） */
export function studyFileJson(study: Study3D): string {
  return JSON.stringify({ kind: STUDY3D_FILE_KIND, version: 1, study: encodeStudy3D(study) });
}

/** ファイルの中身（JSON の文字列）→ Study3D。別の種類のファイルや壊れたファイルは日本語のエラーにする */
export function parseStudyFile(text: string): Study3D {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('ファイルが JSON として読めません。.studiom3d.json の中身が壊れているか、別の種類のファイルです');
  }
  const f = needObj(raw, 'ファイルの中身');
  if (f.kind !== STUDY3D_FILE_KIND) {
    throw new Error(`このファイルは Studio M の 3D の検討ファイルではありません（kind が ${show(f.kind)}）。3D の検討は kind が "${STUDY3D_FILE_KIND}" のファイルとして保存されます`);
  }
  if (f.version !== 1) throw new Error(`ファイルの版（version）が 1 ではありません（${show(f.version)}）。新しい版の Studio M で作られたファイルかもしれません`);
  if (f.study === undefined) throw new Error('ファイルに 3D の検討のデータ（study）がありません');
  return decodeStudy3D(f.study);
}
