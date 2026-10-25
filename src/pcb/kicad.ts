// KiCad の基板ファイル（.kicad_pcb）を読む。KiCad 6〜9 の形式が主で、KiCad 5 の形式（module など）も読める。
// 読み取りは Studio M 自前の実装で、KiCad のコードやファイルは使っていない（docs/oss-ledger.json 参照）。
//
// 出力の座標は Studio M の座標（メートル、y 上向き）。基板の外接矩形の左下が (marginMm, marginMm) に来るよう平行移動する。
import {
  bboxOf,
  chainPolylines,
  emptyBBox,
  growBBox,
  isEmptyBBox,
  makeTransform,
  pointInPolygon,
  polygonArea,
  rectPolygon,
  simplifyRing,
  type BBox,
  type Pt,
} from './geom';
import {
  arcTrackPolygon,
  copperGraphicPolygon,
  graphicPrim,
  layersOf,
  padInfo,
  segmentPolygon,
} from './kicad-items';
import { atomArgs, child, children, childNum, childStr, childXY, headOf, isList, numAt, parseSexpr, pointsOf, SexprError, strAt, type SList } from './sexpr';

export interface KicadFootprint {
  /** 部品番号（U1、R3 など）。読めなければ空文字 */
  reference: string;
  value: string;
  /** フットプリント名（ライブラリ名つき。例: Package_TO_SOT_SMD:SOT-223-3_TabPin2） */
  footprint: string;
  side: 'front' | 'back';
  /** 部品の原点 [m]（Studio M の座標） */
  x: number;
  y: number;
  /** 向き [度]。画面上で反時計回りが正（KiCad と同じ） */
  rotationDeg: number;
  /** 部品の占める範囲 [m]（回転を反映した外接矩形） */
  bbox: BBox;
  bboxSource: 'courtyard' | 'pads' | 'default';
  padCount: number;
  /** attr の中身（smd、through_hole、board_only、exclude_from_bom など） */
  attrs: string[];
}

export interface KicadCopperLayer {
  name: string;
  /** 銅箔の厚さ [µm] */
  thicknessUm: number;
  /** Studio M の座標（m）の多角形 */
  polygons: Pt[][];
}

export interface KicadBoard {
  version: number | null;
  generator: string;
  /** 基板の厚さ [mm] */
  thicknessMm: number;
  /** 外形（Studio M の座標 [m]）。外形が無ければ部品と銅箔の外接矩形 */
  outline: Pt[];
  /** 外形の中の切り抜き（取り付け穴など） */
  holes: Pt[][];
  layers: KicadCopperLayer[];
  footprints: KicadFootprint[];
  /** 外形の外接矩形 [m] */
  bbox: BBox;
  /** bbox の左下が置かれている余白 [mm]（領域の端から外形までの距離） */
  marginMm: number;
  /** 日本語の注意書き */
  warnings: string[];
}

export interface ParseOptions {
  /** 領域の端から基板の外形までの余白 [mm]。省略時 5 */
  marginMm?: number;
}

export class KicadParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KicadParseError';
  }
}

const DEFAULT_THICKNESS_MM = 1.6;
const DEFAULT_COPPER_UM = 35;
/** 銅箔の多角形を簡略化するときの許容誤差 [mm] */
const SIMPLIFY_TOL = 0.005;
/** 輪郭をつなぐときの端点の許容距離 [mm] */
const CHAIN_TOL = 0.001;
const PAD_MARGIN_MM = 0.25;
const DEFAULT_PART_MM = 2;

function isCopper(name: string): boolean {
  return /\.Cu$/.test(name);
}

/** 層名の並び順: F.Cu、In1.Cu…、B.Cu */
function copperOrder(name: string): number {
  if (name === 'F.Cu') return 0;
  if (name === 'B.Cu') return 1e6;
  const m = /^In(\d+)\.Cu$/.exec(name);
  return m ? Number(m[1]) : 1000;
}

interface Raw {
  copperNames: string[];
  polys: Map<string, Pt[][]>;
  edgeLines: Pt[][];
  edgeLoops: Pt[][];
  footprints: RawFootprint[];
  warnings: string[];
}

interface RawFootprint extends Omit<KicadFootprint, 'x' | 'y' | 'bbox'> {
  x: number;
  y: number;
  bbox: BBox;
}

