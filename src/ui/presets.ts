// すぐ試せるプリセット。どれも実寸（mm スケールの部品、m スケールの流れ）で、
// 役割（solid / heatSource / hole / support / load）を実際の使い方どおりに置く。
import { getMaterial } from '../core/materials';
import { defaultProject } from '../core/project';
import type { AnalysisKind, Project, Shape, ShapeGeom, ShapeRole } from '../core/types';
import { nacaAirfoil } from './airfoil';
import type { Pt } from './geometry';

export { nacaAirfoil } from './airfoil';

export interface Preset {
  id: string;
  title: string;
  /** ドロップダウンに出す一行説明 */
  description: string;
  /** 開いたときに選ぶ解析タブ */
  analysis: AnalysisKind;
  build: () => Project;
}

const mm = (v: number): number => v / 1000;

function blank(name: string, wMm: number, hMm: number, nx: number, thicknessMm: number): Project {
  const p = defaultProject();
  p.name = name;
  p.domain = { width: mm(wMm), height: mm(hMm), nx };
  p.thickness = mm(thicknessMm);
  p.shapes = [];
  return p;
}

let seq = 0;
function shape(role: ShapeRole, name: string, geom: ShapeGeom, materialId: string, extra: Partial<Shape> = {}): Shape {
  seq += 1;
  return { id: `p${seq}`, name, role, geom, materialId, ...extra };
}

/** mm 指定の長方形（左下の角と大きさ） */
const rectMm = (x: number, y: number, w: number, h: number): ShapeGeom => ({ kind: 'rect', x: mm(x), y: mm(y), w: mm(w), h: mm(h) });
const circleMm = (cx: number, cy: number, r: number): ShapeGeom => ({ kind: 'circle', cx: mm(cx), cy: mm(cy), r: mm(r) });
const polyMm = (pts: Pt[]): ShapeGeom => ({ kind: 'polygon', points: pts.map(([x, y]): Pt => [mm(x), mm(y)]) });

// ---------- 1. 四角柱まわりの流れ（動画の再現） ----------

function squareColumn(): Project {
  const p = defaultProject();
  p.scalar = { u: 1, gamma: 0.1, rho: 1, phiInlet: 1, phiBody: 0 };
  return p;
}

// ---------- 2. 円柱のカルマン渦 ----------

function karmanVortex(): Project {
  const D = 0.032; // 円柱の直径 [m]
  const Re = 150;
  const nu = getMaterial('air').viscosity ?? 1.516e-5;
  const p = blank('円柱のカルマン渦', 640, 240, 320, 10);
  // 円柱をわずかに上へずらして、左右対称が崩れて渦が出やすくする
  p.shapes = [shape('solid', '円柱', { kind: 'circle', cx: 0.12, cy: 0.1215, r: D / 2 }, 'pla')];
  p.flow = { fluidId: 'air', inletVelocity: Number(((Re * nu) / D).toPrecision(3)), walls: 'slip' };
  return p;
}

// ---------- 3. 翼型 ----------

function airfoil(): Project {
  const p = blank('翼型（NACA 0012, 迎角 8°）', 800, 400, 320, 10);
  const pts = nacaAirfoil('0012', 0.2, 8, 0.2, 0.215, 40);
  p.shapes = [shape('solid', 'NACA 0012', { kind: 'polygon', points: pts }, 'abs')];
  p.flow = { fluidId: 'air', inletVelocity: 0.2, walls: 'slip' };
  return p;
}

// ---------- 4. ヒートシンク ----------

function heatSink(): Project {
  const p = blank('ヒートシンク（10 W）', 100, 70, 200, 40);
  const shapes: Shape[] = [shape('solid', 'ベース', rectMm(20, 16, 60, 6), 'al6061')];
  const finW = 3;
  const fins = 7;
  const pitch = (60 - finW) / (fins - 1);
  for (let i = 0; i < fins; i++) shapes.push(shape('solid', `フィン ${i + 1}`, rectMm(20 + i * pitch, 22, finW, 35), 'al6061'));
  shapes.push(shape('heatSource', '発熱体 (10 W)', rectMm(35, 8, 30, 8), 'c1100', { heatW: 10 }));
  p.shapes = shapes;
  p.heat = { ...p.heat, ambientC: 25, surfaceH: 10, faceCooling: true };
  return p;
}

// ---------- 5. 電子基板の発熱 ----------

function circuitBoard(): Project {
  const p = blank('電子基板の発熱', 100, 70, 200, 1.6);
  // 銅パッドは簡略化のため、板の厚さ全体が銅のモデル（実物の銅箔は 35 µm 程度）
  p.shapes = [
    shape('solid', '基板 (FR-4)', rectMm(10, 10, 80, 50), 'fr4'),
    shape('solid', '銅パッド（CPU 下）', rectMm(17, 21, 20, 20), 'c1100'),
    shape('solid', '銅パッド（レギュレータ下）', rectMm(52, 37, 14, 12), 'c1100'),
    shape('solid', '銅パッド（ドライバ下）', rectMm(68, 18, 10, 10), 'c1100'),
    shape('heatSource', 'CPU (1.5 W)', rectMm(21, 25, 12, 12), 'al6061', { heatW: 1.5 }),
    shape('heatSource', 'レギュレータ (0.5 W)', rectMm(55, 40, 8, 6), 'al6061', { heatW: 0.5 }),
    shape('heatSource', 'LED ドライバ (0.2 W)', rectMm(70, 20, 6, 6), 'al6061', { heatW: 0.2 }),
  ];
  p.heat = { ...p.heat, ambientC: 25, surfaceH: 10, faceCooling: true };
  return p;
}

