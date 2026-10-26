// STL（バイナリ / ASCII）の読み取り。DOM に依存しない。
//
// 判別: バイナリ STL は「80 バイトの見出し + 三角形数（4 バイト）+ 50 バイト × 三角形数」というサイズになる。
// 見出しが "solid" で始まるバイナリ（一部の CAD の出力）があるので、先頭の文字ではなくサイズで見分ける。
// STL は三角形ごとに頂点を持つので、読み取った直後は同じ位置の頂点が重なっている（mesh.ts の cleanMesh で統合する）。
import { MAX_TRIANGLES, MeshParseError, type TriMesh } from './types';

const HEADER = 80;
const RECORD = 50;

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** バイナリ STL のサイズ条件を満たすか（三角形数を返す。満たさなければ -1） */
function binaryTriangleCount(bytes: Uint8Array): number {
  if (bytes.byteLength < HEADER + 4) return -1;
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(HEADER, true);
  return bytes.byteLength === HEADER + 4 + RECORD * n ? n : -1;
}

/** 先頭が "solid" で、ASCII の STL らしい語（facet / vertex）を含むか */
function looksAscii(bytes: Uint8Array): boolean {
  let i = 0;
  // 空白と BOM を読み飛ばす
  while (i < bytes.length && [0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf].includes(bytes[i])) i++;
  const head = String.fromCharCode(...bytes.subarray(i, i + 5)).toLowerCase();
  if (head !== 'solid') return false;
  const probe = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4096))).toLowerCase();
  return probe.includes('facet') || probe.includes('vertex') || probe.includes('endsolid');
}

export function parseBinaryStl(data: ArrayBuffer | Uint8Array): TriMesh {
  const bytes = toBytes(data);
  if (bytes.byteLength < HEADER + 4) throw new MeshParseError('STL ファイルが短すぎます。ファイルが壊れているか、STL ではありません。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(HEADER, true);
  const have = Math.floor((bytes.byteLength - HEADER - 4) / RECORD);
  if (n > MAX_TRIANGLES) {
    throw new MeshParseError(
      `三角形が ${n.toLocaleString('ja-JP')} 個あり、多すぎて開けません（上限 ${MAX_TRIANGLES.toLocaleString('ja-JP')} 個）。CAD や Blender で三角形を減らして書き出し直してください。`,
    );
  }
  if (have < n) {
    throw new MeshParseError(`STL ファイルが途中で切れています（三角形 ${n} 個のはずですが ${have} 個分しかありません）。ダウンロードや書き出しをやり直してください。`);
  }
  const positions = new Float32Array(n * 9);
  let off = HEADER + 4;
  for (let t = 0; t < n; t++) {
    off += 12; // 法線は使わない（頂点の並びから決まる）
    for (let k = 0; k < 9; k++) {
      positions[t * 9 + k] = view.getFloat32(off, true);
      off += 4;
    }
    off += 2; // 属性バイト
  }
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new MeshParseError('STL ファイルに数値でない座標があります。ファイルが壊れているか、STL ではありません。');
  }
  const indices = new Uint32Array(n * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

export function parseAsciiStl(text: string): TriMesh {
  const out: number[] = [];
  const re = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    const z = Number(m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new MeshParseError(`ASCII STL の座標を数として読めません（「${m[0].slice(0, 40)}」）。ファイルが壊れていないか確かめてください。`);
    }
    out.push(x, y, z);
    if (out.length / 9 > MAX_TRIANGLES) {
      throw new MeshParseError(`三角形が多すぎて開けません（上限 ${MAX_TRIANGLES.toLocaleString('ja-JP')} 個）。三角形を減らして書き出し直してください。`);
    }
  }
  if (out.length === 0) throw new MeshParseError('ASCII STL に三角形（vertex の行）が見つかりません。STL ファイルではないか、中身が空です。');
  if (out.length % 9 !== 0) {
    throw new MeshParseError(`ASCII STL の頂点の数（${out.length / 3} 個）が 3 の倍数ではありません。ファイルが途中で切れている可能性があります。`);
  }
  const positions = Float32Array.from(out);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

/** STL を読む。バイナリか ASCII かは自動で見分ける */
export function parseStl(data: ArrayBuffer | Uint8Array): TriMesh {
  const bytes = toBytes(data);
  if (bytes.byteLength === 0) throw new MeshParseError('ファイルが空です。');
  if (binaryTriangleCount(bytes) >= 0) return parseBinaryStl(bytes);
  if (looksAscii(bytes)) return parseAsciiStl(new TextDecoder('utf-8').decode(bytes));
  // サイズが合わず、ASCII にも見えない: 末尾に余分なバイトのあるバイナリか、壊れたファイル
  if (bytes.byteLength >= HEADER + 4) {
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(HEADER, true);
    if (n > 0 && bytes.byteLength > HEADER + 4 + RECORD * n) return parseBinaryStl(bytes.subarray(0, HEADER + 4 + RECORD * n));
    return parseBinaryStl(bytes); // 短いときは、切れていることを知らせるエラーになる
  }
  throw new MeshParseError('STL ファイルとして読めません。STL（.stl）か OBJ（.obj）のファイルを選んでください。');
}
