import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_URL, ENGINE_CONFIG_KEY, hasSavedEngineToken, loadEngineConfig, normalizeEngineUrl, saveEngineConfig } from './engine-config';

function memory(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe('engine-config', () => {
  it('URL を整える', () => {
    expect(normalizeEngineUrl('127.0.0.1:47800')).toBe('http://127.0.0.1:47800');
    expect(normalizeEngineUrl(' http://localhost:5000/path/ ')).toBe('http://localhost:5000');
    expect(normalizeEngineUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeEngineUrl('ftp://x')).toBeNull();
    expect(normalizeEngineUrl('')).toBeNull();
    expect(normalizeEngineUrl('http://')).toBeNull();
  });
  it('保存と読み込み。壊れた保存・保存できない環境でも既定値で動く', () => {
    const st = memory();
    expect(loadEngineConfig(st)).toEqual({ url: DEFAULT_ENGINE_URL, token: '' });
    expect(hasSavedEngineToken(st)).toBe(false);
    expect(saveEngineConfig({ url: 'http://127.0.0.1:5000', token: 'abc' }, st)).toBe(true);
    expect(loadEngineConfig(st)).toEqual({ url: 'http://127.0.0.1:5000', token: 'abc' });
    expect(hasSavedEngineToken(st)).toBe(true);
    expect(loadEngineConfig(memory({ [ENGINE_CONFIG_KEY]: '{broken' }))).toEqual({ url: DEFAULT_ENGINE_URL, token: '' });
    expect(loadEngineConfig(memory({ [ENGINE_CONFIG_KEY]: JSON.stringify({ url: 'ftp://x', token: 5 }) }))).toEqual({ url: DEFAULT_ENGINE_URL, token: '' });
    expect(loadEngineConfig(null)).toEqual({ url: DEFAULT_ENGINE_URL, token: '' });
    expect(saveEngineConfig({ url: 'x', token: 'y' }, null)).toBe(false);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined };
    expect(loadEngineConfig(throwing)).toEqual({ url: DEFAULT_ENGINE_URL, token: '' });
    expect(saveEngineConfig({ url: 'x', token: 'y' }, throwing)).toBe(false);
  });
});
