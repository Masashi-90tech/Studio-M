import { describe, expect, it } from 'vitest';
import { fixtureText, miniBoard } from './fixtures';
import { polygonArea, bboxOf, type Pt } from './geom';
import { KicadParseError, parseKicadPcb, type KicadBoard } from './kicad';

const mm2 = (p: Pt[]) => polygonArea(p) * 1e6; // m² → mm²
const mm = (v: number) => v * 1e3;
const find = (b: KicadBoard, ref: string) => b.footprints.find((f) => f.reference === ref)!;

describe('KiCad 8 の基板（esp32-motor）', () => {
  const board = parseKicadPcb(fixtureText('esp32-motor.kicad_pcb'));

  it('版・厚さ・層構成', () => {
    expect(board.version).toBe(20240108);
    expect(board.generator).toBe('pcbnew');
    expect(board.thicknessMm).toBe(1.6);
    expect(board.layers.map((l) => l.name)).toEqual(['F.Cu', 'B.Cu']);
    expect(board.layers.every((l) => l.thicknessUm === 35)).toBe(true);
  });

  it('外形: 60 × 40 mm、角 R2。面積は 2400 − (4 − π) × 4', () => {
    const exact = 2400 - (4 - Math.PI) * 4;
    expect(mm2(board.outline) / exact).toBeGreaterThan(0.9995);
    expect(mm2(board.outline) / exact).toBeLessThan(1.0001);
    const b = bboxOf(board.outline);
    expect(mm(b.x1 - b.x0)).toBeCloseTo(60, 6);
    expect(mm(b.y1 - b.y0)).toBeCloseTo(40, 6);
    // 外形の左下が余白 5 mm の位置に来る
    expect(mm(b.x0)).toBeCloseTo(5, 9);
    expect(mm(b.y0)).toBeCloseTo(5, 9);
    expect(board.marginMm).toBe(5);
  });

  it('取り付け穴（Edge.Cuts の円）は切り抜きになる', () => {
    expect(board.holes).toHaveLength(1);
    expect(mm2(board.holes[0]) / (Math.PI * 1.6 ** 2)).toBeGreaterThan(0.995);
    // 穴は (105, 105) → Studio M の (10, 40) mm
    const hb = bboxOf(board.holes[0]);
    expect(mm((hb.x0 + hb.x1) / 2)).toBeCloseTo(10, 6);
    expect(mm((hb.y0 + hb.y1) / 2)).toBeCloseTo(40, 6);
  });

  it('警告は出ない（キープアウトのゾーンは銅箔でないが、未塗りつぶしとは数えない）', () => {
    expect(board.warnings).toEqual([]);
  });

  it('部品は 15 個、番号・値・フットプリント・面を読む', () => {
    expect(board.footprints).toHaveLength(15);
    const u2 = find(board, 'U2');
    expect(u2.value).toBe('AMS1117-3.3');
    expect(u2.footprint).toBe('Package_TO_SOT_SMD:SOT-223-3_TabPin2');
    expect(u2.side).toBe('front');
    expect(find(board, 'C4').side).toBe('back');
    expect(find(board, 'U1').value).toBe('ESP32-S3-WROOM-1-N8');
    expect(find(board, 'J1').attrs).toContain('through_hole');
  });

  it('座標は y 上向き: 基板の上にある J1 の方が U1 より y が大きい', () => {
    const u1 = find(board, 'U1');
    const j1 = find(board, 'J1');
    // KiCad (113, 121) → (18, 24) mm、(157, 103) → (62, 42) mm
    expect(mm(u1.x)).toBeCloseTo(18, 6);
    expect(mm(u1.y)).toBeCloseTo(24, 6);
    expect(mm(j1.x)).toBeCloseTo(62, 6);
    expect(mm(j1.y)).toBeCloseTo(42, 6);
    expect(j1.y).toBeGreaterThan(u1.y);
  });

  it('クーリアードの範囲（回転なし）', () => {
    const u1 = find(board, 'U1');
    expect(u1.bboxSource).toBe('courtyard');
    expect(mm(u1.bbox.x1 - u1.bbox.x0)).toBeCloseTo(18, 6);
    expect(mm(u1.bbox.y1 - u1.bbox.y0)).toBeCloseTo(25.5, 6);
  });

  it('90° 回した部品（U3）の範囲は回転を反映する', () => {
    const u3 = find(board, 'U3');
    expect(u3.rotationDeg).toBe(90);
    // ローカルの範囲 x[-14,14] y[-3,6] → 基板の x[145,154] y[109,137] → Studio M の x[50,59] y[8,36] mm
    expect(mm(u3.bbox.x0)).toBeCloseTo(50, 6);
    expect(mm(u3.bbox.x1)).toBeCloseTo(59, 6);
    expect(mm(u3.bbox.y0)).toBeCloseTo(8, 6);
    expect(mm(u3.bbox.y1)).toBeCloseTo(36, 6);
    // 幅と高さが入れ替わっている（ローカルは 28 × 9）
    expect(u3.bbox.y1 - u3.bbox.y0).toBeGreaterThan(u3.bbox.x1 - u3.bbox.x0);
  });

  it('円のクーリアード（電解コンデンサ）と np_thru_hole だけの部品', () => {
    const c1 = find(board, 'C1');
    expect(mm(c1.bbox.x1 - c1.bbox.x0)).toBeGreaterThan(7.1);
    expect(mm(c1.bbox.x1 - c1.bbox.x0)).toBeLessThanOrEqual(7.2);
    const h1 = find(board, 'H1');
    expect(h1.padCount).toBe(1);
    // 取り付け穴のパッド（np_thru_hole）は銅箔にならない: H1 の位置 (157.5, 135.5) → (62.5, 9.5) mm に銅箔の多角形が無い
    const f = board.layers.find((l) => l.name === 'F.Cu')!;
    const near = f.polygons.filter((p) => {
      const b = bboxOf(p);
      return Math.abs(mm((b.x0 + b.x1) / 2) - 62.5) < 0.5 && Math.abs(mm((b.y0 + b.y1) / 2) - 9.5) < 0.5;
    });
    expect(near).toHaveLength(0);
  });

  it('配線は 長さ × 幅 + 丸い端 の多角形になる', () => {
    const f = board.layers.find((l) => l.name === 'F.Cu')!;
    // 試験用の配線 (118,112)→(128,112)、幅 0.5 mm
    const exact = 10 * 0.5 + Math.PI * 0.25 ** 2;
    const track = f.polygons.find((p) => {
      const b = bboxOf(p);
      return Math.abs(mm(b.x1 - b.x0) - 10.5) < 1e-6 && Math.abs(mm(b.y1 - b.y0) - 0.5) < 1e-6;
    });
    expect(track).toBeDefined();
    expect(mm2(track!) / exact).toBeGreaterThan(0.995);
    expect(mm2(track!) / exact).toBeLessThanOrEqual(1);
    // 位置: 左端は 118 − 0.25 → (17.75, ..) mm、y は (140 − 112 + 5) = 33 mm
    const b = bboxOf(track!);
    expect(mm(b.x0)).toBeCloseTo(22.75, 6);
    expect(mm((b.y0 + b.y1) / 2)).toBeCloseTo(33, 6);
  });

  it('弧の配線（arc）も多角形になる: 面積 ≈ 弧長 × 幅', () => {
    const f = board.layers.find((l) => l.name === 'F.Cu')!;
    const exact = ((Math.PI * 3) / 2) * 0.4;
    const arc = f.polygons.find((p) => {
      const b = bboxOf(p);
      const w = mm(b.x1 - b.x0);
      const h = mm(b.y1 - b.y0);
      return w > 3 && w < 3.5 && h > 3 && h < 3.5;
    });
    expect(arc).toBeDefined();
    expect(mm2(arc!) / exact).toBeGreaterThan(0.98);
    expect(mm2(arc!) / exact).toBeLessThan(1.02);
  });

  it('ビア（4 個）は表と裏の両方に円として入る', () => {
    for (const name of ['F.Cu', 'B.Cu']) {
      const layer = board.layers.find((l) => l.name === name)!;
      const vias = layer.polygons.filter((p) => p.length === 12 && Math.abs(mm2(p) - 3 * 0.4 ** 2) < 0.01);
      expect(vias).toHaveLength(4);
    }
  });

  it('ゾーンは filled_polygon（塗りつぶし結果）を使う', () => {
    const f = board.layers.find((l) => l.name === 'F.Cu')!;
    const b = board.layers.find((l) => l.name === 'B.Cu')!;
    expect(f.polygons.some((p) => Math.abs(mm2(p) - 110) < 1e-6)).toBe(true); // 10 × 11 mm（AMS1117 のタブのまわり）
    expect(b.polygons.some((p) => Math.abs(mm2(p) - 483) < 1e-6)).toBe(true); // 21 × 23 mm（GND ベタ）
    // キープアウトの 18 × 5.5 mm は銅箔にならない
    expect(f.polygons.some((p) => Math.abs(mm2(p) - 99) < 1e-6)).toBe(false);
  });

  it('スルーホールのパッド（*.Cu）は両面に入る', () => {
    // U3 のパッド: 11 個ぶんが F.Cu にも B.Cu にもある（面積 1.8 × 1.8 + π × 0.9² ≈ 5.8 mm²）
    for (const name of ['F.Cu', 'B.Cu']) {
      const layer = board.layers.find((l) => l.name === name)!;
      expect(layer.polygons.filter((p) => Math.abs(mm2(p) - 5.78) < 0.15)).toHaveLength(11);
    }
  });
});

