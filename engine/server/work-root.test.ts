import { describe, expect, it } from 'vitest';
import { isSafeWorkPath, resolveSafeWorkRoot } from './work-root';

describe('isSafeWorkPath', () => {
  it('英数字と . _ - / \\ : だけなら安全', () => {
    expect(isSafeWorkPath('/tmp/studio-m-engine')).toBe(true);
    expect(isSafeWorkPath('C:\\Users\\Public\\x_1.2')).toBe(true);
  });
  it('日本語・空白・引用符・% $ は安全でない', () => {
    for (const p of ['/tmp/Studio M', '/tmp/テスト', 'C:\\Users\\太郎\\Temp', '/tmp/a"b', '/tmp/a%b', '/tmp/a$b', '']) expect(isSafeWorkPath(p)).toBe(false);
  });
});

describe('resolveSafeWorkRoot', () => {
  const made: string[] = [];
  const mkdir = async (p: string): Promise<void> => void made.push(p);

  it('安全なパスはそのまま返す', async () => {
    expect(await resolveSafeWorkRoot({ requested: '/tmp/ok', platform: 'linux', exists: () => true, mkdir })).toEqual({ root: '/tmp/ok' });
  });
  it('日本語・空白のパスは /tmp に逃がす（macOS は /private/tmp）', async () => {
    const l = await resolveSafeWorkRoot({ requested: '/x/Studio M テスト', platform: 'linux', exists: () => true, mkdir });
    expect(l).toEqual({ root: '/tmp/studio-m-engine', relocatedFrom: '/x/Studio M テスト' });
    const m = await resolveSafeWorkRoot({ requested: '/x/テスト', platform: 'darwin', exists: () => true, mkdir });
    expect(m.root).toBe('/private/tmp/studio-m-engine');
  });
  it('Windows は ProgramData、PUBLIC、C:\\studio-m-work の順に試す', async () => {
    const env = { ProgramData: 'C:\\ProgramData', PUBLIC: 'C:\\Users\\Public' };
    const requested = 'C:\\Users\\太郎\\AppData\\Local\\Temp\\studio-m-engine';
    expect((await resolveSafeWorkRoot({ requested, platform: 'win32', env, exists: () => true, mkdir })).root).toBe('C:\\ProgramData\\studio-m-engine');
    const noPd = await resolveSafeWorkRoot({ requested, platform: 'win32', env, exists: () => true, mkdir: async (p) => { if (p.startsWith('C:\\ProgramData')) throw new Error('denied'); } });
    expect(noPd.root).toBe('C:\\Users\\Public\\studio-m-engine');
    const last = await resolveSafeWorkRoot({ requested, platform: 'win32', env: {}, exists: (p) => p !== 'C:\\Users\\Public', mkdir });
    expect(last.root).toBe('C:\\studio-m-work\\studio-m-engine');
  });
  it('どれも使えなければ日本語のエラー', async () => {
    await expect(resolveSafeWorkRoot({ requested: '/x/テスト', platform: 'linux', exists: () => true, mkdir: async () => { throw new Error('denied'); } })).rejects.toThrow(/STUDIO_M_WORK_ROOT/);
  });
});
