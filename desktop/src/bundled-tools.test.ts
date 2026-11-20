import { describe, expect, it } from 'vitest';
import { findBundledCcx, type DirEntry } from './bundled-tools';

const files = (...names: string[]): DirEntry[] => names.map((name) => ({ name, isDirectory: false }));

describe('findBundledCcx', () => {
  it('版つきの名前を見つけ、新しい版を選ぶ（2.23 は 2.9 より新しい）', () => {
    expect(findBundledCcx({ dir: '/res/ccx', platform: 'darwin', listDir: () => files('ccx_2.9', 'ccx_2.23', 'libfoo.dylib') })).toBe('/res/ccx/ccx_2.23');
  });

  it('版なしの ccx も見つかるが、版つきがあればそちらを選ぶ', () => {
    expect(findBundledCcx({ dir: '/res/ccx', platform: 'linux', listDir: () => files('ccx') })).toBe('/res/ccx/ccx');
    expect(findBundledCcx({ dir: '/res/ccx', platform: 'linux', listDir: () => files('ccx', 'ccx_2.21') })).toBe('/res/ccx/ccx_2.21');
  });

  it('拡張子つきのファイル、フォルダー、別名は除く', () => {
    const list = (): DirEntry[] => [...files('ccx_2.23.dll', 'ccx_2.23.txt', 'ccx.sh', 'cgx', 'ccx_x'), { name: 'ccx_9.9', isDirectory: true }];
    expect(findBundledCcx({ dir: '/res/ccx', platform: 'linux', listDir: list })).toBeNull();
  });

  it('Windows は .exe だけを対象にし、Windows のパスで返す', () => {
    const list = (): DirEntry[] => files('ccx_2.22.exe', 'ccx_2.23', 'ccx_2.21.dll', 'spooles.dll');
    expect(findBundledCcx({ dir: 'C:\\app\\resources\\ccx', platform: 'win32', listDir: list })).toBe('C:\\app\\resources\\ccx\\ccx_2.22.exe');
    expect(findBundledCcx({ dir: 'C:\\r\\ccx', platform: 'win32', listDir: () => files('ccx.exe') })).toBe('C:\\r\\ccx\\ccx.exe');
  });

  it('見つからない・フォルダーがないときは null', () => {
    expect(findBundledCcx({ dir: '/res/ccx', platform: 'darwin', listDir: () => [] })).toBeNull();
    expect(findBundledCcx({ dir: '/no/such/dir-studio-m', platform: 'darwin' })).toBeNull();
  });
});