export function parseKicadPcb(text: string, opts: ParseOptions = {}): KicadBoard {
  const marginMm = opts.marginMm ?? 5;
  let root: SList;
  try {
    root = parseSexpr(text);
  } catch (e) {
    if (e instanceof SexprError) throw new KicadParseError(`基板ファイルを読めませんでした（${e.message}）。KiCad から保存し直してみてください。`);
    throw e;
  }
  const head = headOf(root);
  if (head !== 'kicad_pcb') {
    const other = head === 'kicad_sch' ? '回路図' : head === 'kicad_pro' ? 'プロジェクト' : '';
    throw new KicadParseError(
      other ? `これは KiCad の${other}ファイルです。基板ファイル（.kicad_pcb）を選んでください。` : 'KiCad の基板ファイル（.kicad_pcb）ではないようです。',
    );
  }

  const warnings: string[] = [];
  const version = childNum(root, 'version', NaN);
  const generator = childStr(root, 'generator');

  // ---------- 基板の厚さと銅箔の層構成 ----------
  const general = child(root, 'general');
  let thicknessMm = general ? childNum(general, 'thickness', NaN) : NaN;
  const copperNames: string[] = [];
  for (const entry of (child(root, 'layers') ?? []).slice(1)) {
    if (isList(entry) && typeof entry[1] !== 'undefined') {
      const name = strAt(entry, 1);
      if (isCopper(name)) copperNames.push(name);
    }
  }
  const copperUm = new Map<string, number>();
  const stackup = child(child(root, 'setup') ?? ['setup'], 'stackup');
  let stackSum = 0;
  if (stackup) {
    for (const l of children(stackup, 'layer')) {
      const t = childNum(l, 'thickness', NaN);
      if (Number.isFinite(t)) stackSum += t;
      if (childStr(l, 'type') === 'copper' && Number.isFinite(t)) copperUm.set(strAt(l, 1), t * 1000);
    }
  }
  if (!(thicknessMm > 0)) {
    thicknessMm = stackSum > 0.2 ? stackSum : DEFAULT_THICKNESS_MM;
  }

  const raw: Raw = { copperNames, polys: new Map(), edgeLines: [], edgeLoops: [], footprints: [], warnings };
  const allCopper = (): string[] => (raw.copperNames.length ? raw.copperNames : ['F.Cu', 'B.Cu']);
  const expand = (names: string[]): string[] => {
    const out = new Set<string>();
    for (const n of names) {
      if (n === '*.Cu') allCopper().forEach((c) => out.add(c));
      else if (n === 'F&B.Cu') ['F.Cu', 'B.Cu'].forEach((c) => out.add(c));
      else if (isCopper(n)) out.add(n);
    }
    return [...out];
  };
  const addCopper = (names: string[], poly: Pt[]): void => {
    for (const name of expand(names)) {
      const list = raw.polys.get(name) ?? [];
      list.push(poly);
      raw.polys.set(name, list);
    }
  };
  const identity = (p: Pt): Pt => p;

  // ---------- 基板直下の図形・配線・ビア・ゾーン ----------
  let unfilledZones = 0;
  let legacy = false;
  for (const node of root.slice(1)) {
    if (!isList(node)) continue;
    const h = headOf(node);
    if (h.startsWith('gr_')) {
      const layer = childStr(node, 'layer');
      if (layer === 'Edge.Cuts') {
        const prim = graphicPrim(node, identity);
        if (prim) (prim.closed ? raw.edgeLoops : raw.edgeLines).push(prim.pts);
      } else if (isCopper(layer)) {
        const poly = copperGraphicPolygon(node, identity);
        if (poly) addCopper([layer], poly);
      }
    } else if (h === 'segment') {
      const poly = segmentPolygon(node);
      if (poly) addCopper(layersOf(node), poly);
    } else if (h === 'arc') {
      const poly = arcTrackPolygon(node);
      if (poly) addCopper(layersOf(node), poly);
    } else if (h === 'via') {
      const at = childXY(node, 'at');
      const size = childNum(node, 'size', NaN);
      if (at && size > 0) addCopper(viaLayers(layersOf(node), allCopper()), circle(at, size / 2));
    } else if (h === 'zone') {
      if (!readZone(node, addCopper)) unfilledZones++;
    } else if (h === 'footprint' || h === 'module') {
      if (h === 'module') legacy = true;
      const fp = readFootprint(node, raw, addCopper);
      if (fp) raw.footprints.push(fp);
    }
  }
  if (legacy) warnings.push('旧形式（KiCad 5 以前）の基板ファイルとして読みました。うまく読めない部分があれば、新しい KiCad で開いて保存し直してください。');
  if (unfilledZones > 0) {
    warnings.push(`塗りつぶされていないゾーンが ${unfilledZones} 個あります（銅箔として数えません）。KiCad で「ゾーンを塗りつぶし」（B キー）を実行して保存し直してください。`);
  }

  // ---------- 外形 ----------
  const { outer, holes } = buildOutline(raw);
  let outlineMm = outer;
  if (!outlineMm) {
    const bb = emptyBBox();
    for (const list of raw.polys.values()) for (const p of list) bboxOf(p, bb);
    for (const f of raw.footprints) {
      growBBox(bb, f.bbox.x0, f.bbox.y0);
      growBBox(bb, f.bbox.x1, f.bbox.y1);
    }
    if (isEmptyBBox(bb)) throw new KicadParseError('基板の外形（Edge.Cuts）も部品も見つかりませんでした。KiCad で外形を描いてから保存してください。');
    const m = 2;
    outlineMm = rectPolygon((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2, bb.x1 - bb.x0 + 2 * m, bb.y1 - bb.y0 + 2 * m);
    warnings.push('基板の外形（Edge.Cuts の閉じた線）が見つかりません。部品と銅箔を囲む四角を外形にしました。KiCad で外形を描くと正確になります。');
  }

  // ---------- 座標を Studio M の座標へ ----------
  const ob = bboxOf(outlineMm);
  const conv = ([x, y]: Pt): Pt => [(x - ob.x0 + marginMm) * 1e-3, (ob.y1 - y + marginMm) * 1e-3];
  const convBox = (b: BBox): BBox => {
    const [x0, y0] = conv([b.x0, b.y1]);
    const [x1, y1] = conv([b.x1, b.y0]);
    return { x0, y0, x1, y1 };
  };

  const names = [...new Set([...raw.copperNames, ...raw.polys.keys()])].sort((a, b) => copperOrder(a) - copperOrder(b));
  const layers: KicadCopperLayer[] = [];
  for (const name of names) {
    const list = raw.polys.get(name);
    if (!list?.length) continue;
    layers.push({ name, thicknessUm: copperUm.get(name) ?? DEFAULT_COPPER_UM, polygons: list.map((p) => p.map(conv)) });
  }
  if (layers.length === 0) warnings.push('銅箔（配線・ベタ・パッド）が見つかりませんでした。基板は FR-4 だけとして扱います。');

  const footprints: KicadFootprint[] = raw.footprints.map((f) => {
    const [x, y] = conv([f.x, f.y]);
    return { ...f, x, y, bbox: convBox(f.bbox) };
  });
  const bbox = convBox(ob);
  const widthMm = (bbox.x1 - bbox.x0) * 1e3;
  const heightMm = (bbox.y1 - bbox.y0) * 1e3;
  if (Math.max(widthMm, heightMm) > 500) warnings.push(`基板がとても大きい（${Math.round(widthMm)} × ${Math.round(heightMm)} mm）ため、格子が粗くなります。`);

  return {
    version: Number.isFinite(version) ? version : null,
    generator,
    thicknessMm,
    outline: outlineMm.map(conv),
    holes: holes.map((h) => h.map(conv)),
    layers,
    footprints,
    bbox,
    marginMm,
    warnings,
  };
}

function circle(c: Pt, r: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 12; i++) out.push([c[0] + r * Math.cos((2 * Math.PI * i) / 12), c[1] + r * Math.sin((2 * Math.PI * i) / 12)]);
  return out;
}