// ---------- 6. L字ブラケット ----------

/** 内角に半径 r の丸み（フィレット）を付けた L 字の輪郭 [mm] */
function lBracketOutline(): Pt[] {
  const r = 6;
  const cx = 27 + r; // 丸みの中心（内角 (27, 65) から内側へ r）
  const cy = 65 - r;
  const pts: Pt[] = [
    [15, 15],
    [27, 15],
    [27, cy],
  ];
  for (let k = 1; k <= 5; k++) {
    const a = Math.PI - ((Math.PI / 2) * k) / 6;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  pts.push([cx, 65], [80, 65], [80, 75], [15, 75]);
  return pts;
}

function lBracket(): Project {
  const p = blank('L字ブラケット（PLA）', 100, 90, 160, 10);
  p.shapes = [
    shape('solid', 'L字ブラケット', polyMm(lBracketOutline()), 'pla'),
    shape('hole', 'ボルト穴', circleMm(21, 38, 2.5), 'pla'),
    shape('support', '壁側の面（固定）', rectMm(14, 15, 2, 60), 'pla'),
    shape('load', '荷重 50 N（下向き）', rectMm(76, 65, 4, 10), 'pla', { force: { fx: 0, fy: -50 } }),
  ];
  return p;
}

// ---------- 7. 片持ち梁 ----------

const BEAM = { L: 200, h: 10, b: 10, P: 100 }; // 長さ・高さ・奥行き [mm]、先端荷重 [N]

/** 手計算の値: 先端たわみ δ = PL³/(3EI)、根元の最大応力 σ = 6PL/(b h²) */
export function beamHandCalc(): { deflectionMm: number; stressMPa: number } {
  const al = getMaterial('al6061');
  const L = mm(BEAM.L);
  const h = mm(BEAM.h);
  const b = mm(BEAM.b);
  const I = (b * h ** 3) / 12;
  return {
    deflectionMm: ((BEAM.P * L ** 3) / (3 * (al.E ?? 1) * I)) * 1000,
    stressMPa: (6 * BEAM.P * L) / (b * h * h) / 1e6,
  };
}

function cantilever(): Project {
  const p = blank('片持ち梁（アルミ）', 240, 60, 360, BEAM.b);
  p.shapes = [
    shape('solid', '梁 (A6061)', rectMm(30, 25, BEAM.L, BEAM.h), 'al6061'),
    shape('support', '固定端', rectMm(28, 20, 3, 20), 'al6061'),
    shape('load', `先端荷重 ${BEAM.P} N`, rectMm(229, 25, 3, BEAM.h), 'al6061', { force: { fx: 0, fy: -BEAM.P } }),
  ];
  return p;
}

export const PRESETS: Preset[] = [
  {
    id: 'square-column',
    title: '四角柱まわりの流れ（動画の再現）',
    description: '動画と同じ設定。流れと対流拡散（Excel式）の両方を試せます',
    analysis: 'scalar',
    build: squareColumn,
  },
  {
    id: 'karman',
    title: '円柱のカルマン渦',
    description: '空気中の円柱、Re≈150。後ろに渦が交互にできる様子を見ます',
    analysis: 'flow',
    build: karmanVortex,
  },
  {
    id: 'naca0012',
    title: '翼型（NACA 0012, 迎角 8°）',
    description: '対称翼型を8度傾けた流れ。上面の速い流れと渦度を見ます',
    analysis: 'flow',
    build: airfoil,
  },
  {
    id: 'heatsink',
    title: 'ヒートシンク',
    description: 'アルミのフィン7枚 + 10 W の発熱体。自然対流での温度上昇を見ます',
    analysis: 'heat',
    build: heatSink,
  },
  {
    id: 'board',
    title: '電子基板の発熱',
    description: 'FR-4 基板に3つのチップ（1.5 W / 0.5 W / 0.2 W）。銅パッドの放熱効果を比べます',
    analysis: 'heat',
    build: circuitBoard,
  },
  {
    id: 'l-bracket',
    title: 'L字ブラケット（PLA, 3Dプリント）',
    description: '壁に固定して先端に 50 N。内角の丸みとボルト穴まわりの応力を見ます',
    analysis: 'stress',
    build: lBracket,
  },
  {
    id: 'cantilever',
    title: '片持ち梁（アルミ）',
    description: '長さ200mmの梁に先端100 N。手計算（たわみ約4.7mm、応力120MPa）と比べます',
    analysis: 'stress',
    build: cantilever,
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
