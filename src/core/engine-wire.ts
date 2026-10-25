// Studio M Engine との通信で JSON に載せるときの形。ブラウザとエンジンの両方がこのファイルを共有する。
//
// ResultSet の場（Field.data は Float32Array、mask は Uint8Array）は、そのままでは JSON にならない。
// 通信では { "$typed": "f32" | "u8", length, b64 } に直し、受け取った側で元の型に戻す。
// （数値の配列にするより 3 分の 1 ほど小さく、NaN も壊れない）
import type { EngineStatus, JobState } from './engine-protocol';
import type { Field, History, ResultSet, ScalarValue, ShapeResult } from './types';

/** GET /status の返事。合言葉がないとき（または違うとき）は authorized が false で、エンジンの一覧は空 */
export type EngineStatusResponse = EngineStatus & { authorized: boolean };

interface WireTyped {
  $typed: 'f32' | 'u8';
  length: number;
  b64: string;
}

// ---------- base64 ----------

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- 配列 ----------

function encodeF32(a: Float32Array): WireTyped {
  return { $typed: 'f32', length: a.length, b64: bytesToBase64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) };
}

function encodeU8(a: Uint8Array): WireTyped {
  return { $typed: 'u8', length: a.length, b64: bytesToBase64(a) };
}

function isWireTyped(v: unknown, type: 'f32' | 'u8'): v is WireTyped {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Partial<WireTyped>;
  return t.$typed === type && typeof t.b64 === 'string' && typeof t.length === 'number';
}

function decodeF32(v: unknown, what: string): Float32Array {
  if (isWireTyped(v, 'f32')) {
    const bytes = base64ToBytes(v.b64);
    if (bytes.length !== v.length * 4) throw new Error(`${what}のデータの長さが合いません`);
    return new Float32Array(bytes.buffer, 0, v.length);
  }
  if (Array.isArray(v)) return Float32Array.from(v.map((x) => (typeof x === 'number' ? x : NaN)));
  throw new Error(`${what}のデータが読めません`);
}

function decodeU8(v: unknown, what: string): Uint8Array {
  if (isWireTyped(v, 'u8')) {
    const bytes = base64ToBytes(v.b64);
    if (bytes.length !== v.length) throw new Error(`${what}のデータの長さが合いません`);
    return bytes;
  }
  if (Array.isArray(v)) return Uint8Array.from(v.map((x) => (x ? 1 : 0)));
  throw new Error(`${what}のデータが読めません`);
}

// ---------- ResultSet ----------

/** ResultSet → JSON にできる形 */
export function encodeResultSet(rs: ResultSet): unknown {
  return {
    ...rs,
    fields: rs.fields.map((f) => ({ ...f, data: encodeF32(f.data), mask: f.mask ? encodeU8(f.mask) : undefined })),
  };
}

const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function decodeScalars(raw: unknown): ScalarValue[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s: Record<string, unknown>) => ({ key: str(s.key), label: str(s.label), unit: str(s.unit), value: num(s.value) }));
}

function decodeHistory(raw: unknown): History[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x: Record<string, unknown>) => ({
    key: str(x.key),
    label: str(x.label),
    unit: str(x.unit),
    t: Array.isArray(x.t) ? x.t.map(num) : [],
    values: Array.isArray(x.values) ? x.values.map(num) : [],
  }));
}

/** JSON から来た値 → ResultSet。壊れていたら日本語のエラーを投げる */
export function decodeResultSet(raw: unknown): ResultSet {
  if (typeof raw !== 'object' || raw === null) throw new Error('エンジンの結果が読めません');
  const r = raw as Record<string, unknown>;
  const nx = r.nx;
  const ny = r.ny;
  if (typeof nx !== 'number' || typeof ny !== 'number' || !Number.isInteger(nx) || !Number.isInteger(ny) || nx < 1 || ny < 1) {
    throw new Error('エンジンの結果の格子の大きさが読めません');
  }
  if (!Array.isArray(r.fields)) throw new Error('エンジンの結果に場（fields）がありません');
  const fields: Field[] = r.fields.map((f: Record<string, unknown>) => {
    const key = str(f.key);
    const data = decodeF32(f.data, `「${key}」`);
    if (data.length !== nx * ny) throw new Error(`「${key}」のセル数（${data.length}）が格子（${nx}×${ny}）と合いません`);
    const field: Field = { key, label: str(f.label), unit: str(f.unit), data };
    if (f.mask !== undefined && f.mask !== null) {
      field.mask = decodeU8(f.mask, `「${key}」の mask`);
      if (field.mask.length !== nx * ny) throw new Error(`「${key}」の mask の長さが格子と合いません`);
    }
    if (f.diverging === true) field.diverging = true;
    return field;
  });
  const out: ResultSet = {
    analysis: r.analysis as ResultSet['analysis'],
    nx,
    ny,
    h: num(r.h),
    fields,
    scalars: decodeScalars(r.scalars),
    history: decodeHistory(r.history),
    warnings: Array.isArray(r.warnings) ? r.warnings.map(str) : [],
  };
  if (typeof r.label === 'string') out.label = r.label;
  if (Array.isArray(r.perShape)) {
    out.perShape = r.perShape.map((p: Record<string, unknown>): ShapeResult => ({ shapeId: str(p.shapeId), label: str(p.label), values: decodeScalars(p.values) }));
  }
  return out;
}

// ---------- JobState ----------

/** JobState → JSON にできる形（result だけ変換する） */
export function encodeJobState(job: JobState): unknown {
  return job.result ? { ...job, result: encodeResultSet(job.result) } : job;
}

/** JSON から来た値 → JobState */
export function decodeJobState(raw: unknown): JobState {
  if (typeof raw !== 'object' || raw === null) throw new Error('エンジンの返事が読めません');
  const j = raw as Record<string, unknown> & JobState;
  if (typeof j.id !== 'string' || typeof j.status !== 'string') throw new Error('エンジンの返事の形が違います（版が合っていない可能性があります）');
  const state: JobState = { ...j, log: Array.isArray(j.log) ? j.log.map(String) : [] };
  if (j.result) state.result = decodeResultSet(j.result);
  else delete state.result;
  return state;
}
