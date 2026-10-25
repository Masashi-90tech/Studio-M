import { describe, expect, it } from 'vitest';
import { rasterize } from '../core/raster';
import { buildPcbProject } from './build';
import { fixtureText } from './fixtures';
import { parseKicadPcb } from './kicad';

const board = parseKicadPcb(fixtureText('esp32-motor.kicad_pcb'));
const FILE = 'esp32-motor.kicad_pcb';

/** セル (x, y) [m] の kEff */
function kAt(project: ReturnType<typeof buildPcbProject>['project'], x: number, y: number): number {
  const r = rasterize(project);
  const i = Math.floor(x / r.h);
  const j = Math.floor(y / r.h);
  return r.kEff![j * r.nx + i];
}

describe('buildPcbProject（esp32-motor）', () => {
  const { project, parts, warnings } = buildPcbProject({ board, fileName: FILE });

  it('プロジェクトの基本: 名前・厚さ・領域・格子', () => {
    expect(project.name).toBe('esp32-motor');
    expect(project.thickness).toBeCloseTo(1.6e-3, 12);
    // 基板 60 × 40 mm + 余白 5 mm ずつ
    expect(project.domain.width).toBeCloseTo(0.07, 9);
    expect(project.domain.height).toBeCloseTo(0.05, 9);
    expect(project.domain.autoGrid).toBe(false);
    const cell = project.domain.width / project.domain.nx;
    expect(cell * 1e3).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(cell * 1e3).toBeLessThan(0.5);
    expect(warnings.some((w) => w.includes('格子は 1 セル約'))).toBe(true);
  });

  it('熱の設定: 周囲 25°C、自然対流 h = 10、面からも放熱、辺は断熱', () => {
    expect(project.heat.ambientC).toBe(25);
    expect(project.heat.surfaceH).toBe(10);
    expect(project.heat.faceCooling).toBe(true);
    for (const e of Object.values(project.heat.edges)) expect(e).toEqual({ type: 'adiabatic' });
  });

  it('project.pcb: ファイル名・厚さ・FR-4・銅箔の層', () => {
    expect(project.pcb).toBeDefined();
    expect(project.pcb!.source).toBe(FILE);
    expect(project.pcb!.boardThicknessMm).toBe(1.6);
    expect(project.pcb!.substrateId).toBe('fr4');
    expect(project.pcb!.layers.map((l) => l.name)).toEqual(['F.Cu', 'B.Cu']);
    expect(project.pcb!.layers[0].polygons.length).toBeGreaterThan(50);
  });

  it('形状: 基板（FR-4）→ 切り抜き（穴）→ 熱源の順', () => {
    const [board0, hole, ...rest] = project.shapes;
    expect(board0).toMatchObject({ name: '基板', role: 'solid', materialId: 'fr4' });
    expect(board0.meta?.source).toBe(FILE);
    expect(hole.role).toBe('hole');
    expect(rest.length).toBeGreaterThan(5);
    for (const s of rest) {
      expect(s.role).toBe('heatSource');
      expect(s.materialId).toBe('fr4');
      expect(s.geom.kind).toBe('rect');
      expect(s.maxTempC).toBeGreaterThan(0);
      expect(s.meta?.ref).toBeTruthy();
    }
  });

  it('熱源になる部品: 発熱 > 0 の部品と、温度を見張る電解コンデンサ', () => {
    const heat = project.shapes.filter((s) => s.role === 'heatSource');
    const byRef = new Map(heat.map((s) => [s.meta!.ref, s]));
    expect([...byRef.keys()].sort()).toEqual(['C1', 'D1', 'D2', 'Q1', 'R1', 'R2', 'R3', 'U1', 'U2', 'U3']);
    expect(byRef.get('U2')).toMatchObject({ name: 'U2 AMS1117-3.3', heatW: 1, maxTempC: 125 });
    expect(byRef.get('U2')!.meta).toMatchObject({ value: 'AMS1117-3.3', footprint: 'Package_TO_SOT_SMD:SOT-223-3_TabPin2', side: 'front', partType: 'ldo-power' });
    expect(byRef.get('U3')).toMatchObject({ heatW: 2, maxTempC: 125 });
    expect(byRef.get('U1')).toMatchObject({ heatW: 0.8, maxTempC: 85 });
    expect(byRef.get('C1')).toMatchObject({ heatW: 0, maxTempC: 85 });
    // C2・C3・C4（セラミック）、J1、H1 は入らない
    for (const ref of ['C2', 'C3', 'C4', 'J1', 'H1']) expect(byRef.has(ref)).toBe(false);
  });

  it('部品の一覧（ダイアログの表用）', () => {
    expect(parts).toHaveLength(15);
    const u2 = parts.find((p) => p.ref === 'U2')!;
    expect(u2).toMatchObject({ partType: 'ldo-power', matched: true, watts: 1, maxTempC: 125, included: true });
    expect(u2.partLabel).toContain('リニアレギュレーター');
    expect(u2.note).toContain('Vin');
    expect(parts.find((p) => p.ref === 'J1')).toMatchObject({ included: false, watts: 0 });
    expect(parts.find((p) => p.ref === 'C4')).toMatchObject({ side: 'back', included: false });
  });

  it('発熱の合計 = 部品の W の合計（格子化しても失われない）', () => {
    const sum = parts.filter((p) => p.included).reduce((s, p) => s + p.watts, 0);
    expect(sum).toBeCloseTo(0.8 + 1 + 2 + 3 * 0.05 + 0.06 + 0.1 + 0.1, 9);
    const r = rasterize(project);
    let total = 0;
    for (let c = 0; c < r.heatGen.length; c++) total += r.heatGen[c] * r.h * r.h * project.thickness;
    expect(total / sum).toBeGreaterThan(0.9999);
    expect(total / sum).toBeLessThan(1.0001);
  });

  it('銅箔のあるところは、むき出しの FR-4 より実効熱伝導率が高い', () => {
    // AMS1117 のタブのまわりの F.Cu ゾーン（KiCad の (139, 110) → Studio M の (44, 35) mm）
    const kZone = kAt(project, 0.044, 0.035);
    // 何も無いところ（(110, 137) → (15, 8) mm）は FR-4 の 0.3 そのまま
    const kBare = kAt(project, 0.015, 0.008);
    expect(kBare).toBeCloseTo(0.3, 6);
    // k_eff = (0.3 × (1.6 mm − 35 µm) + 391 × 35 µm) / 1.6 mm ≈ 8.85
    const expected = (0.3 * (1.6e-3 - 35e-6) + 391 * 35e-6) / 1.6e-3;
    expect(kZone).toBeCloseTo(expected, 1);
    expect(kZone).toBeGreaterThan(20 * kBare);
    // 表裏のゾーンが重なるところ（B.Cu の GND ベタ (150, 130) → (55, 15) mm）にも銅がある
    expect(kAt(project, 0.055, 0.015)).toBeGreaterThan(5);
    // 基板の外は NaN（物体が無い）
    expect(Number.isNaN(kAt(project, 0.002, 0.002))).toBe(true);
    // 取り付け穴の中も物体が無い
    expect(Number.isNaN(kAt(project, 0.01, 0.04))).toBe(true);
  });

  it('JSON にできる（保存・共有できる）', () => {
    const back = JSON.parse(JSON.stringify(project)) as typeof project;
    expect(back.pcb?.layers.length).toBe(2);
    expect(back.shapes.length).toBe(project.shapes.length);
  });
});