describe('KiCad 5 形式の基板', () => {
  const board = parseKicadPcb(fixtureText('kicad5-minimal.kicad_pcb'));

  it('module / fp_text / 引用符なしの記法を読み、旧形式の注意を出す', () => {
    expect(board.version).toBe(20171130);
    expect(board.footprints.map((f) => f.reference)).toEqual(['U1', 'R1', 'D1', 'C1']);
    expect(board.footprints[0].value).toBe('L7805');
    expect(board.footprints[0].footprint).toBe('Package_TO_SOT_THT:TO-220-3_Vertical');
    expect(board.warnings.some((w) => w.includes('旧形式'))).toBe(true);
  });

  it('外形（gr_line と旧形式の gr_arc）が閉じて、面積は 40 × 30 − (4 − π)', () => {
    const exact = 1200 - (4 - Math.PI);
    expect(mm2(board.outline) / exact).toBeGreaterThan(0.9995);
    expect(mm2(board.outline) / exact).toBeLessThan(1.0001);
    expect(board.holes).toHaveLength(1);
    expect(mm2(board.holes[0]) / (Math.PI * 1.5 ** 2)).toBeGreaterThan(0.995);
  });

  it('90° 回した R1 の範囲（幅と高さが入れ替わる）', () => {
    const r1 = board.footprints[1];
    expect(r1.rotationDeg).toBe(90);
    // ローカル x[-1.68,1.68] y[-0.95,0.95] → 回転後 幅 1.9 × 高さ 3.36
    expect(mm(r1.bbox.x1 - r1.bbox.x0)).toBeCloseTo(1.9, 6);
    expect(mm(r1.bbox.y1 - r1.bbox.y0)).toBeCloseTo(3.36, 6);
  });

  it('層のないゾーンの filled_polygon はゾーンの層（B.Cu）に入る。スルーホールは両面', () => {
    const b = board.layers.find((l) => l.name === 'B.Cu')!;
    expect(b.polygons.some((p) => Math.abs(mm2(p) - 576) < 1e-6)).toBe(true);
    const f = board.layers.find((l) => l.name === 'F.Cu')!;
    expect(f.polygons.length).toBeGreaterThan(5);
  });
});

