import { describe, expect, it } from 'vitest';
import { checkForUpdate, compareSemver, isSafeReleaseUrl, parseProTag } from './update-check';

const reply = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('parseProTag', () => {
  it('pro-v の後ろが X.Y.Z のときだけ版を返す', () => {
    expect(parseProTag('pro-v0.7.1')).toBe('0.7.1');
    expect(parseProTag('ccx-v2.23')).toBeNull();
    expect(parseProTag('pro-v1.2')).toBeNull();
    expect(parseProTag('pro-v1.2.3-beta')).toBeNull();
    expect(parseProTag('v1.2.3')).toBeNull();
  });
});

describe('compareSemver', () => {
  it('数字で比べる（0.10.0 は 0.9.0 より新しい）', () => {
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareSemver('0.6.0', '0.6.0')).toBe(0);
    expect(compareSemver('0.6.0', '0.6.1')).toBeLessThan(0);
  });
  it('形が違えば NaN', () => {
    expect(compareSemver('0.6', '0.6.0')).toBeNaN();
  });
});

describe('isSafeReleaseUrl', () => {
  it('https://github.com/ で始まるものだけ許す', () => {
    expect(isSafeReleaseUrl('https://github.com/Masashi-90tech/Studio-M/releases/tag/pro-v0.7.0')).toBe(true);
    expect(isSafeReleaseUrl('http://github.com/x')).toBe(false);
    expect(isSafeReleaseUrl('https://github.com.evil.example/x')).toBe(false);
    expect(isSafeReleaseUrl('https://evil.example/https://github.com/')).toBe(false);
    expect(isSafeReleaseUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeReleaseUrl(42)).toBe(false);
  });
});

describe('checkForUpdate', () => {
  const url = 'https://github.com/Masashi-90tech/Studio-M/releases/tag/pro-v0.7.0';
  it('新しければ { latest, url }', async () => {
    expect(await checkForUpdate({ current: '0.6.0', fetch: reply(200, { tag_name: 'pro-v0.7.0', html_url: url }) })).toEqual({ latest: '0.7.0', url });
  });
  it('一覧から pro- のリリースだけを選ぶ（Lite や ccx が先頭にあっても見つける。下書き・先行版は除く）', async () => {
    const list = [
      { tag_name: 'v0.9.0', html_url: 'https://github.com/Masashi-90tech/Studio-M/releases/tag/v0.9.0' },
      { tag_name: 'ccx-v2.23', html_url: 'https://github.com/Masashi-90tech/Studio-M/releases/tag/ccx-v2.23' },
      { tag_name: 'pro-v0.8.0', draft: true, html_url: url },
      { tag_name: 'pro-v0.7.0', html_url: url },
      { tag_name: 'pro-v0.6.5', html_url: url },
    ];
    expect(await checkForUpdate({ current: '0.6.0', fetch: reply(200, list) })).toEqual({ latest: '0.7.0', url });
    expect(await checkForUpdate({ current: '0.7.0', fetch: reply(200, list) })).toBeNull();
  });
  it('同じか古ければ null', async () => {
    expect(await checkForUpdate({ current: '0.7.0', fetch: reply(200, { tag_name: 'pro-v0.7.0', html_url: url }) })).toBeNull();
    expect(await checkForUpdate({ current: '0.8.0', fetch: reply(200, { tag_name: 'pro-v0.7.0', html_url: url }) })).toBeNull();
  });
  it('Studio M Pro 以外のタグは null', async () => {
    expect(await checkForUpdate({ current: '0.6.0', fetch: reply(200, { tag_name: 'ccx-v2.23', html_url: url }) })).toBeNull();
  });
  it('404 は「更新情報を取得できませんでした」', async () => {
    const r = await checkForUpdate({ current: '0.6.0', fetch: reply(404, { message: 'Not Found' }) });
    expect(r).toEqual({ error: expect.stringContaining('更新情報を取得できませんでした') });
  });
  it('不正な JSON・形の違う JSON は error', async () => {
    expect(await checkForUpdate({ current: '0.6.0', fetch: reply(200, 'これは JSON ではない') })).toEqual({ error: expect.any(String) });
    expect(await checkForUpdate({ current: '0.6.0', fetch: reply(200, { foo: 1 }) })).toEqual({ error: expect.any(String) });
  });
  it('ネットワーク失敗は error', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await checkForUpdate({ current: '0.6.0', fetch: failing })).toEqual({ error: expect.stringContaining('ネットワーク') });
  });
  it('開いてはいけない url は error にする', async () => {
    const r = await checkForUpdate({ current: '0.6.0', fetch: reply(200, { tag_name: 'pro-v0.7.0', html_url: 'https://evil.example/x' }) });
    expect(r).toEqual({ error: expect.any(String) });
  });
  it('User-Agent を付け、個人情報を送らない', async () => {
    let seen: RequestInit | undefined;
    const spy = (async (_u: unknown, init?: RequestInit) => {
      seen = init;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await checkForUpdate({ current: '0.6.0', fetch: spy });
    expect((seen?.headers as Record<string, string>)['User-Agent']).toBe('Studio-M-Pro');
  });
});
