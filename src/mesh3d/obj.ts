// Wavefront OBJ の読み取り（頂点 v と面 f だけ。法線・テクスチャ・材料は使わない）。DOM に依存しない。
//
// - 面は 3 頂点以上。4 頂点以上の面は、最初の頂点を中心にした扇形で三角形に分ける（凸の面を想定）
// - `f 1/2/3`、`f 1//3`、負のインデックス（直前の頂点からの相対）にも対応
import { MAX_TRIANGLES, MeshParseError, type TriMesh } from './types';

const isBlank = (code: number): boolean => code === 0x20 || code === 0x09;

export function parseObj(text: string): TriMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  let vertexCount = 0;
  const lines = text.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    let line = lines[ln];
    // 行末の \ は次の行へ続く
    while (line.trimEnd().endsWith('\\') && ln + 1 < lines.length) line = line.trimEnd().slice(0, -1) + ' ' + lines[++ln];
    const hash = line.indexOf('#');
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (line === '') continue;
    const c0 = line.charCodeAt(0);
    // v（頂点）: "v x y z [w]" または "v x y z r g b"。vt / vn は読み飛ばす
    if (c0 === 0x76 /* v */ && isBlank(line.charCodeAt(1))) {
      const t = line.split(/\s+/);
      const x = Number(t[1]);
      const y = Number(t[2]);
      const z = Number(t[3]);
      if (t.length < 4 || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new MeshParseError(`OBJ の ${ln + 1} 行目の頂点を読めません（「${line.slice(0, 40)}」）。v に x y z の 3 つの数が必要です。`);
      }
      pos.push(x, y, z);
      vertexCount++;
    } else if (c0 === 0x66 /* f */ && isBlank(line.charCodeAt(1))) {
      const t = line.split(/\s+/);
      if (t.length < 4) throw new MeshParseError(`OBJ の ${ln + 1} 行目の面の頂点が 3 個未満です（「${line.slice(0, 40)}」）。`);
      const ids: number[] = [];
      for (let k = 1; k < t.length; k++) {
        const head = t[k].split('/')[0];
        const raw = Number(head);
        if (head === '' || !Number.isInteger(raw) || raw === 0) {
          throw new MeshParseError(`OBJ の ${ln + 1} 行目の面の頂点番号「${t[k]}」を読めません。`);
        }
        const id = raw > 0 ? raw - 1 : vertexCount + raw;
        if (id < 0 || id >= vertexCount) {
          throw new MeshParseError(`OBJ の ${ln + 1} 行目の面が、存在しない頂点（${raw} 番）を指しています。頂点の定義（v の行）が面より前にあるか確かめてください。`);
        }
        ids.push(id);
      }
      for (let k = 1; k + 1 < ids.length; k++) idx.push(ids[0], ids[k], ids[k + 1]);
      if (idx.length / 3 > MAX_TRIANGLES) {
        throw new MeshParseError(`三角形が多すぎて開けません（上限 ${MAX_TRIANGLES.toLocaleString('ja-JP')} 個）。三角形を減らして書き出し直してください。`);
      }
    }
  }
  if (vertexCount === 0) throw new MeshParseError('OBJ に頂点（v の行）が見つかりません。OBJ ファイルではないか、中身が空です。');
  if (idx.length === 0) {
    throw new MeshParseError('OBJ に面（f の行）が見つかりません。点や線だけで、面（サーフェス）がありません。Blender では「面」を含めて書き出してください。');
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}
