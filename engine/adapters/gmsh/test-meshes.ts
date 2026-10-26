// テスト用の、手で作る 2 次の三角形メッシュ（gmsh 不要）。長方形を nx × ny のセルに分け、各セルを 2 つの三角形にする。

import type { GmshMesh } from './msh';

/**
 * x ∈ [x0, x0 + w]、y ∈ [y0, y0 + h] の長方形のメッシュ。節点は辺の中点も含む（(2nx + 1) × (2ny + 1) 個）。
 * clockwise = true なら、三角形の向きを時計回りにして返す（CalculiX 用に向きを直せるかの確認用）
 */
export function stripMesh(opts: { x0?: number; y0?: number; w: number; h: number; nx: number; ny: number; clockwise?: boolean }): GmshMesh {
  const { w, h, nx, ny } = opts;
  const x0 = opts.x0 ?? 0;
  const y0 = opts.y0 ?? 0;
  const cols = 2 * nx + 1;
  const rows = 2 * ny + 1;
  const coords = new Float64Array(2 * cols * rows);
  for (let b = 0; b < rows; b++) {
    for (let a = 0; a < cols; a++) {
      const n = b * cols + a;
      coords[2 * n] = x0 + (a * w) / (2 * nx);
      coords[2 * n + 1] = y0 + (b * h) / (2 * ny);
    }
  }
  const id = (a: number, b: number): number => b * cols + a;
  const tris: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = 2 * i;
      const b = 2 * j;
      const p00 = id(a, b);
      const p10 = id(a + 2, b);
      const p11 = id(a + 2, b + 2);
      const p01 = id(a, b + 2);
      const m = (p: number, q: number): number => id((((p % cols) + (q % cols)) / 2) | 0, (((Math.floor(p / cols) + Math.floor(q / cols)) / 2) | 0));
      const t1 = [p00, p10, p11, m(p00, p10), m(p10, p11), m(p11, p00)];
      const t2 = [p00, p11, p01, m(p00, p11), m(p11, p01), m(p01, p00)];
      for (const t of [t1, t2]) {
        // 時計回りにするときは、角 2 と 3 を入れ替える（辺の中点もそれに合わせる）
        tris.push(...(opts.clockwise ? [t[0], t[2], t[1], t[5], t[4], t[3]] : t));
      }
    }
  }
  return { nodeCount: cols * rows, coords, triangleCount: tris.length / 6, triangles: Int32Array.from(tris) };
}

/** msh 2.2 の文章にする（parseMsh2 のテスト用）。物理グループなしで、三角形（種類 9）だけ書く */
export function toMsh2(mesh: GmshMesh, extra: { lineElements?: boolean } = {}): string {
  const out = ['$MeshFormat', '2.2 0 8', '$EndMeshFormat', '$Nodes', String(mesh.nodeCount)];
  for (let n = 0; n < mesh.nodeCount; n++) out.push(`${n + 1} ${mesh.coords[2 * n]} ${mesh.coords[2 * n + 1]} 0`);
  out.push('$EndNodes', '$Elements', String(mesh.triangleCount + (extra.lineElements ? 1 : 0)));
  let id = 1;
  if (extra.lineElements) out.push(`${id++} 8 2 0 1 1 2 3`);
  for (let e = 0; e < mesh.triangleCount; e++) {
    out.push(`${id++} 9 2 0 1 ${Array.from(mesh.triangles.slice(6 * e, 6 * e + 6), (n) => n + 1).join(' ')}`);
  }
  out.push('$EndElements');
  return out.join('\n') + '\n';
}
