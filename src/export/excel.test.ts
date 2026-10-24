import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { defaultProject } from '../core/project';
import { rasterize } from '../core/raster';
import type { ResultSet } from '../core/types';
import { exportFormulaWorkbook, exportResultsWorkbook, FIELD_HEADER_ROWS } from './excel';

function fakeResult(nx: number, ny: number, h: number): ResultSet {
  const n = nx * ny;
  const speed = new Float32Array(n);
  const vort = new Float32Array(n);
  const mask = new Uint8Array(n).fill(1);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      speed[k] = 0.01 * (1 + i / nx);
      vort[k] = (j - ny / 2) * 0.1;
      if (i === 2 && j === 2) mask[k] = 0; // 物体セル
    }
  }
  return {
    analysis: 'flow',
    nx,
    ny,
    h,
    fields: [
      { key: 'speed', label: '流速', unit: 'm/s', data: speed, mask },
      { key: 'vort', label: '渦度', unit: '1/s', data: vort, diverging: true },
    ],
    scalars: [{ key: 'cd', label: '抗力係数', unit: '-', value: 1.23 }],
    history: [
      { key: 'a', label: '残差', unit: '', t: [1, 2, 3], values: [1, 0.5, 0.25] },
      { key: 'b', label: '速度', unit: 'm/s', t: [1, 2], values: [0.1, 0.2] },
    ],
    warnings: ['格子が粗いので精度は低いです'],
  };
}

async function load(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return wb;
}

describe('exportResultsWorkbook', () => {
  const project = defaultProject();
  project.domain.nx = 40;
  const raster = rasterize(project);
  const rs = fakeResult(raster.nx, raster.ny, raster.h);

  it('必要なシートが揃い、場シートの寸法が ny×nx に一致する', async () => {
    const bytes = await exportResultsWorkbook(project, [rs]);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const wb = await load(bytes);
    const names = wb.worksheets.map((w) => w.name);
    for (const n of ['概要', '条件', '形状', '材料', '流れ_流速', '流れ_渦度', '履歴_流れ']) expect(names).toContain(n);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(31);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);

    const ws = wb.getWorksheet('流れ_流速')!;
    expect(ws.rowCount).toBe(FIELD_HEADER_ROWS + raster.ny);
    // 最上段 = j = ny-1、左端 = i = 0
    const top = FIELD_HEADER_ROWS + 1;
    expect(ws.getCell(top, 1).value).toBeCloseTo(0.01 * (1 + 0 / raster.nx), 5);
    expect(ws.getCell(top, raster.nx).value).toBeCloseTo(0.01 * (1 + (raster.nx - 1) / raster.nx), 5);
    // マスクされたセル (2,2) は空欄
    const masked = ws.getCell(FIELD_HEADER_ROWS + 1 + (raster.ny - 1 - 2), 3);
    expect(masked.value).toBeNull();
    expect(String(ws.getCell(1, 1).value)).toContain('流速');

    const vort = wb.getWorksheet('流れ_渦度')!;
    expect(vort.getCell(top + 5, 5).value).not.toBeNull();
  });

  it('場シートに色スケール（発散場は 0 中心）の条件付き書式が入る', async () => {
    const bytes = await exportResultsWorkbook(project, [rs]);
    const zip = await JSZip.loadAsync(bytes);
    const sheetFiles = Object.keys(zip.files).filter((f) => /xl\/worksheets\/sheet\d+\.xml$/.test(f));
    let withScale = 0;
    let withNum0 = 0;
    for (const f of sheetFiles) {
      const xml = await zip.file(f)!.async('string');
      if (xml.includes('<colorScale>')) withScale += 1;
      if (/<cfvo type="num" val="0"\/>/.test(xml)) withNum0 += 1;
    }
    expect(withScale).toBe(2);
    expect(withNum0).toBe(1);
  });

  it('概要に代表値・注意、履歴シートに列ペアが出る', async () => {
    const wb = await load(await exportResultsWorkbook(project, [rs]));
    const text: string[] = [];
    wb.getWorksheet('概要')!.eachRow((r) => r.eachCell((c) => text.push(String(c.value))));
    expect(text).toContain('抗力係数');
    expect(text).toContain('格子が粗いので精度は低いです');
    expect(text).toContain(project.name);
    const hist = wb.getWorksheet('履歴_流れ')!;
    expect(hist.getCell(1, 1).value).toBe('t');
    expect(hist.getCell(1, 3).value).toBe('t');
    expect(hist.getCell(4, 2).value).toBe(0.25);
    expect(hist.getCell(4, 4).value).toBeNull(); // 2つ目の履歴は長さ2
    const shapes = wb.getWorksheet('形状')!;
    expect(shapes.getCell(2, 2).value).toBe('物体');
    expect(shapes.getCell(2, 3).value).toBe('アルミ A6061-T6');
  });

  it('大きな格子は間引かれ、同名シートは一意になる', async () => {
    const big = fakeResult(300, 10, 0.01);
    big.fields = [big.fields[0], { ...big.fields[0] }];
    const wb = await load(await exportResultsWorkbook(project, [big]));
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toContain('流れ_流速');
    expect(names).toContain('流れ_流速_2');
    const ws = wb.getWorksheet('流れ_流速')!;
    expect(ws.getCell(1, 150).value).toBeNull(); // 300/2 = 150 列まで
    expect(ws.getCell(FIELD_HEADER_ROWS + 1, 150).value).not.toBeNull();
    expect(String(ws.getCell(3, 1).value)).toContain('間引');
  });
});

