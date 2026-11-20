import { describe, expect, it } from 'vitest';
import { checkEngineRequest } from './request-guard';

const ok = (method: string, path: string, body?: unknown): boolean => checkEngineRequest({ method, path, body }).ok;

describe('request-guard: 許可する形', () => {
  it('5 つの宛先を通す', () => {
    expect(ok('GET', '/status')).toBe(true);
    expect(ok('GET', '/status?refresh=1')).toBe(true);
    expect(ok('POST', '/jobs', { a: 1 })).toBe(true);
    expect(ok('GET', '/jobs/abc123_-X')).toBe(true);
    expect(ok('POST', '/jobs/abc123/cancel')).toBe(true);
    expect(ok('GET', '/jobs/abc123/files/out.txt')).toBe(true);
    expect(ok('GET', '/jobs/abc123/files/sub/out.frd')).toBe(true);
    expect(ok('GET', `/jobs/abc123/files/${encodeURIComponent('結果.csv')}`)).toBe(true);
  });
});

describe('request-guard: 拒否する形', () => {
  it('別のメソッド・宛先', () => {
    expect(ok('DELETE', '/jobs/abc')).toBe(false);
    expect(ok('PUT', '/jobs', {})).toBe(false);
    expect(ok('POST', '/status')).toBe(false);
    expect(ok('GET', '/jobs')).toBe(false);
    expect(ok('GET', '/jobs/abc/cancel')).toBe(false);
    expect(ok('POST', '/jobs/abc')).toBe(false);
    expect(ok('GET', '/')).toBe(false);
    expect(ok('GET', '/etc/passwd')).toBe(false);
    expect(ok('GET', '/jobs/abc/other')).toBe(false);
  });
  it('「..」とそのエンコード', () => {
    expect(ok('GET', '/jobs/x/files/../../etc')).toBe(false);
    expect(ok('GET', '/jobs/x/files/..')).toBe(false);
    expect(ok('GET', '/jobs/../status')).toBe(false);
    expect(ok('GET', '/jobs/x/files/%2e%2e/%2e%2e/etc')).toBe(false);
    expect(ok('GET', '/jobs/x/files/%2E%2E%2Fsecret')).toBe(false);
    expect(ok('GET', '/jobs/x/files/a%5cb')).toBe(false);
    expect(ok('GET', '/jobs/x/files/a%00')).toBe(false);
  });
  it('別のホストを匂わせる文字・クエリ', () => {
    expect(ok('GET', '//evil.example/status')).toBe(false);
    expect(ok('GET', 'http://evil.example/status')).toBe(false);
    expect(ok('GET', '/status@evil.example')).toBe(false);
    expect(ok('GET', '/status?refresh=1&x=1')).toBe(false);
    expect(ok('GET', '/status?refresh=0')).toBe(false);
    expect(ok('GET', '/jobs/abc?x=1')).toBe(false);
    expect(ok('GET', '/jobs/abc\\files')).toBe(false);
    expect(ok('GET', '/status#x')).toBe(false);
  });
  it('本文の有無・形の違い', () => {
    expect(ok('POST', '/jobs')).toBe(false);
    expect(ok('POST', '/jobs/abc/cancel', {})).toBe(false);
    expect(checkEngineRequest(null).ok).toBe(false);
    expect(checkEngineRequest({ method: 1, path: '/status' }).ok).toBe(false);
    expect(checkEngineRequest({ method: 'GET' }).ok).toBe(false);
  });
});