describe('buildPcbProject の設定', () => {
  it('利用者の書き換え（W・上限温度・含める/外す）が反映される', () => {
    const base = buildPcbProject({ board, fileName: FILE });
    const u2 = base.parts.find((p) => p.ref === 'U2')!;
    const j1 = base.parts.find((p) => p.ref === 'J1')!;
    const r1 = base.parts.find((p) => p.ref === 'R1')!;
    const out = buildPcbProject({
      board,
      fileName: FILE,
      overrides: { [u2.key]: { watts: 2.5, maxTempC: 100 }, [j1.key]: { included: true, watts: 0.3 }, [r1.key]: { included: false } },
    });
    const s = (ref: string) => out.project.shapes.find((x) => x.meta?.ref === ref);
    expect(s('U2')).toMatchObject({ heatW: 2.5, maxTempC: 100 });
    expect(s('J1')).toMatchObject({ heatW: 0.3 });
    expect(s('R1')).toBeUndefined();
    expect(out.parts.find((p) => p.ref === 'U2')).toMatchObject({ watts: 2.5, maxTempC: 100 });
    // 不正な値は無視してライブラリの値に戻る
    const bad = buildPcbProject({ board, fileName: FILE, overrides: { [u2.key]: { watts: -3, maxTempC: NaN } } });
    expect(bad.parts.find((p) => p.ref === 'U2')).toMatchObject({ watts: 1, maxTempC: 125 });
  });

  it('基板・銅箔の厚さ、周囲温度、冷却を変えられる', () => {
    const { project } = buildPcbProject({ board, fileName: FILE, boardThicknessMm: 1.0, copperThicknessUm: 70, ambientC: 40, surfaceH: 25 });
    expect(project.thickness).toBeCloseTo(1e-3, 12);
    expect(project.pcb!.boardThicknessMm).toBe(1);
    expect(project.pcb!.layers.every((l) => l.thicknessUm === 70)).toBe(true);
    expect(project.heat).toMatchObject({ ambientC: 40, surfaceH: 25 });
    // 銅が厚いほど実効熱伝導率は高い
    const base = buildPcbProject({ board, fileName: FILE }).project;
    expect(kAt(project, 0.044, 0.035)).toBeGreaterThan(kAt(base, 0.044, 0.035));
  });

  it('発熱 0 W の部品も入れる（includeZeroPowerParts）', () => {
    const out = buildPcbProject({ board, fileName: FILE, includeZeroPowerParts: true });
    const refs = out.project.shapes.filter((s) => s.role === 'heatSource').map((s) => s.meta!.ref);
    for (const ref of ['C2', 'C3', 'C4', 'J1']) expect(refs).toContain(ref);
  });

  it('余白を変えると、基板ごと平行移動する', () => {
    const out = buildPcbProject({ board, fileName: FILE, domainMarginMm: 10 });
    expect(out.project.domain.width).toBeCloseTo(0.08, 9);
    expect(out.project.domain.height).toBeCloseTo(0.06, 9);
    const first = out.project.shapes[0].geom;
    expect(first.kind).toBe('polygon');
    if (first.kind === 'polygon') {
      expect(Math.min(...first.points.map((p) => p[0]))).toBeCloseTo(0.01, 9);
    }
    // 銅箔も同じだけずれて、熱源の位置と合ったまま
    const r = rasterize(out.project);
    expect(r.kEff![Math.floor(0.049 / r.h) + r.nx * Math.floor(0.04 / r.h)]).toBeGreaterThan(5);
  });

  it('大きな基板はセルを大きくして上限を守る', () => {
    const out = buildPcbProject({ board, fileName: FILE, maxCells: 5000 });
    const r = rasterize(out.project);
    expect(r.nx * r.ny).toBeLessThanOrEqual(5500);
    expect(out.warnings.some((w) => w.includes('セルを大きくしています'))).toBe(true);
  });

  it('セルより小さい部品は、熱が消えないよう 1 セル以上に広げる', () => {
    const out = buildPcbProject({ board, fileName: FILE, targetCellMm: 3 });
    expect(out.warnings.some((w) => w.includes('1 セルより大きく'))).toBe(true);
    const r = rasterize(out.project);
    let total = 0;
    for (let c = 0; c < r.heatGen.length; c++) total += r.heatGen[c] * r.h * r.h * out.project.thickness;
    const sum = out.parts.filter((p) => p.included).reduce((s, p) => s + p.watts, 0);
    expect(total / sum).toBeGreaterThan(0.99);
  });

  it('熱源が無いときは直し方を知らせる', () => {
    const none = buildPcbProject({ board, fileName: FILE, overrides: Object.fromEntries(buildPcbProject({ board, fileName: FILE }).parts.map((p) => [p.key, { included: false }])) });
    expect(none.warnings.some((w) => w.includes('発熱する部品が選ばれていません'))).toBe(true);
  });

  it('KiCad 5 形式の基板も熱プロジェクトになる', () => {
    const b5 = parseKicadPcb(fixtureText('kicad5-minimal.kicad_pcb'));
    const out = buildPcbProject({ board: b5, fileName: 'kicad5-minimal.kicad_pcb' });
    const refs = out.project.shapes.filter((s) => s.role === 'heatSource').map((s) => s.meta!.ref);
    expect(refs.sort()).toEqual(['C1', 'D1', 'R1', 'U1']);
    expect(out.project.shapes.find((s) => s.meta?.ref === 'U1')).toMatchObject({ heatW: 1, maxTempC: 125 });
    // B.Cu のゾーン（36 × 16 mm）は基板の下半分
    expect(out.project.pcb!.layers.find((l) => l.name === 'B.Cu')).toBeDefined();
    const r = rasterize(out.project);
    expect(r.kEff!.some((k) => k > 5)).toBe(true);
  });
});
