import { parseMsh2 } from './msh';
import { stripMesh, toMsh2 } from './test-meshes';

describe('parseMsh2', () => {
  it('節点と 2 次の三角形を読む（線の要素は読み飛ばす）', () => {
    const src = stripMesh({ w: 0.2, h: 0.1, nx: 2, ny: 1 });
    const mesh = parseMsh2(toMsh2(src, { lineElements: true }));
    expect(mesh.nodeCount).toBe(src.nodeCount);
    expect(mesh.triangleCount).toBe(4);
    expect(Array.from(mesh.triangles)).toEqual(Array.from(src.triangles));
    expect(Array.from(mesh.coords)).toEqual(Array.from(src.coords));
  });

  it('節点の番号が飛んでいても、要素は座標の添字に直して読む', () => {
    const text = [
      '$MeshFormat', '2.2 0 8', '$EndMeshFormat',
      '$Nodes', '6',
      '10 0 0 0', '20 1 0 0', '30 0 1 0', '40 0.5 0 0', '50 0.5 0.5 0', '60 0 0.5 0',
      '$EndNodes',
      '$Elements', '1',
      '7 9 2 3 4 10 20 30 40 50 60',
      '$EndElements',
    ].join('\r\n');
    const mesh = parseMsh2(text);
    expect(Array.from(mesh.triangles)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(mesh.coords[2 * 4]).toBe(0.5);
    expect(mesh.coords[2 * 4 + 1]).toBe(0.5);
  });

  it('読めない形式は、日本語のエラー（版が違う・バイナリ・節点がない要素）', () => {
    const ok = toMsh2(stripMesh({ w: 1, h: 1, nx: 1, ny: 1 }));
    expect(() => parseMsh2(ok.replace('2.2 0 8', '4.1 0 8'))).toThrow('2.2 が必要');
    expect(() => parseMsh2(ok.replace('2.2 0 8', '2.2 1 8'))).toThrow('バイナリ');
    expect(() => parseMsh2('hello')).toThrow('gmsh のメッシュファイルを読み取れませんでした');
    expect(() => parseMsh2(ok.replace(/^1 9 2 0 1 .*$/m, '1 9 2 0 1 1 2 3 4 5 999'))).toThrow('ない節点');
  });
});