describe('いろいろな書き方と失敗', () => {
  it('KiCad の基板でないファイルは分かりやすいエラー', () => {
    expect(() => parseKicadPcb('(kicad_sch (version 1))')).toThrow(/回路図/);
    expect(() => parseKicadPcb('hello')).toThrow(KicadParseError);
    expect(() => parseKicadPcb('(kicad_pcb (version 1)')).toThrow(/途中で切れている/);
    expect(() => parseKicadPcb('(footprint "x")')).toThrow(/基板ファイル/);
  });

  it('外形が無ければ銅箔と部品を囲む四角を外形にして警告', () => {
    const b = parseKicadPcb(miniBoard('(segment (start 5 5) (end 15 5) (width 0.5) (layer "F.Cu") (net 1))', { outline: false }));
    expect(b.warnings.some((w) => w.includes('外形'))).toBe(true);
    expect(b.outline.length).toBe(4);
    expect(mm2(b.outline)).toBeGreaterThan(10 * 0.5);
  });

  it('何も無ければエラー', () => {
    expect(() => parseKicadPcb(miniBoard('', { outline: false }))).toThrow(/外形/);
  });

  it('外形に隙間があると警告し、閉じた輪郭が無ければ四角で代用する', () => {
    const lines = `(gr_line (start 0 0) (end 20 0) (layer "Edge.Cuts")) (gr_line (start 20 0) (end 20 10) (layer "Edge.Cuts")) (gr_line (start 20 10) (end 0 10) (layer "Edge.Cuts"))
      (segment (start 2 2) (end 8 2) (width 0.3) (layer "F.Cu"))`;
    const b = parseKicadPcb(miniBoard(lines, { outline: false }));
    expect(b.warnings.some((w) => w.includes('隙間'))).toBe(true);
    expect(b.outline.length).toBeGreaterThanOrEqual(4);
  });

  it('gr_poly の外形、順番や向きがばらばらの gr_line の外形', () => {
    const poly = parseKicadPcb(miniBoard(`(gr_poly (pts (xy 0 0) (xy 30 0) (xy 30 5) (xy 0 5)) (layer "Edge.Cuts") (fill none))`, { outline: false }));
    expect(mm2(poly.outline)).toBeCloseTo(150, 6);
    const shuffled = parseKicadPcb(
      miniBoard(
        `(gr_line (start 10 10) (end 0 10) (layer "Edge.Cuts")) (gr_line (start 0 0) (end 0 10) (layer "Edge.Cuts"))
         (gr_line (start 10 0) (end 10 10) (layer "Edge.Cuts")) (gr_line (start 0 0) (end 10 0) (layer "Edge.Cuts"))`,
        { outline: false },
      ),
    );
    expect(mm2(shuffled.outline)).toBeCloseTo(100, 6);
    expect(shuffled.warnings.filter((w) => w.includes('外形'))).toEqual([]);
  });

  it('外形の外にも輪郭があれば、最大のものを使って知らせる', () => {
    const b = parseKicadPcb(miniBoard(`(gr_rect (start 30 0) (end 33 3) (layer "Edge.Cuts"))`));
    expect(mm2(b.outline)).toBeCloseTo(200, 6);
    expect(b.holes).toHaveLength(0);
    expect(b.warnings.some((w) => w.includes('外形の外'))).toBe(true);
  });

  it('塗りつぶされていないゾーンは銅箔にせず、直し方つきで警告する', () => {
    const b = parseKicadPcb(miniBoard(`(zone (net 1) (net_name "GND") (layer "F.Cu") (polygon (pts (xy 1 1) (xy 9 1) (xy 9 9) (xy 1 9))))`));
    expect(b.layers).toHaveLength(0);
    expect(b.warnings.some((w) => w.includes('塗りつぶ') && w.includes('B キー'))).toBe(true);
    expect(b.warnings.some((w) => w.includes('銅箔'))).toBe(true);
  });

  it('複数層のゾーン（layers）は filled_polygon の層に入る', () => {
    const b = parseKicadPcb(
      miniBoard(`(zone (net 1) (layers "F.Cu" "B.Cu") (polygon (pts (xy 1 1) (xy 9 1) (xy 9 9) (xy 1 9)))
        (filled_polygon (layer "B.Cu") (pts (xy 1 1) (xy 9 1) (xy 9 9) (xy 1 9))))`),
    );
    expect(b.layers.map((l) => l.name)).toEqual(['B.Cu']);
  });

  it('スタックアップの銅箔の厚さと基板の厚さ', () => {
    const header = `(general (thickness 1.2)) (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal))
      (setup (stackup (layer "F.Cu" (type "copper") (thickness 0.07)) (layer "dielectric 1" (type "core") (thickness 1.06)) (layer "In1.Cu" (type "copper") (thickness 0.0175)) (layer "B.Cu" (type "copper") (thickness 0.035))))`;
    const body = `(segment (start 1 1) (end 5 1) (width 0.3) (layer "In1.Cu")) (segment (start 1 3) (end 5 3) (width 0.3) (layer "F.Cu"))
      (via (at 2 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu"))`;
    const b = parseKicadPcb(miniBoard(body, { header }));
    expect(b.thicknessMm).toBe(1.2);
    // 普通のビアは全層（In2.Cu にも）に入る。スタックアップに無い In2.Cu は既定の 35 µm
    expect(b.layers.map((l) => l.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(b.layers.map((l) => l.thicknessUm)).toEqual([70, 17.5, 35, 35]);
  });

  it('基板の厚さは general が無ければスタックアップの合計、それも無ければ 1.6', () => {
    const none = parseKicadPcb(miniBoard('', { header: '' }));
    expect(none.thicknessMm).toBe(1.6);
    const stack = parseKicadPcb(miniBoard('', { header: '(setup (stackup (layer "dielectric 1" (type "core") (thickness 0.8)) (layer "F.Cu" (type "copper") (thickness 0.035))))' }));
    expect(stack.thicknessMm).toBeCloseTo(0.835, 6);
  });

  it('部品の範囲: クーリアードが無ければパッド + 余白、パッドも無ければ 2 mm 角', () => {
    const body = `
      (footprint "A:B" (layer "F.Cu") (at 10 5) (property "Reference" "R9" (at 0 0)) (property "Value" "1k" (at 0 0))
        (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu")) (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu")))
      (footprint "A:C" (layer "F.Cu") (at 15 5) (property "Reference" "LOGO1" (at 0 0)) (property "Value" "x" (at 0 0)))`;
    const b = parseKicadPcb(miniBoard(body));
    const r = b.footprints[0];
    expect(r.bboxSource).toBe('pads');
    expect(mm(r.bbox.x1 - r.bbox.x0)).toBeCloseTo(3 + 0.5, 6); // パッド全体 3 mm + 余白 0.25 × 2
    const logo = b.footprints[1];
    expect(logo.bboxSource).toBe('default');
    expect(mm(logo.bbox.x1 - logo.bbox.x0)).toBeCloseTo(2, 6);
    expect(logo.padCount).toBe(0);
  });

  it('裏面の部品と、45° に回した部品の範囲', () => {
    const body = `(footprint "A:B" (layer "B.Cu") (at 10 5 45) (property "Reference" "U7" (at 0 0)) (property "Value" "x" (at 0 0))
      (fp_rect (start -2 -1) (end 2 1) (stroke (width 0.05) (type solid)) (layer "B.CrtYd")))`;
    const f = parseKicadPcb(miniBoard(body)).footprints[0];
    expect(f.side).toBe('back');
    // 4 × 2 の長方形を 45° 回すと外接矩形は (4 + 2) / √2 = 4.243 四方
    expect(mm(f.bbox.x1 - f.bbox.x0)).toBeCloseTo(6 / Math.SQRT2, 6);
    expect(mm(f.bbox.y1 - f.bbox.y0)).toBeCloseTo(6 / Math.SQRT2, 6);
  });

  it('余白を変えられる', () => {
    const b = parseKicadPcb(miniBoard(''), { marginMm: 2 });
    expect(mm(bboxOf(b.outline).x0)).toBeCloseTo(2, 9);
    expect(b.marginMm).toBe(2);
  });

  it('旧形式の gr_arc（中心・始点・角度）', () => {
    // 半径 5 の円弧 90° を 2 本の直線と合わせて閉じた形にする
    const b = parseKicadPcb(
      miniBoard(
        `(gr_arc (start 0 0) (end 5 0) (angle -90) (layer "Edge.Cuts")) (gr_line (start 0 -5) (end 0 0) (layer "Edge.Cuts")) (gr_line (start 0 0) (end 5 0) (layer "Edge.Cuts"))`,
        { outline: false },
      ),
    );
    // 扇形の面積 = π × 25 / 4
    expect(mm2(b.outline) / ((Math.PI * 25) / 4)).toBeGreaterThan(0.99);
    expect(b.warnings.filter((w) => w.includes('隙間'))).toEqual([]);
  });
});
