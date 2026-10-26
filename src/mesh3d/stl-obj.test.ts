import { describe, expect, it } from 'vitest';
import { dropTriangle, toAsciiStl, toBinaryStl, toObj, unindex } from './fixtures';
import { formatOf, parseMeshFile } from './load';
import { cleanMesh, meshBounds } from './mesh';
import { parseObj } from './obj';
import { boxMesh } from './primitives';
import { parseAsciiStl, parseBinaryStl, parseStl } from './stl';
import { MeshParseError } from './types';

const cube = boxMesh(10, 10, 10);

describe('STL の読み取り', () => {
  it('バイナリ STL を読める（三角形 12 個）', () => {
    const m = parseStl(toBinaryStl(cube));
    expect(m.indices.length / 3).toBe(12);
    expect(m.positions.length).toBe(12 * 9);
    expect(meshBounds(m)).toEqual({ min: [0, 0, 0], max: [10, 10, 10] });
  });

  it('ASCII STL を読める。バイナリと同じ結果になる', () => {
    const a = parseStl(new TextEncoder().encode(toAsciiStl(cube)));
    const b = parseStl(toBinaryStl(cube));
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });

  it('バイナリなのに見出しが "solid" で始まるファイルも、サイズで判別して読める', () => {
    const m = parseStl(toBinaryStl(cube, 'solid exported by some CAD'));
    expect(m.indices.length / 3).toBe(12);
  });

  it('ASCII の途中の "solid" の語や大文字・インデントがあっても読める', () => {
    const text = '  SOLID cube\n' + toAsciiStl(cube).split('\n').slice(1).join('\n').replace(/vertex/g, 'VERTEX');
    expect(parseStl(new TextEncoder().encode(text)).indices.length / 3).toBe(12);
  });

  it('末尾に余分なバイトがあるバイナリも読める', () => {
    const src = new Uint8Array(toBinaryStl(cube));
    const padded = new Uint8Array(src.length + 7);
    padded.set(src);
    expect(parseStl(padded).indices.length / 3).toBe(12);
  });

  it('途中で切れたバイナリは、何が悪いか分かるエラーにする', () => {
    const src = new Uint8Array(toBinaryStl(cube)).subarray(0, 84 + 50 * 5 + 10);
    expect(() => parseStl(src)).toThrow(MeshParseError);
    expect(() => parseStl(src)).toThrow(/途中で切れています/);
  });

  it('空・短すぎる・STL でないファイルはエラー', () => {
    expect(() => parseStl(new Uint8Array(0))).toThrow(/空/);
    expect(() => parseBinaryStl(new Uint8Array(10))).toThrow(/短すぎ/);
    expect(() => parseAsciiStl('solid x\nendsolid x')).toThrow(/三角形/);
    expect(() => parseAsciiStl('solid x\nvertex 1 2 3\nvertex 4 5 6\nendsolid')).toThrow(/3 の倍数/);
    expect(() => parseAsciiStl('solid x\nvertex 1 a 3\nvertex 4 5 6\nvertex 7 8 9')).toThrow(/数として読めません/);
  });

  it('頂点が重ならない形（STL）でも、整理すると 8 頂点・12 三角形に戻る', () => {
    const m = parseStl(toBinaryStl(cube));
    expect(m.positions.length / 3).toBe(36);
    const c = cleanMesh(m);
    expect(c.mesh.positions.length / 3).toBe(8);
    expect(c.mesh.indices.length / 3).toBe(12);
    expect(c.report.mergedVertices).toBe(28);
  });
});

describe('OBJ の読み取り', () => {
  it('v / f を読める', () => {
    const m = parseObj(toObj(cube));
    expect(m.positions.length / 3).toBe(8);
    expect(m.indices.length / 3).toBe(12);
  });

  it('四角形・多角形は扇形に三角形に分ける', () => {
    const quad = parseObj('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4');
    expect(Array.from(quad.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    const penta = parseObj('v 0 0 0\nv 1 0 0\nv 2 1 0\nv 1 2 0\nv 0 1 0\nf 1 2 3 4 5');
    expect(penta.indices.length / 3).toBe(3);
  });

  it('f 1/2/3 と f 1//3 の形、コメント、CRLF、行の継続に対応する', () => {
    const text = ['# comment', 'v 0 0 0 # 末尾コメント', 'v 1 0 0', 'v 0 1 0', 'vt 0 0', 'vn 0 0 1', 'o part', 'usemtl m', 'f 1/1/1 2/2/1 3/3/1', 'f 1//1 2//1 \\', ' 3//1', ''].join('\r\n');
    const m = parseObj(text);
    expect(m.positions.length / 3).toBe(3);
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('頂点の色（v x y z r g b）や w があっても読める', () => {
    const m = parseObj('v 0 0 0 1 0 0\nv 1 0 0 0 1 0\nv 0 1 0 0 0 1\nf 1 2 3');
    expect(m.positions.length).toBe(9);
  });

  it('負のインデックス（直前からの相対）に対応する', () => {
    const m = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\nv 0 0 1\nf -1 -2 -4');
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 3, 2, 0]);
  });

  it('不正な OBJ は、行番号つきの日本語のエラーにする', () => {
    expect(() => parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9')).toThrow(/4 行目.*存在しない頂点/);
    expect(() => parseObj('v 0 0 0\nv 1 0\nf 1 1 1')).toThrow(/2 行目の頂点/);
    expect(() => parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2')).toThrow(/4 行目.*3 個未満/);
    expect(() => parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 1 2')).toThrow(/頂点番号/);
    expect(() => parseObj('# nothing')).toThrow(/頂点/);
    expect(() => parseObj('v 0 0 0\nv 1 0 0')).toThrow(/面/);
  });
});

describe('ファイルの振り分け', () => {
  it('拡張子で STL / OBJ を見分ける', () => {
    expect(formatOf('a.STL')).toBe('stl');
    expect(formatOf('dir/a.b.obj')).toBe('obj');
    expect(formatOf('a.step')).toBeUndefined();
    expect(parseMeshFile('cube.stl', toBinaryStl(cube)).indices.length / 3).toBe(12);
    expect(parseMeshFile('cube.obj', new TextEncoder().encode(toObj(cube))).indices.length / 3).toBe(12);
  });

  it('拡張子が違っても、中身から見分ける', () => {
    expect(parseMeshFile('cube.txt', new TextEncoder().encode(toAsciiStl(cube))).indices.length / 3).toBe(12);
    expect(parseMeshFile('cube', new TextEncoder().encode(toObj(cube))).indices.length / 3).toBe(12);
  });

  it('対応していない形式は、書き出し方を案内するエラー', () => {
    expect(() => parseMeshFile('part.step', new Uint8Array([1, 2, 3]))).toThrow(/STL.*OBJ/);
    expect(() => parseMeshFile('part.glb', new Uint8Array([1, 2, 3]))).toThrow(/\.glb/);
  });

  it('dropTriangle / unindex の試験体の道具', () => {
    expect(dropTriangle(cube, 0).indices.length / 3).toBe(11);
    expect(unindex(cube).positions.length / 3).toBe(36);
  });
});
