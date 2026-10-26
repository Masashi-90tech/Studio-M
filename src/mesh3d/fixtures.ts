// テスト用: メッシュを STL / OBJ のファイル（の中身）に書き出す。画面からは使わない。
import type { TriMesh } from './types';

/** バイナリ STL。header を "solid" で始めると、「バイナリなのに solid で始まる」ファイルになる */
export function toBinaryStl(mesh: TriMesh, header = 'binary stl'): ArrayBuffer {
  const n = mesh.indices.length / 3;
  const buf = new ArrayBuffer(84 + 50 * n);
  const view = new DataView(buf);
  for (let i = 0; i < Math.min(80, header.length); i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, n, true);
  let off = 84;
  for (let t = 0; t < n; t++) {
    off += 12; // 法線は 0 のまま
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k] * 3;
      for (let c = 0; c < 3; c++) {
        view.setFloat32(off, mesh.positions[v + c], true);
        off += 4;
      }
    }
    off += 2;
  }
  return buf;
}

export function toAsciiStl(mesh: TriMesh, name = 'test'): string {
  const lines = [`solid ${name}`];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    lines.push('  facet normal 0 0 0', '    outer loop');
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t + k] * 3;
      lines.push(`      vertex ${mesh.positions[v]} ${mesh.positions[v + 1]} ${mesh.positions[v + 2]}`);
    }
    lines.push('    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`);
  return lines.join('\n');
}

export function toObj(mesh: TriMesh): string {
  const lines = ['# test'];
  for (let v = 0; v < mesh.positions.length; v += 3) lines.push(`v ${mesh.positions[v]} ${mesh.positions[v + 1]} ${mesh.positions[v + 2]}`);
  for (let t = 0; t < mesh.indices.length; t += 3) lines.push(`f ${mesh.indices[t] + 1} ${mesh.indices[t + 1] + 1} ${mesh.indices[t + 2] + 1}`);
  return lines.join('\n');
}

/** 頂点を共有しない形（STL を読んだあとと同じ形）にする */
export function unindex(mesh: TriMesh): TriMesh {
  const positions = new Float32Array(mesh.indices.length * 3);
  for (let i = 0; i < mesh.indices.length; i++) positions.set(mesh.positions.subarray(mesh.indices[i] * 3, mesh.indices[i] * 3 + 3), i * 3);
  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

/** 三角形を 1 つ減らしたメッシュ（穴のあいた形を作る） */
export function dropTriangle(mesh: TriMesh, t: number): TriMesh {
  const idx: number[] = [];
  for (let i = 0; i < mesh.indices.length / 3; i++) if (i !== t) idx.push(mesh.indices[i * 3], mesh.indices[i * 3 + 1], mesh.indices[i * 3 + 2]);
  return { positions: mesh.positions, indices: Uint32Array.from(idx) };
}
