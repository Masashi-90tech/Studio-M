import { describe, expect, it } from 'vitest';
import { buildAboutText, ccxVersionFromPath, sourceUrlFromText } from './about';

const SOURCE = `同梱しているもの : CalculiX CrunchiX（ccx）  版 2.23
ソースの入手先
  公式  : http://www.calculix.de/ccx_2.23.src.tar.bz2（予備: http://www.dhondt.de/ccx_2.23.src.tar.bz2）`;

describe('about', () => {
  it('ccx の名前から版を読む', () => {
    expect(ccxVersionFromPath('/a/ccx/ccx_2.23')).toBe('2.23');
    expect(ccxVersionFromPath('C:\\r\\ccx\\ccx_2.23.exe')).toBe('2.23');
    expect(ccxVersionFromPath('/a/ccx')).toBeNull();
  });

  it('SOURCE.txt から最初の URL を取り出す（全角のかっこの手前まで）', () => {
    expect(sourceUrlFromText(SOURCE)).toBe('http://www.calculix.de/ccx_2.23.src.tar.bz2');
    expect(sourceUrlFromText('URL なし')).toBeNull();
  });

  it('版・GPL・ソースの入手先・フォルダーを日本語で出す', () => {
    const t = buildAboutText({ appVersion: '0.6.0', ccxPath: '/r/ccx/ccx_2.23', sourceText: SOURCE, licenseDir: '/r/THIRD-PARTY-LICENSES' });
    expect(t.message).toBe('Studio M Pro 0.6.0');
    expect(t.detail).toContain('MIT');
    expect(t.detail).toContain('CalculiX CrunchiX（ccx） 2.23');
    expect(t.detail).toContain('GPL-2.0');
    expect(t.detail).toContain('http://www.calculix.de/ccx_2.23.src.tar.bz2');
    expect(t.detail).toContain('/r/THIRD-PARTY-LICENSES');
  });

  it('SOURCE.txt も ccx もなければ、フォルダーを案内する', () => {
    const t = buildAboutText({ appVersion: '0.6.0', ccxPath: null, sourceText: null, licenseDir: '/r/T' });
    expect(t.detail).toContain('見つかりませんでした');
    expect(t.detail).toContain('THIRD-PARTY-LICENSES フォルダー');
  });
});
