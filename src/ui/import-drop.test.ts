import { describe, expect, it } from 'vitest';
import { DROP_ERROR_MESSAGE, pickImportFile } from './import-drop';
import { pickMeshFile } from './mesh-open';

describe('3D モデルのドロップの選択', () => {
  it('.stl と .obj を選ぶ（大文字小文字は問わない）', () => {
    expect(pickMeshFile([{ name: 'a.json' }, { name: 'Part.STL' }])).toEqual({ name: 'Part.STL' });
    expect(pickMeshFile([{ name: 'cube.obj' }])).toEqual({ name: 'cube.obj' });
    expect(pickMeshFile([{ name: 'a.step' }, { name: 'b.glb' }, { name: 'c.stl.txt' }])).toBeUndefined();
    expect(pickMeshFile([])).toBeUndefined();
  });
});

describe('ドロップされたファイルの振り分け', () => {
  it('拡張子で KiCad 基板と 3D モデルを見分ける', () => {
    expect(pickImportFile([{ name: 'board.kicad_pcb' }])).toEqual({ kind: 'kicad', file: { name: 'board.kicad_pcb' } });
    expect(pickImportFile([{ name: 'bracket.stl' }])).toEqual({ kind: 'mesh', file: { name: 'bracket.stl' } });
    expect(pickImportFile([{ name: 'bracket.OBJ' }])).toEqual({ kind: 'mesh', file: { name: 'bracket.OBJ' } });
  });
  it('両方あるときは KiCad 基板を優先する。どちらもなければ undefined', () => {
    expect(pickImportFile([{ name: 'a.stl' }, { name: 'b.kicad_pcb' }])?.kind).toBe('kicad');
    expect(pickImportFile([{ name: 'a.json' }, { name: 'b.png' }])).toBeUndefined();
    expect(pickImportFile([])).toBeUndefined();
  });
  it('置けないときの案内は、置けるものと、プロジェクトの開き方を書く', () => {
    expect(DROP_ERROR_MESSAGE).toMatch(/\.kicad_pcb/);
    expect(DROP_ERROR_MESSAGE).toMatch(/\.stl/);
    expect(DROP_ERROR_MESSAGE).toMatch(/\.obj/);
    expect(DROP_ERROR_MESSAGE).toMatch(/「ファイル」→「開く」/);
  });
});