/** ビアがつなぐ銅箔の層。layers の最初と最後の間にあるものをすべて使う（普通のビアは全層） */
function viaLayers(layers: string[], all: string[]): string[] {
  const cu = layers.filter(isCopper);
  if (cu.length < 2) return all;
  const sorted = [...all].sort((a, b) => copperOrder(a) - copperOrder(b));
  const i0 = sorted.indexOf(cu[0]);
  const i1 = sorted.indexOf(cu[cu.length - 1]);
  if (i0 < 0 || i1 < 0) return cu;
  return sorted.slice(Math.min(i0, i1), Math.max(i0, i1) + 1);
}

/**
 * ゾーンの塗りつぶし結果（filled_polygon）を銅箔にする。
 * 戻り値は「銅箔として使えたか（またはキープアウトなど最初から銅箔でないか）」
 */
function readZone(zone: SList, add: (names: string[], poly: Pt[]) => void): boolean {
  if (child(zone, 'keepout')) return true;
  const zoneLayers = layersOf(zone);
  let found = false;
  for (const fp of children(zone, 'filled_polygon')) {
    const pts = pointsOf(fp);
    if (pts.length < 3) continue;
    // KiCad 6 以降の filled_polygon は自分の層を持つ。KiCad 5 はゾーンの層を使う
    const own = layersOf(fp);
    add(own.length ? own : zoneLayers, simplifyRing(pts, SIMPLIFY_TOL));
    found = true;
  }
  return found;
}

