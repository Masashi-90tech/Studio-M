import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from './engine-wire';
import {
  decodeResultSet3D,
  decodeStudy3D,
  encodeResultSet3D,
  encodeStudy3D,
  parseStudyFile,
  STUDY3D_FILE_KIND,
  studyFileJson,
} from './study3d-io';
import type { ResultSet3D, Study3D } from './types';

// JSON を一度通す（ファイルや通信と同じ経路）
const viaJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

function sampleStudy(): Study3D {
  return {
    version: 1,
    name: 'ブラケット',
    analysis: 'heat',
    mesh: {
      positions: Float32Array.from([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0, 0, 0, 0.01]),
      indices: Uint32Array.from([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]),
    },
    materialId: 'al6061',
    source: 'bracket.stl',
    regions: [
      { id: 'r1', name: '発熱面', role: 'heatFlux', faces: [0, 1], heatW: 2 },
      { id: 'r2', name: '取付面', role: 'fixedTemp', faces: [2], tempC: 25 },
      { id: 'r3', name: 'ファン面', role: 'convection', faces: [3], h: 40 },
      { id: 'r4', name: '荷重', role: 'load', faces: [1], force: { fx: 0, fy: 0, fz: -9.8 } },
    ],
    heat: { ambientC: 25, surfaceH: 8, bodyHeatW: 0.5 },
    stress: { selfWeight: true },
    grid: { cell: 0.005, maxCells: 100000 },
  };
}

function sampleResult(): ResultSet3D {
  return {
    analysis: 'heat',
    grid: { nx: 2, ny: 2, nz: 1, h: 0.005, origin: [0, 0, 0] },
    fields: [
      { key: 'T', label: '温度', unit: '°C', data: Float32Array.from([25, 30.5, NaN, 40]), mask: Uint8Array.from([1, 1, 0, 1]), diverging: true },
      { key: 'q', label: '熱流束', unit: 'W/m²', data: Float32Array.from([0, 1, 2, 3]), mask: Uint8Array.from([1, 1, 1, 1]) },
    ],
    scalars: [
      { key: 'maxTemp', label: '最高温度', unit: '°C', value: 40 },
      { key: 'x', label: 'X', unit: '', value: NaN },
    ],
    history: [{ key: 'r', label: '残差', unit: '', t: [0, 1], values: [1, NaN] }],
    warnings: ['注意'],
    label: 'Lite',
    perRegion: [{ shapeId: 'r1', label: '発熱面', values: [{ key: 'maxTemp', label: '最高温度', unit: '°C', value: 40 }] }],
  };
}

// 壊れた入力を作るための小さな包み（engine-wire と同じ形）
const wireF32 = (a: number[]) => ({ $typed: 'f32', length: a.length, b64: bytesToBase64(new Uint8Array(Float32Array.from(a).buffer)) });
const wireU32 = (a: number[]) => ({ $typed: 'u32', length: a.length, b64: bytesToBase64(new Uint8Array(Uint32Array.from(a).buffer)) });
const wireU8 = (a: number[]) => ({ $typed: 'u8', length: a.length, b64: bytesToBase64(Uint8Array.from(a)) });

type Wire = Record<string, any>;
const studyWire = (): Wire => viaJson(encodeStudy3D(sampleStudy())) as Wire;
const resultWire = (): Wire => viaJson(encodeResultSet3D(sampleResult())) as Wire;

