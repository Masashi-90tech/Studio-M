import { describe, expect, it, vi } from 'vitest';
import { defaultProject } from '../core/project';
import { createProFileSession } from './pro-files';

function fake(opened: { path: string; text: string } | null = null) {
  const save = vi.fn(async (r: { path?: string }) => ({ path: r.path ?? '/tmp/a.studiom.json' }));
  return { save, files: { open: vi.fn(async () => opened), save } };
}

describe('pro-files', () => {
  it('最初の保存は path なし（ダイアログ）、2 回目は同じ path で上書き、名前を付けては path なし', async () => {
    const { save, files } = fake();
    const s = createProFileSession(files);
    const project = { ...defaultProject(), name: '梁 1' };
    await s.save({ project });
    expect(save.mock.calls[0][0]).toMatchObject({ suggestedName: '梁_1.studiom.json' });
    expect(save.mock.calls[0][0]).not.toHaveProperty('path');
    await s.save({ project });
    expect(save.mock.calls[1][0]).toHaveProperty('path', '/tmp/a.studiom.json');
    await s.save({ project, saveAs: true });
    expect(save.mock.calls[2][0]).not.toHaveProperty('path');
    expect(JSON.parse((save.mock.calls[0][0] as unknown as { text: string }).text).name).toBe('梁 1');
  });

  it('取り消しなら null で、path は変わらない', async () => {
    const files = { open: async () => null, save: async () => null };
    const s = createProFileSession(files);
    expect(await s.open()).toBeNull();
    expect(await s.save({ project: defaultProject() })).toBeNull();
    expect(s.path).toBeNull();
  });

  it('開いたファイルの path を覚え、読めない中身は日本語の Error', async () => {
    const ok = createProFileSession({ open: async () => ({ path: '/x/p.studiom.json', text: JSON.stringify(defaultProject()) }), save: async () => null });
    expect(await ok.open()).not.toBeNull();
    expect(ok.path).toBe('/x/p.studiom.json');
    const bad = createProFileSession({ open: async () => ({ path: '/x/q.json', text: '{"a":1}' }), save: async () => null });
    await expect(bad.open()).rejects.toThrow('プロジェクトファイルではありません');
    expect(bad.path).toBeNull();
  });
});