function readFootprint(fp: SList, raw: Raw, addCopper: (names: string[], poly: Pt[]) => void): RawFootprint | null {
  const at = child(fp, 'at');
  const x = numAt(at, 1, 0);
  const y = numAt(at, 2, 0);
  const rot = numAt(at, 3, 0);
  const tf = makeTransform(x, y, rot);
  const side = childStr(fp, 'layer') === 'B.Cu' ? 'back' : 'front';

  let reference = '';
  let value = '';
  for (const p of children(fp, 'property')) {
    const key = strAt(p, 1);
    if (key === 'Reference') reference = strAt(p, 2);
    else if (key === 'Value') value = strAt(p, 2);
  }
  for (const t of children(fp, 'fp_text')) {
    const kind = strAt(t, 1);
    if (kind === 'reference' && !reference) reference = strAt(t, 2);
    else if (kind === 'value' && !value) value = strAt(t, 2);
  }

  // 部品の範囲: クーリアード（部品の占有範囲の線）→ パッド → 2 mm 角
  const court = emptyBBox();
  const padBox = emptyBBox();
  let padCount = 0;
  for (const node of fp.slice(1)) {
    if (!isList(node)) continue;
    const h = headOf(node);
    if (h === 'pad') {
      const info = padInfo(node, { x, y, rot });
      if (!info) continue;
      padCount++;
      bboxOf(info.polygon, padBox);
      if (info.type !== 'np_thru_hole') addCopper(info.layers, info.polygon);
    } else if (h.startsWith('fp_')) {
      const layer = childStr(node, 'layer');
      if (layer === 'F.CrtYd' || layer === 'B.CrtYd') {
        const prim = graphicPrim(node, tf);
        if (prim) bboxOf(prim.pts, court);
      } else if (layer === 'Edge.Cuts') {
        const prim = graphicPrim(node, tf);
        if (prim) (prim.closed ? raw.edgeLoops : raw.edgeLines).push(prim.pts);
      } else if (isCopper(layer)) {
        const poly = copperGraphicPolygon(node, tf);
        if (poly) addCopper([layer], poly);
      }
    }
  }

  let bbox: BBox;
  let bboxSource: RawFootprint['bboxSource'];
  if (!isEmptyBBox(court) && court.x1 - court.x0 > 0 && court.y1 - court.y0 > 0) {
    bbox = court;
    bboxSource = 'courtyard';
  } else if (!isEmptyBBox(padBox)) {
    bbox = { x0: padBox.x0 - PAD_MARGIN_MM, y0: padBox.y0 - PAD_MARGIN_MM, x1: padBox.x1 + PAD_MARGIN_MM, y1: padBox.y1 + PAD_MARGIN_MM };
    bboxSource = 'pads';
  } else {
    const r = DEFAULT_PART_MM / 2;
    bbox = { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
    bboxSource = 'default';
  }

  const attrNode = child(fp, 'attr');
  return {
    reference,
    value,
    footprint: strAt(fp, 1),
    side,
    x,
    y,
    rotationDeg: ((rot % 360) + 360) % 360,
    bbox,
    bboxSource,
    padCount,
    attrs: attrNode ? atomArgs(attrNode) : [],
  };
}

/** Edge.Cuts の線をつないで、最大の輪郭を外形、その内側の輪郭を切り抜きにする */
function buildOutline(raw: Raw): { outer: Pt[] | null; holes: Pt[][] } {
  const { closed, open } = chainPolylines(raw.edgeLines, CHAIN_TOL);
  const loops = [...raw.edgeLoops, ...closed].filter((l) => l.length >= 3 && polygonArea(l) > 1e-6);
  if (open.length > 0) {
    const gap = open.length === 1 ? 'つながっていない線が 1 本' : `つながっていない線が ${open.length} 本`;
    raw.warnings.push(`基板の外形に隙間があります（${gap}あります）。KiCad で端点をつなぐと正確になります。`);
  }
  if (loops.length === 0) {
    // 隙間のある線の外接矩形は信用しにくいので外形なしとして扱う
    return { outer: null, holes: [] };
  }
  loops.sort((a, b) => polygonArea(b) - polygonArea(a));
  const outer = loops[0];
  const holes: Pt[][] = [];
  let outside = 0;
  for (const l of loops.slice(1)) {
    if (pointInPolygon(l[0], outer)) holes.push(l);
    else outside++;
  }
  if (outside > 0) raw.warnings.push(`外形の外にも輪郭が ${outside} 個あります（面付けや図面枠かもしれません）。最大の外形だけを取り込みました。`);
  return { outer, holes };
}