describe('study3d-io: Study3D', () => {
  it('往復（JSON を通しても）で元と同じ。型付き配列も型のまま戻る', () => {
    const study = sampleStudy();
    const back = decodeStudy3D(viaJson(encodeStudy3D(study)));
    expect(back).toEqual(study);
    expect(back.mesh.positions).toBeInstanceOf(Float32Array);
    expect(back.mesh.indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(back.mesh.indices)).toEqual([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]);
  });

  it('省略可能な項目は、なければ付けない（あれば残す）', () => {
    const plain: Study3D = { ...sampleStudy(), source: undefined, grid: undefined, heat: { ambientC: 25, surfaceH: 8 } };
    const back = decodeStudy3D(viaJson(encodeStudy3D(plain)));
    expect('source' in back).toBe(false);
    expect('grid' in back).toBe(false);
    expect('bodyHeatW' in back.heat).toBe(false);
    expect(back.regions[0]).toEqual({ id: 'r1', name: '発熱面', role: 'heatFlux', faces: [0, 1], heatW: 2 });
    const full = decodeStudy3D(viaJson(encodeStudy3D(sampleStudy())));
    expect(full.grid).toEqual({ cell: 0.005, maxCells: 100000 });
    expect(full.regions[3].force).toEqual({ fx: 0, fy: 0, fz: -9.8 });
  });

  it('壊れた検討は、何が悪いかが分かる日本語のエラーになる', () => {
    const cases: [string, (w: Wire) => void, RegExp][] = [
      ['version が 1 でない', (w) => { w.version = 2; }, /version.*1 ではありません/],
      ['analysis が heat / stress でない', (w) => { w.analysis = 'flow'; }, /analysis.*heat \/ stress/],
      ['indices が 3 の倍数でない', (w) => { w.mesh.indices = wireU32([0, 1, 2, 0]); }, /3 の倍数/],
      ['indices が頂点の数を超える', (w) => { w.mesh.indices = wireU32([0, 1, 2, 0, 1, 4]); }, /頂点の数（4）を超えて/],
      ['positions が 3 の倍数でない', (w) => { w.mesh.positions = wireF32([0, 0, 0, 1]); }, /positions.*3 の倍数/],
      ['positions に NaN', (w) => { w.mesh.positions = wireF32([0, 0, 0, NaN, 0, 0, 0, 0.01, 0, 0, 0, 0.01]); }, /positions.*数ではありません/],
      ['Region3D の role が不正', (w) => { w.regions[0].role = 'stress'; }, /role.*heatFlux/],
      ['faces の番号が三角形の数を超える', (w) => { w.regions[1].faces = [4]; }, /faces の番号（4）が三角形の数（4）を超えて/],
      ['faces が配列でない', (w) => { w.regions[1].faces = 2; }, /faces.*配列/],
      ['ambientC が数でない', (w) => { w.heat.ambientC = 'hot'; }, /ambientC.*数ではありません/],
      ['surfaceH が無い', (w) => { delete w.heat.surfaceH; }, /surfaceH.*数ではありません/],
      ['heatW が数でない', (w) => { w.regions[0].heatW = 'two'; }, /heatW.*数ではありません/],
      ['force の成分が欠けている', (w) => { delete w.regions[3].force.fz; }, /force\.fz.*数ではありません/],
      ['selfWeight が真偽値でない', (w) => { w.stress.selfWeight = 1; }, /selfWeight.*true か false/],
      ['indices のデータが壊れた base64', (w) => { w.mesh.indices = { $typed: 'u32', length: 3, b64: '!!!' }; }, /壊れて/],
      ['indices が型付きでない', (w) => { w.mesh.indices = [0, 1, 2]; }, /型付き配列になっていません/],
      ['indices の長さの宣言が違う', (w) => { w.mesh.indices.length = 6; }, /長さが合いません/],
    ];
    for (const [name, mutate, re] of cases) {
      const w = studyWire();
      mutate(w);
      expect(() => decodeStudy3D(w), name).toThrow(re);
    }
    expect(() => decodeStudy3D(null)).toThrow('読めません');
  });
});

