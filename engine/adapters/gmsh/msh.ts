// gmsh のメッシュファイル（msh 形式 2.2 の ASCII。`gmsh -format msh2` で書く）を読む。
//
// gmsh の INP 出力は要素名や番号の付け方が版で変わるので使わず、節点と要素を自分で読んで .inp を書く。
// 使うのは 2 次の三角形（msh の要素の種類 9。6 節点: 角 3 つ → 辺 0-1・1-2・2-0 の中点）だけ。
// 線や点の要素は読み飛ばす。

export interface GmshMesh {
  /** 節点の数 */
  nodeCount: number;
  /** 節点 i（0 から。ファイルに現れた順）の座標は coords[2i], coords[2i + 1] [m]。z は読み飛ばす */
  coords: Float64Array;
  /** 2 次の三角形の数 */
  triangleCount: number;
  /** 三角形 e の 6 つの節点（coords の番号 0 から）が triangles[6e .. 6e + 5] に並ぶ */
  triangles: Int32Array;
}

const TRI6 = 9;

export function parseMsh2(text: string): GmshMesh {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const bad = (what: string): Error => new Error(`gmsh のメッシュファイルを読み取れませんでした（${what}）。gmsh の版が古い（または新しすぎる）可能性があります。gmsh 4 系で、もう一度試してください。`);

  // 形式の版
  const fmtAt = lines.findIndex((l) => l.trim() === '$MeshFormat');
  if (fmtAt < 0) throw bad('$MeshFormat がありません');
  const fmt = lines[fmtAt + 1]?.trim().split(/\s+/) ?? [];
  if (!/^2\./.test(fmt[0] ?? '')) throw bad(`形式 ${fmt[0] ?? '不明'} は未対応です。2.2 が必要です`);
  if (fmt[1] !== '0') throw bad('バイナリ形式は未対応です');

  // 節点
  i = lines.findIndex((l) => l.trim() === '$Nodes');
  if (i < 0) throw bad('$Nodes がありません');
  const nNodes = Number(lines[i + 1]);
  if (!Number.isInteger(nNodes) || nNodes < 0) throw bad('節点の数が読めません');
  const coords = new Float64Array(2 * nNodes);
  const indexOf = new Map<number, number>();
  for (let k = 0; k < nNodes; k++) {
    const p = (lines[i + 2 + k] ?? '').trim().split(/\s+/);
    const tag = Number(p[0]);
    const x = Number(p[1]);
    const y = Number(p[2]);
    if (p.length < 4 || !Number.isInteger(tag) || !Number.isFinite(x) || !Number.isFinite(y)) throw bad(`節点の行 ${i + 3 + k} が読めません`);
    indexOf.set(tag, k);
    coords[2 * k] = x;
    coords[2 * k + 1] = y;
  }

  // 要素
  const e0 = lines.findIndex((l) => l.trim() === '$Elements');
  if (e0 < 0) throw bad('$Elements がありません');
  const nElem = Number(lines[e0 + 1]);
  if (!Number.isInteger(nElem) || nElem < 0) throw bad('要素の数が読めません');
  const tris: number[] = [];
  for (let k = 0; k < nElem; k++) {
    const p = (lines[e0 + 2 + k] ?? '').trim().split(/\s+/);
    if (Number(p[1]) !== TRI6) continue;
    const nTags = Number(p[2]);
    const start = 3 + nTags;
    if (!Number.isInteger(nTags) || p.length < start + 6) throw bad(`要素の行 ${e0 + 3 + k} が読めません`);
    for (let a = 0; a < 6; a++) {
      const n = indexOf.get(Number(p[start + a]));
      if (n === undefined) throw bad(`要素の行 ${e0 + 3 + k} に、ない節点があります`);
      tris.push(n);
    }
  }
  return { nodeCount: nNodes, coords, triangleCount: tris.length / 6, triangles: Int32Array.from(tris) };
}