describe('exportFormulaWorkbook', () => {
  const project = defaultProject();
  project.domain.nx = 40;
  const raster = rasterize(project);

  it('反復計算の設定と数式が入る', async () => {
    const bytes = await exportFormulaWorkbook(project, raster);
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('xl/workbook.xml')!.async('string');
    expect(xml).toContain('iterate="1"');
    expect(xml).toContain('iterateCount="1000"');
    expect(xml).toContain('iterateDelta="0.00001"');

    const wb = await load(bytes);
    const ws = wb.getWorksheet('対流拡散')!;
    expect(ws).toBeTruthy();

    // 格子の位置を「流入」ラベルから逆算する代わりに、数式セルの分布で確かめる
    const formulaCells: { r: number; c: number; f: string }[] = [];
    ws.eachRow((row, r) => {
      row.eachCell((cell, c) => {
        const v = cell.value as { formula?: string } | null;
        if (v && typeof v === 'object' && 'formula' in v && c >= 2 && r > 25) formulaCells.push({ r, c, f: v.formula! });
      });
    });
    expect(formulaCells.length).toBe(raster.nx * raster.ny);

    const minR = Math.min(...formulaCells.map((x) => x.r));
    const minC = Math.min(...formulaCells.map((x) => x.c));
    const at = (i: number, j: number) => formulaCells.find((x) => x.r === minR + (raster.ny - 1 - j) && x.c === minC + i)!;

    // 流体セル（領域の中ほど、物体から離れた所）: 4隣接を参照
    const fi = 5;
    const fj = 5;
    expect(raster.solid[fj * raster.nx + fi]).toBe(0);
    const f = at(fi, fj);
    const col = (c: number) => String.fromCharCode(64 + c);
    expect(f.f).toContain(`${col(f.c - 1)}${f.r}`);
    expect(f.f).toContain(`${col(f.c + 1)}${f.r}`);
    expect(f.f).toContain(`${col(f.c)}${f.r - 1}`);
    expect(f.f).toContain(`${col(f.c)}${f.r + 1}`);
    expect(f.f).toContain('$N$14*');

    // 左端は流入値を参照し、西隣セルは参照しない
    const left = at(0, 5);
    expect(left.f).toContain('$N$9');
    // 右端は東隣なし、上端は北隣なし
    expect(at(raster.nx - 1, 5).f).not.toContain(`${col(minC + raster.nx)}`);
    expect(at(10, raster.ny - 1).f).not.toContain(`${col(at(10, raster.ny - 1).c)}${minR - 1}`);

    // 物体セルは物体値を参照する灰色セル
    let si = -1;
    let sj = -1;
    for (let k = 0; k < raster.solid.length && si < 0; k++) {
      if (raster.solid[k]) {
        si = k % raster.nx;
        sj = Math.floor(k / raster.nx);
      }
    }
    expect(si).toBeGreaterThanOrEqual(0);
    expect(at(si, sj).f).toBe('$N$10');

    // 物体の隣の流体セルは物体面係数を使う
    let adj = -1;
    for (let i = 0; i < raster.nx - 1; i++) {
      if (!raster.solid[sj * raster.nx + i] && raster.solid[sj * raster.nx + i + 1]) adj = i;
    }
    expect(adj).toBeGreaterThanOrEqual(0);
    expect(at(adj, sj).f).toContain('$N$18*$N$10');
  });

  it('色スケールとラベル・使い方が入る', async () => {
    const bytes = await exportFormulaWorkbook(project, raster);
    const zip = await JSZip.loadAsync(bytes);
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet).toContain('<colorScale>');
    const wb = await load(bytes);
    const text: string[] = [];
    wb.getWorksheet('対流拡散')!.eachRow((r) => r.eachCell((c) => text.push(String(c.value))));
    const joined = text.join('\n');
    expect(joined).toContain('Inlet');
    expect(joined).toContain('Outlet');
    expect(joined).toContain('Symmetry');
    expect(joined).toContain('F9');
    expect(joined).toContain('反復計算');
  });

  it('大きすぎる格子は日本語のエラーになる', async () => {
    const p = defaultProject(); // nx = 200
    await expect(exportFormulaWorkbook(p, rasterize(p))).rejects.toThrow(/nx/);
  });
});
