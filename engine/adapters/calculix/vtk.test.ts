import { writeVtk } from './vtk';

describe('writeVtk', () => {
  it('legacy VTK（等間隔の格子）にセルの値を書く。物体でないセルは 0', () => {
    const mask = Uint8Array.from([1, 1, 0, 1]);
    const text = writeVtk({
      nx: 2,
      ny: 2,
      h: 0.5,
      thickness: 0.01,
      title: 'テスト',
      mask,
      fields: [{ key: 'vonMises', label: 'ミーゼス応力', unit: 'Pa', data: Float32Array.from([1, 2, 3, 4]), mask }],
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('# vtk DataFile Version 3.0');
    expect(lines).toContain('DIMENSIONS 3 3 2');
    expect(lines).toContain('SPACING 0.5 0.5 0.01');
    expect(lines).toContain('CELL_DATA 4');
    const i = lines.indexOf('SCALARS vonMises float 1');
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 2]).toBe('1 2 0 4');
    const j = lines.indexOf('SCALARS solid float 1');
    expect(lines[j + 2]).toBe('1 1 0 1');
  });
});