describe('study3d-io: ResultSet3D', () => {
  it('往復で元と同じ。NaN を含む data も壊れない', () => {
    const rs = sampleResult();
    const back = decodeResultSet3D(viaJson(encodeResultSet3D(rs)));
    expect(back).toEqual(rs);
    const f = back.fields[0];
    expect(f.data).toBeInstanceOf(Float32Array);
    expect(Array.from(f.data.slice(0, 2))).toEqual([25, 30.5]);
    expect(Number.isNaN(f.data[2])).toBe(true);
    expect(f.mask).toBeInstanceOf(Uint8Array);
    expect(f.diverging).toBe(true);
    expect('diverging' in back.fields[1]).toBe(false);
    expect(Number.isNaN(back.scalars[1].value)).toBe(true); // JSON の null → NaN（2D と同じ）
    expect(back.label).toBe('Lite');
    expect(back.perRegion?.[0].values[0].value).toBe(40);
  });

  it('省略可能な label・perRegion は、なければ付けない', () => {
    const rs: ResultSet3D = { ...sampleResult(), label: undefined, perRegion: undefined };
    const back = decodeResultSet3D(viaJson(encodeResultSet3D(rs)));
    expect('label' in back).toBe(false);
    expect('perRegion' in back).toBe(false);
  });

  it('壊れた結果は、何が悪いかが分かる日本語のエラーになる', () => {
    const cases: [string, (w: Wire) => void, RegExp][] = [
      ['analysis が不正', (w) => { w.analysis = 'em'; }, /analysis.*heat \/ stress/],
      ['nx が整数でない', (w) => { w.grid.nx = 1.5; }, /nx.*1 以上の整数/],
      ['ny が 0', (w) => { w.grid.ny = 0; }, /ny.*1 以上の整数/],
      ['nz が文字列', (w) => { w.grid.nz = '1'; }, /nz.*1 以上の整数/],
      ['h が 0', (w) => { w.grid.h = 0; }, /h.*0 より大きい/],
      ['h が負', (w) => { w.grid.h = -0.1; }, /h.*0 より大きい/],
      ['origin が 2 つ', (w) => { w.grid.origin = [0, 0]; }, /origin.*3 つ/],
      ['origin に文字', (w) => { w.grid.origin = [0, 'a', 0]; }, /origin の y.*数ではありません/],
      ['data の長さが格子と合わない', (w) => { w.fields[0].data = wireF32([1, 2, 3]); }, /セル数（3）が格子.*と合いません/],
      ['mask の長さが格子と合わない', (w) => { w.fields[0].mask = wireU8([1, 1, 1]); }, /mask の長さ（3）が格子/],
      ['mask が無い', (w) => { delete w.fields[0].mask; }, /mask.*ありません/],
      ['data が型付きでない', (w) => { w.fields[0].data = [1, 2, 3, 4]; }, /型付き配列になっていません/],
      ['data の型が違う（u8 で来た）', (w) => { w.fields[0].data = wireU8([1, 2, 3, 4]); }, /f32 の型付き配列/],
      ['fields が配列でない', (w) => { w.fields = {}; }, /fields.*配列/],
    ];
    for (const [name, mutate, re] of cases) {
      const w = resultWire();
      mutate(w);
      expect(() => decodeResultSet3D(w), name).toThrow(re);
    }
    expect(() => decodeResultSet3D(42)).toThrow('読めません');
  });
});

describe('study3d-io: ファイル', () => {
  it('studyFileJson → parseStudyFile で元と同じ', () => {
    const text = studyFileJson(sampleStudy());
    expect(JSON.parse(text)).toMatchObject({ kind: STUDY3D_FILE_KIND, version: 1 });
    expect(parseStudyFile(text)).toEqual(sampleStudy());
  });

  it('JSON でない・別の種類・版が違う・中身がないファイルは日本語のエラー', () => {
    expect(() => parseStudyFile('{ これは JSON ではない')).toThrow(/JSON として読めません/);
    expect(() => parseStudyFile(JSON.stringify({ kind: 'other', version: 1, study: {} }))).toThrow(/kind が "other"/);
    expect(() => parseStudyFile(JSON.stringify({ version: 1, study: {} }))).toThrow(/kind が undefined/);
    const v2 = JSON.parse(studyFileJson(sampleStudy())) as Wire;
    v2.version = 2;
    expect(() => parseStudyFile(JSON.stringify(v2))).toThrow(/ファイルの版（version）が 1 ではありません/);
    expect(() => parseStudyFile(JSON.stringify({ kind: STUDY3D_FILE_KIND, version: 1 }))).toThrow(/study.*ありません/);
    expect(() => parseStudyFile('42')).toThrow(/中身/);
  });
});

describe('study3d-io: 大きなメッシュ', () => {
  it('10 万三角形を往復しても数百ミリ秒以内', () => {
    const triCount = 100_000;
    const vertexCount = 50_000;
    const positions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < positions.length; i++) positions[i] = (i % 997) * 1e-4;
    const indices = new Uint32Array(triCount * 3);
    for (let t = 0; t < triCount; t++) {
      indices[t * 3] = t % vertexCount;
      indices[t * 3 + 1] = (t * 7 + 1) % vertexCount;
      indices[t * 3 + 2] = (t * 13 + 2) % vertexCount;
    }
    const study: Study3D = { ...sampleStudy(), mesh: { positions, indices }, regions: [] };

    const t0 = performance.now();
    const text = JSON.stringify(encodeStudy3D(study));
    const back = decodeStudy3D(JSON.parse(text));
    const ms = performance.now() - t0;

    expect(ms).toBeLessThan(500);
    expect(back.mesh.indices.length).toBe(triCount * 3);
    expect(back.mesh.indices[triCount * 3 - 1]).toBe(indices[triCount * 3 - 1]);
    expect(back.mesh.positions[positions.length - 1]).toBe(positions[positions.length - 1]);
  });
});
