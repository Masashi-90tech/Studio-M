import { describe, expect, it } from 'vitest';
import type { JobState } from './engine-protocol';
import { base64ToBytes, bytesToBase64, decodeJobState, decodeResultSet, encodeJobState, encodeResultSet } from './engine-wire';
import type { ResultSet } from './types';

function sample(): ResultSet {
  const data = Float32Array.from([0, 1.5, -2, NaN, 1e30, 3.25]);
  return {
    analysis: 'stress',
    nx: 3,
    ny: 2,
    h: 0.01,
    fields: [{ key: 'u', label: '変位', unit: 'm', data, mask: Uint8Array.from([1, 1, 0, 1, 1, 1]), diverging: true }],
    scalars: [{ key: 'a', label: 'A', unit: 'Pa', value: 12.5 }, { key: 'b', label: 'B', unit: '', value: NaN }],
    history: [{ key: 'r', label: '残差', unit: '', t: [0, 1], values: [1, NaN] }],
    warnings: ['注意'],
    perShape: [{ shapeId: 's1', label: '部品', values: [{ key: 'm', label: 'M', unit: '°C', value: 40 }] }],
    label: 'テスト',
  };
}

describe('engine-wire', () => {
  it('base64 の往復（大きい配列でも）', () => {
    const b = Uint8Array.from({ length: 100_000 }, (_, i) => i % 251);
    expect(Array.from(base64ToBytes(bytesToBase64(b)))).toEqual(Array.from(b));
  });

  it('ResultSet は JSON を通しても型つき配列と NaN が戻る', () => {
    const back = decodeResultSet(JSON.parse(JSON.stringify(encodeResultSet(sample()))));
    const f = back.fields[0];
    expect(f.data).toBeInstanceOf(Float32Array);
    expect(Array.from(f.data.slice(0, 3))).toEqual([0, 1.5, -2]);
    expect(Number.isNaN(f.data[3])).toBe(true);
    expect(Array.from(f.data.slice(4))).toEqual([Math.fround(1e30), 3.25]);
    expect(f.mask).toBeInstanceOf(Uint8Array);
    expect(Array.from(f.mask ?? [])).toEqual([1, 1, 0, 1, 1, 1]);
    expect(f.diverging).toBe(true);
    expect(back.scalars[0].value).toBe(12.5);
    expect(Number.isNaN(back.scalars[1].value)).toBe(true); // JSON の null → NaN
    expect(Number.isNaN(back.history[0].values[1])).toBe(true);
    expect(back.perShape?.[0].values[0].value).toBe(40);
    expect(back.label).toBe('テスト');
    expect(back.warnings).toEqual(['注意']);
  });

  it('壊れた結果は日本語のエラー', () => {
    const wire = JSON.parse(JSON.stringify(encodeResultSet(sample()))) as { fields: { data: { length: number } }[]; nx: number };
    wire.fields[0].data.length = 5;
    expect(() => decodeResultSet(wire)).toThrow(/長さ|合いません/);
    expect(() => decodeResultSet(null)).toThrow('読めません');
    expect(() => decodeResultSet({ nx: 0, ny: 1 })).toThrow('格子');
    wire.fields[0].data.length = 6;
    wire.nx = 7;
    expect(() => decodeResultSet(wire)).toThrow('格子');
  });

  it('JobState の往復。result がなければそのまま', () => {
    const base: JobState = { id: 'a', analysis: 'stress', engine: 'calculix', status: 'done', progress: 1, message: '', log: ['x'], startedAt: 1, result: sample() };
    const back = decodeJobState(JSON.parse(JSON.stringify(encodeJobState(base))));
    expect(back.result?.fields[0].data).toBeInstanceOf(Float32Array);
    const running = decodeJobState(JSON.parse(JSON.stringify({ ...base, status: 'running', result: undefined })));
    expect(running.result).toBeUndefined();
    expect(() => decodeJobState({ foo: 1 })).toThrow('形が違います');
  });
});
