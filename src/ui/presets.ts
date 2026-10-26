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

/** 空のプロジェクト。格子は自動（autoGrid）。nx は手動に切り替えたときの初期値 */
function blank(name: string, wMm: number, hMm: number, nx: number, thicknessMm: number): Project {
  const p = defaultProject();
  p.name = name;
  p.domain = { width: mm(wMm), height: mm(hMm), nx, autoGrid: true };
  p.thickness = mm(thicknessMm);
  p.shapes = [];
  // 電磁波の点波源は、領域の左 1/4・中央の高さに置いておく
  p.em = { ...p.em, pointX: mm(wMm) * 0.25, pointY: mm(hMm) * 0.5 };
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

// ---------- 3b. ファンで冷やすヒートシンク（流れ＋熱） ----------

function fanHeatSink(): Project {
  // ダクト（上下は壁面）の中に、アルミのくし形ヒートシンクと、その根元（下）で発熱する部品を置く。風は左から右へ。
  // 2D の断面なので、フィンに直角に風が当たる向き（風はフィンの上を通り、フィンの間では渦を巻く）。
  // 格子は細いフィン（3 mm）が切れるよう手動で固定し、ダクトをふさぎすぎて流れが不安定にならないよう、格子上の流入速度は少し小さめにしている
  const p = blank('ファンで冷やすヒートシンク（8 W）', 130, 70, 200, 40);
  p.domain.autoGrid = false;
  const x0 = 35;
  const baseW = 56;
  const finW = 3;
  const fins = 4;
  const pitch = (baseW - finW) / (fins - 1);
  const shapes: Shape[] = [shape('solid', 'ベース', rectMm(x0, 26, baseW, 6), 'al6061')];
  for (let i = 0; i < fins; i++) shapes.push(shape('solid', `フィン ${i + 1}`, rectMm(x0 + i * pitch, 32, finW, 14), 'al6061'));
  shapes.push(shape('heatSource', '発熱する部品 (8 W)', rectMm(x0 + 13, 18, 30, 8), 'c1100', { heatW: 8, maxTempC: 85 }));
  p.shapes = shapes;
  p.flow = { fluidId: 'air', inletVelocity: 0.8, walls: 'noslip', thermal: { enabled: true, inletTempC: 25 }, advanced: { latticeU: 0.06 } };
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
  // 手計算との比較用に、格子は手動で固定する（梁の高さを 15 セルで切る）
  p.domain.autoGrid = false;
  p.shapes = [
    shape('solid', '梁 (A6061)', rectMm(30, 25, BEAM.L, BEAM.h), 'al6061'),
    shape('support', '固定端', rectMm(28, 20, 3, 20), 'al6061'),
    shape('load', `先端荷重 ${BEAM.P} N`, rectMm(229, 25, 3, BEAM.h), 'al6061', { force: { fx: 0, fy: -BEAM.P } }),
  ];
  return p;
}


// ---------- 8. レーダーカバー（24GHz・PLA） ----------

/** 垂直入射の平板がいちばん電波を通す厚みの目安: 媒質中の半波長 d = λ / (2√εr) [mm] */
export function halfWaveThicknessMm(ghz: number, epsR: number): number {
  return (299792458 / (ghz * 1e9) / (2 * Math.sqrt(epsR))) * 1000;
}

function radarCover(): Project {
  const p = blank('レーダーカバー（24GHz・PLA）', 120, 80, 320, 10);
  // PLA（εr 2.8）の半波長は約 3.7 mm。外周の吸収境界（PML）から離して、上下に余白を残す
  const t = 3.7;
  p.shapes = [shape('solid', 'PLA カバー (3.7 mm)', rectMm(50 - t / 2, 8, t, 64), 'pla')];
  p.em = { ...p.em, frequencyGHz: 24, source: 'plane', angleDeg: 0, polarization: 'TM', mediumId: 'air' };
  return p;
}

// ---------- 9. 金属板の反射とかげ ----------

function metalShadow(): Project {
  const p = blank('金属板の反射とかげ（10GHz）', 240, 160, 240, 10);
  // 高さ 70 mm のアルミ板が、左から来る電波の上半分を遮る。板の後ろに「かげ」、縁で回り込み（回折）が見える
  p.shapes = [shape('solid', 'アルミ板', rectMm(100, 45, 4, 70), 'al6061')];
  p.em = { ...p.em, frequencyGHz: 10, source: 'plane', angleDeg: 0, polarization: 'TM', mediumId: 'air' };
  return p;
}

// ---------- 10. Wi-Fi と部屋の壁 ----------

function wifiRoom(): Project {
  // 2.4 GHz の波長は空気中 125 mm、コンクリートの中では 53 mm。格子数には上限（横 500 セル）があるので、
  // 壁の中を 1 波長あたり 10 セル以上で切れる大きさ（領域の幅 2.6 m 以下）の小さめの部屋にしてある
  const p = blank('Wi-Fiと部屋の壁（2.4GHz）', 2600, 1900, 500, 10);
  const wall = 100;
  p.shapes = [
    shape('solid', '壁（下）', rectMm(100, 100, 2400, wall), 'concrete'),
    shape('solid', '壁（上）', rectMm(100, 1800 - wall, 2400, wall), 'concrete'),
    shape('solid', '壁（左）', rectMm(100, 100, wall, 1700), 'concrete'),
    // 右の壁には幅 900 mm の出入口があり、木のドアが半分だけ閉まっている
    shape('solid', '壁（右・下側）', rectMm(2400, 100, wall, 200), 'concrete'),
    shape('solid', '壁（右・上側）', rectMm(2400, 1200, wall, 600), 'concrete'),
    shape('solid', '木のドア', rectMm(2430, 300, 40, 450), 'wood'),
  ];
  p.em = { ...p.em, frequencyGHz: 2.4, source: 'point', pointX: mm(700), pointY: mm(950), polarization: 'TM', mediumId: 'air' };
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
    id: 'fan-heatsink',
    title: 'ファンで冷やすヒートシンク',
    description: 'ダクトの風（0.8 m/s）がアルミのフィンと 8 W の発熱部品を冷やします。風を強くすると部品が何℃下がるかを見ます（流れ＋温度。落ち着くまで数十秒）',
    analysis: 'flow',
    build: fanHeatSink,
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
    description: '長さ200mmの梁に先端100 N。手計算（たわみ約4.7mm、応力120MPa）と比べます（格子は手動で固定）',
    analysis: 'stress',
    build: cantilever,
  },
  {
    id: 'radar-cover',
    title: 'レーダーカバー（24GHz・PLA）',
    description: '3Dプリントのカバー越しに 24GHz の電波を当てます。厚み 3.7 mm はよく通り、1.9 mm にすると弱くなります',
    analysis: 'em',
    build: radarCover,
  },
  {
    id: 'metal-shadow',
    title: '金属板の反射とかげ',
    description: '10GHz の平面波をアルミ板が半分さえぎります。板の後ろの「かげ」と、縁での回り込みを見ます',
    analysis: 'em',
    build: metalShadow,
  },
  {
    id: 'wifi-room',
    title: 'Wi-Fiと部屋の壁',
    description: '2.4GHz の点波源（ルーター）をコンクリートの部屋に置きます。出入口と木のドアから電波が漏れる様子。小さめの部屋（内寸 2.2×1.5 m）で、壁の中は1波長あたり約10セルです',
    analysis: 'em',
    build: wifiRoom,
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
