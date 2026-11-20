import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileStore, ensureProjectName } from './file-store';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-m-desktop-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ensureProjectName', () => {
  it('拡張子を補う', () => {
    expect(ensureProjectName('beam')).toBe('beam.studiom.json');
    expect(ensureProjectName('beam.json')).toBe('beam.studiom.json');
    expect(ensureProjectName('beam.studiom.json')).toBe('beam.studiom.json');
    expect(ensureProjectName('Beam.STUDIOM.JSON')).toBe('Beam.STUDIOM.JSON');
    expect(ensureProjectName('')).toBe('project.studiom.json');
    expect(ensureProjectName('../../etc/x')).toBe('x.studiom.json');
    expect(ensureProjectName('片持ち梁')).toBe('片持ち梁.studiom.json');
  });
});

describe('file-store', () => {
  it('保存 → 開く → 同じパスへの上書き', async () => {
    const st = createFileStore();
    const saved = await st.saveAs(join(dir, 'a'), '{"v":1}');
    expect(saved.path.endsWith('a.studiom.json')).toBe(true);
    expect(await readFile(saved.path, 'utf8')).toBe('{"v":1}');
    expect(st.canOverwrite(saved.path)).toBe(true);
    await st.overwrite(saved.path, '{"v":2}');
    expect(await readFile(saved.path, 'utf8')).toBe('{"v":2}');
    const opened = await st.open(saved.path);
    expect(opened.text).toBe('{"v":2}');
  });

  it('直前のファイル以外への上書きは拒否する', async () => {
    const st = createFileStore();
    const other = join(dir, 'other.studiom.json');
    await writeFile(other, 'keep');
    await expect(st.overwrite(other, 'x')).rejects.toThrow();
    const a = await st.saveAs(join(dir, 'b'), '1');
    expect(st.canOverwrite(other)).toBe(false);
    expect(st.canOverwrite(undefined)).toBe(false);
    await expect(st.overwrite(other, 'x')).rejects.toThrow('上書きできません');
    await expect(st.overwrite(join(dir, 'b.studiom.json', '..', 'other.studiom.json'), 'x')).rejects.toThrow();
    expect(await readFile(other, 'utf8')).toBe('keep');
    expect(a.path).toBeTruthy();
  });

  it('大きさの上限（保存・開く）', async () => {
    const st = createFileStore({ maxBytes: 10 });
    await expect(st.saveAs(join(dir, 'big'), 'x'.repeat(11))).rejects.toThrow('大きすぎ');
    const p = join(dir, 'big2.studiom.json');
    await writeFile(p, 'x'.repeat(11));
    await expect(st.open(p)).rejects.toThrow('大きすぎ');
    await expect(st.overwrite(p, 'y')).rejects.toThrow();
  });
});
