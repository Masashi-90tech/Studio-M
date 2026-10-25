// 強度（片持ち梁）の式。荷重・支持・物体の形から P, L, h を取り出して、梁理論の手計算を出す。
// 梁理論は 2D FEM の近似（細長い梁で、荷重が先端に集中するときによく合う）。
import type { Project, Shape } from '../../core/types';
import { formatPow, formatSig, formatSub, formatValue } from '../format';
import { powerInsight, ratioInsight } from '../insight';
import { topic } from '../topics';
import type { Formula, MathProvider } from '../types';
import { bodiesBox, boxOf, byRole, centerOf, mathVar, primaryMaterial, scalarOf, sectionLength, type Box } from './common';

/** 梁として読み取った寸法と材料 */
export interface BeamParams {
  /** 荷重 [N]（load の |fy| の合計。fy が 0 なら力の大きさの合計） */
  P: number;
  /** 固定端から荷重までの長さ [m] */
  L: number;
  /** 梁の高さ（曲げる向きの厚み）[m]。長さの真ん中の断面から測る */
  h: number;
  /** 奥行き（project.thickness）[m] */
  t: number;
  E: number;
  sigmaY: number;
  materialName: string;
  /** 荷重と支持が両方あって、形から読み取れた */
  fromShapes: boolean;
  /** 梁が伸びる向き */
  axis: 'x' | 'y';
}

const range = (b: Box, axis: 'x' | 'y'): [number, number] => (axis === 'x' ? [b.x0, b.x1] : [b.y0, b.y1]);

function loadMagnitude(loads: Shape[]): number {
  const fy = loads.reduce((a, s) => a + Math.abs(s.force?.fy ?? 0), 0);
  if (fy > 0) return fy;
  return loads.reduce((a, s) => a + Math.hypot(s.force?.fx ?? 0, s.force?.fy ?? 0), 0);
}

/**
 * プロジェクトから梁の寸法を読み取る。
 * - 梁の向き: 支持の中心から荷重の中心へ向かう方向（x か y のうち遠い方）
 * - 固定端: 支持が物体の端に接していれば物体の端、そうでなければ支持の荷重側の縁
 * - 荷重の位置: 荷重が物体の先端に届いていれば先端、そうでなければ荷重の中心
 * - 高さ h: 固定端と荷重の真ん中の断面で、物体がある長さの合計
 */
export function beamParams(project: Project): BeamParams {
  const mat = primaryMaterial(project, 'al6061');
  const E = mat.E ?? 70e9;
  const sigmaY = mat.yield ?? 100e6;
  const t = project.thickness > 0 ? project.thickness : 0.01;
  const loads = byRole(project, 'load');
  const supports = byRole(project, 'support');
  const body = bodiesBox(project);
  let P = loadMagnitude(loads);
  const base = { E, sigmaY, t, materialName: mat.name };

  if (!body) return { ...base, P: P > 0 ? P : 10, L: 0.1, h: 0.01, fromShapes: false, axis: 'x' };
  const w = body.x1 - body.x0;
  const hh = body.y1 - body.y0;
  const fallbackAxis: 'x' | 'y' = w >= hh ? 'x' : 'y';
  const fallback: BeamParams = {
    ...base,
    P: P > 0 ? P : 10,
    L: Math.max(w, hh),
    h: Math.min(w, hh),
    fromShapes: false,
    axis: fallbackAxis,
  };
  if (loads.length === 0 || supports.length === 0 || !(P > 0)) return fallback;

  const sup = supports.map((s) => boxOf(s.geom));
  const lod = loads.map((s) => boxOf(s.geom));
  const union = (list: Box[]): Box => ({
    x0: Math.min(...list.map((b) => b.x0)),
    y0: Math.min(...list.map((b) => b.y0)),
    x1: Math.max(...list.map((b) => b.x1)),
    y1: Math.max(...list.map((b) => b.y1)),
  });
  const sb = union(sup);
  const lb = union(lod);
  const cs = centerOf(sb);
  const cl = centerOf(lb);
  const axis: 'x' | 'y' = Math.abs(cl.x - cs.x) >= Math.abs(cl.y - cs.y) ? 'x' : 'y';
  const dir = (axis === 'x' ? cl.x - cs.x : cl.y - cs.y) >= 0 ? 1 : -1;
  const [a0, a1] = range(body, axis);
  const ext = a1 - a0;
  const [s0, s1] = range(sb, axis);
  const [l0, l1] = range(lb, axis);
  const eps = ext * 0.02;

  // 固定端（荷重から遠い側の物体の端、または支持の荷重側の縁）
  let fixed: number;
  let tip: number;
  if (dir > 0) {
    const lo = Math.max(s0, a0);
    fixed = lo - a0 <= eps ? a0 : Math.min(s1, a1);
    tip = l1 >= a1 - eps ? a1 : (l0 + l1) / 2;
  } else {
    const hi = Math.min(s1, a1);
    fixed = a1 - hi <= eps ? a1 : Math.max(s0, a0);
    tip = l0 <= a0 + eps ? a0 : (l0 + l1) / 2;
  }
  const L = Math.abs(tip - fixed);
  if (!(L > 0)) return fallback;

  const mid = (fixed + tip) / 2;
  // 梁の向きが x なら縦の線 x = mid の断面、y なら横の線 y = mid の断面
  let h = sectionLength(project, axis, mid);
  if (!(h > 0)) h = axis === 'x' ? hh : w;
  P = P > 0 ? P : 10;
  return { ...base, P, L, h, t, fromShapes: true, axis };
}

const I_OF = (t: number, h: number): number => (t * h ** 3) / 12;

const SECOND_MOMENT_WHY = {
  question: 'なぜ高さ h が 3 乗で効くの？',
  answer:
    '曲げに強いのは「材料が真ん中から遠くにあること」です。高さを 2 倍にすると、①材料の量が 2 倍、②その材料が真ん中から 2 倍遠くなる（てこの腕が 2 倍）、' +
    '③遠くにある材料ほど、曲がりに逆らう力も 2 倍になる。この 3 つが掛け算で効いて 2 × 2 × 2 = 8 倍。定規を立てると曲がらないのに、寝かせるとぐにゃっと曲がるのはこのためです。',
};

export const stressProvider: MathProvider = {
  kind: 'stress',
  formulas({ project, result }) {
    const b = beamParams(project);
    const I0 = I_OF(b.t, b.h);
    const sigma0 = (6 * b.P * b.L) / (b.t * b.h * b.h);
    const maxDisp = scalarOf(result, 'maxDisplacement');
    const maxVm = scalarOf(result, 'maxVonMises');
    const minSafety = scalarOf(result, 'minSafety');
    const note = b.fromShapes
      ? `荷重 ${formatValue(b.P, 'N')}、固定端から荷重まで ${formatValue(b.L, 'm')}、梁の高さ ${formatValue(b.h, 'm')} は、形から読み取った目安です。`
      : '荷重・支持が見つからないので、物体の大きさから仮の値を入れています。';
    const beamApprox =
      `${note} 梁理論は細長い梁の近似です。2D の FEM は固定端の拘束や荷重の面積ぶんだけ、少し違う値になります。`;

    const vP = mathVar({ key: 'P', symbol: 'P', label: '先端の荷重', unit: 'N', value: b.P, source: '荷重の合計' });
    const vL = mathVar({ key: 'L', symbol: 'L', label: '梁の長さ', unit: 'm', value: b.L, source: '固定端から荷重まで' });
    const vE = mathVar({ key: 'E', symbol: 'E', label: '縦弾性係数（硬さ）', unit: 'Pa', value: b.E, min: 1e9, max: 4e11, log: true, source: b.materialName });
    const vT = mathVar({ key: 't', symbol: 't', label: '奥行き', unit: 'm', value: b.t, source: '解析の奥行き' });
    const vH = mathVar({ key: 'h', symbol: 'h', label: '梁の高さ', unit: 'm', value: b.h, source: '梁の真ん中の断面' });

    // ---- フックの法則 ----
    const strain0 = sigma0 / b.E;
    const hooke: Formula = {
      id: 'stress-hooke',
      title: 'フックの法則（伸びと力は比例する）',
      expression: 'σ = E · ε',
      vars: [
        mathVar({ key: 'E', symbol: 'E', label: '縦弾性係数（硬さ）', unit: 'Pa', value: b.E, min: 1e9, max: 4e11, log: true, source: b.materialName }),
        mathVar({
          key: 'eps',
          symbol: 'ε',
          label: 'ひずみ（伸びの割合）',
          unit: '',
          value: strain0,
          display: (v) => `${formatSig(v * 100)} %`,
          source: '梁の根元の表面（σ ÷ E）',
        }),
      ],
      resultSymbol: 'σ',
      resultLabel: '応力（材料の中の力の強さ）',
      resultUnit: 'Pa',
      evaluate: (v) => v.E * v.eps,
      substituted: (v) => `= ${formatSub(v.E)} × ${formatSub(v.eps)}`,
      steps: [
        '輪ゴムやバネを引っぱると、伸びた量は引く力に比例します（2 倍引けば 2 倍伸びる）。',
        '材料の中でも同じで、「伸びの割合 ε（元の長さに対して何 % 伸びたか）」と「力の強さ σ（1 m² あたり何 N か）」は比例します。',
        'その比例の傾きが E（縦弾性係数）。E が大きい材料ほど、少し伸ばすだけで大きな力が出る＝硬い材料です。',
        'y = a·x の形の式なので、グラフにすると原点を通る直線です。傾きが E です。',
      ],
      insight: powerInsight('σ', [
        { key: 'E', symbol: 'E', exp: 1 },
        { key: 'eps', symbol: 'ε', exp: 1 },
      ]),
      topics: [topic('比例・一次関数', '中学')],
      why: [
        {
          question: 'ひずみ ε に単位がないのはなぜ？',
          answer: 'ε = 伸びた長さ ÷ 元の長さ なので、m ÷ m で単位が消えます。100 mm の棒が 0.1 mm 伸びれば ε = 0.001（0.1 %）。長さの単位に関係なく同じ数になるのが便利な点です。',
        },
        {
          question: '樹脂（PLA）は金属よりなぜ曲がりやすい？',
          answer: 'E がちがうからです。PLA は約 3.5 GPa、アルミは約 69 GPa で、アルミのほうが約 20 倍硬い。同じ力なら PLA は約 20 倍伸びます。スライダーで E を動かして確かめてみましょう。',
        },
      ],
      approx: '力と伸びが比例するのは、ゴムのように戻る範囲（弾性域）だけです。降伏応力を超えると、直線からはずれて元に戻らなくなります。',
    };

    // ---- 断面二次モーメント ----
    const second: Formula = {
      id: 'stress-inertia',
      title: '断面二次モーメント（曲がりにくさの形の効果）',
      expression: 'I = t · h³ / 12',
      vars: [vT, vH],
      resultSymbol: 'I',
      resultLabel: '断面二次モーメント',
      resultUnit: 'm⁴',
      evaluate: (v) => I_OF(v.t, v.h),
      substituted: (v) => `= ${formatSub(v.t)} × ${formatPow(v.h, 3)} / 12`,
      steps: [
        '同じ材料でも、断面の形で曲がりにくさは大きく変わります。それを 1 つの数にしたのが I です。',
        '長方形（奥行き t、高さ h）の断面では I = t·h³/12。',
        '高さ h が 3 乗で効くので、少し厚くするだけで曲がりにくさが大きく上がります。',
      ],
      insight: powerInsight('I', [
        { key: 't', symbol: 't', exp: 1 },
        { key: 'h', symbol: 'h', exp: 3 },
      ]),
      topics: [topic('指数・対数', '高校'), topic('積分', '大学')],
      why: [
        SECOND_MOMENT_WHY,
        {
          question: 'なぜ 12 で割るの？',
          answer: 'I は「断面の小さな欠片 × （真ん中からの距離）²」を全部足したものです。この足し算（積分）を長方形でやると h³/3 が出て、真ん中を基準にすると 1/12 になります。大学の積分で出てくる ∫y² dy の結果です。',
        },
      ],
      approx: '長方形の断面だけの式です。穴のある断面や L 字・H 形の断面は、別の式になります。',
    };

    // ---- たわみ ----
    const deflection: Formula = {
      id: 'stress-deflection',
      title: '片持ち梁の先端のたわみ',
      expression: 'δ = P · L³ / (3 · E · I)   （I = t · h³ / 12）',
      vars: [vP, vL, vE, vT, vH],
      resultSymbol: 'δ',
      resultLabel: '先端のたわみ',
      resultUnit: 'm',
      evaluate: (v) => (v.P * v.L ** 3) / (3 * v.E * I_OF(v.t, v.h)),
      substituted: (v) => `= ${formatSub(v.P)} × ${formatPow(v.L, 3)} / (3 × ${formatSub(v.E)} × ${formatSub(I_OF(v.t, v.h))})`,
      steps: [
        '壁に固定した梁の先に力 P をかけると、梁は曲がって先端が δ だけ下がります。',
        '力 P が 2 倍なら δ も 2 倍（比例）。これはフックの法則と同じ考え方です。',
        '梁の長さ L は 3 乗で効きます。長さが 2 倍なら δ は 8 倍。',
        '硬さ E と断面の形 I は分母です。大きいほど曲がりにくい。I は I = t·h³/12 で、高さ h が 3 乗で効きます。',
        '細かい係数「3」は、梁の曲がりを根元から先端まで足し合わせた（積分した）結果です。',
      ],
      insight: powerInsight('δ', [
        { key: 'P', symbol: 'P', exp: 1 },
        { key: 'L', symbol: 'L', exp: 3 },
        { key: 'E', symbol: 'E', exp: -1 },
        { key: 't', symbol: 't', exp: -1 },
        { key: 'h', symbol: 'h', exp: -3 },
      ]),
      topics: [topic('比例・一次関数', '中学'), topic('指数・対数', '高校'), topic('積分', '大学')],
      why: [
        {
          question: 'なぜ長さ L が 3 乗なの？',
          answer:
            '長い梁には、3 つの効果が重なります。①力の「てこの腕」が長くなり、根元の曲げの強さが L 倍になる。②その曲がりが続く距離も L 倍になる。' +
            '③先端の下がり量は「曲がった角度 × 先端までの距離」なので、さらに L 倍。L × L × L で 3 乗です。机から定規を突き出すとき、少し長く出すだけでぐにゃっと下がるのはこのためです。',
        },
        SECOND_MOMENT_WHY,
        {
          question: 'なぜ分母に 3 が出てくるの？',
          answer: '曲げの強さは根元で最大、先端でゼロの三角形のように減っていきます。それを 2 回足し合わせる（積分する）と、x² を 0 から L まで足した L³/3 が出てきます。この 1/3 が係数の 3 の正体です。',
        },
      ],
      approx: beamApprox,
      simulation: maxDisp !== undefined ? { label: 'FEM の最大変位', value: maxDisp, unit: 'm', note: '荷重を板の端の面に分けて加えるため、先端の一点荷重の理論より少しずれます。' } : undefined,
    };

    // ---- 曲げ応力 ----
    const bending: Formula = {
      id: 'stress-bending',
      title: '根元の曲げ応力',
      expression: 'σ = M · c / I = 6 · P · L / (t · h²)',
      vars: [vP, vL, vT, vH],
      resultSymbol: 'σ',
      resultLabel: '根元の最大曲げ応力',
      resultUnit: 'Pa',
      evaluate: (v) => (6 * v.P * v.L) / (v.t * v.h * v.h),
      substituted: (v) => `= 6 × ${formatSub(v.P)} × ${formatSub(v.L)} / (${formatSub(v.t)} × ${formatPow(v.h, 2)})`,
      steps: [
        '壁に近いほど、梁は大きく曲げられます。根元の曲げの強さは M = P × L（力 × 腕の長さ）。',
        '曲げると、梁の上の面は引っぱられ、下の面は押されます。いちばん力が強いのは真ん中から c = h/2 だけ離れた表面です。',
        '表面の応力は σ = M·c / I。I = t·h³/12 と c = h/2 を入れて整理すると、σ = 6PL / (t·h²) になります。',
        '高さ h は 2 乗で効きます。厚みを 2 倍にすると、応力は 1/4。',
      ],
      insight: powerInsight('σ', [
        { key: 'P', symbol: 'P', exp: 1 },
        { key: 'L', symbol: 'L', exp: 1 },
        { key: 't', symbol: 't', exp: -1 },
        { key: 'h', symbol: 'h', exp: -2 },
      ]),
      topics: [topic('比例・一次関数', '中学'), topic('指数・対数', '高校')],
      why: [
        {
          question: 'なぜ 6 が出てくるの？',
          answer: 'M·c/I に代入すると (P·L) × (h/2) × 12/(t·h³) = 12·P·L·h / (2·t·h³) = 6·P·L / (t·h²)。約分しただけです。',
        },
        {
          question: 'たわみは h の 3 乗、応力は 2 乗。なぜちがう？',
          answer: 'たわみには「曲がりにくさ I（h³）」だけが効きます。応力は「表面までの距離 c（h に比例）」も効くので、I の h³ を c の h で割って h² になります。厚くすると、たわみのほうが応力より大きく減ります。',
        },
      ],
      approx: `${beamApprox} 固定端の角は FEM では応力が集中して、梁理論より大きく出ることがあります。`,
      simulation:
        maxVm !== undefined
          ? { label: 'FEM の最大ミーゼス応力', value: maxVm, unit: 'Pa', note: '固定端の角（応力集中）と荷重点の局所的な応力を含むため、梁理論より大きく出やすい値です。' }
          : undefined,
    };

    // ---- 安全率 ----
    const safety: Formula = {
      id: 'stress-safety',
      title: '安全率（あと何倍まで耐えられるか）',
      expression: 'n = σy / σ',
      vars: [
        mathVar({ key: 'sigmaY', symbol: 'σy', label: '降伏応力（強さ）', unit: 'Pa', value: b.sigmaY, min: 1e6, max: 1e9, log: true, source: b.materialName }),
        mathVar({ key: 'sigma', symbol: 'σ', label: 'かかる応力', unit: 'Pa', value: sigma0, source: '根元の曲げ応力' }),
      ],
      resultSymbol: 'n',
      resultLabel: '安全率',
      resultUnit: '',
      evaluate: (v) => v.sigmaY / v.sigma,
      substituted: (v) => `= ${formatSub(v.sigmaY)} / ${formatSub(v.sigma)}`,
      steps: [
        '材料には「これ以上かけると永久に曲がる」という強さ σy（降伏応力）があります。',
        'いまかかっている応力 σ が σy の何分の一かを見るのが安全率 n = σy / σ です。',
        'n = 1 なら限界ぎりぎり。n = 2 なら、荷重があと 2 倍までは耐えられます（ただし荷重と応力は比例する範囲）。',
        '樹脂は経年や温度で弱くなるので、n = 2〜3 以上を目安にすると安心です。',
      ],
      insight: powerInsight('n', [
        { key: 'sigmaY', symbol: 'σy', exp: 1 },
        { key: 'sigma', symbol: 'σ', exp: -1 },
      ]),
      topics: [topic('比例・一次関数', '中学')],
      why: [
        {
          question: '安全率が 1 を切るとすぐ壊れるの？',
          answer: '降伏は「元に戻らなく曲がり始める」点で、すぐ折れるとは限りません。でも形が変わってしまうので、部品としては NG です。ガラスのような脆い材料は、降伏せずに突然割れます。',
        },
      ],
      approx: '3D プリントの積層方向は強度が 3〜5 割下がることがあります。データシートの値は XY 方向の目安です。',
      simulation: minSafety !== undefined ? { label: 'FEM の最小安全率', value: minSafety, unit: '', note: '応力集中のある場所で最小になるため、梁理論より小さく出やすい値です（表示は 100 で打ち切り）。' } : undefined,
    };

    // ---- バネ 2 本（K·u = f の最小版） ----
    const kBeam = (3 * b.E * I0) / b.L ** 3;
    const springs: Formula = {
      id: 'stress-springs',
      title: 'バネ 2 本でつくる FEM（連立方程式 K·u = f）',
      expression: 'u₂ = F / k₁ + F / k₂',
      vars: [
        mathVar({ key: 'F', symbol: 'F', label: '力', unit: 'N', value: b.P, source: '荷重の合計' }),
        mathVar({ key: 'k1', symbol: 'k₁', label: '壁側のバネの硬さ', unit: 'N/m', value: 2 * kBeam, source: '梁の硬さ 3EI/L³ の 2 倍' }),
        mathVar({ key: 'k2', symbol: 'k₂', label: '先端側のバネの硬さ', unit: 'N/m', value: 2 * kBeam, source: '梁の硬さ 3EI/L³ の 2 倍' }),
      ],
      resultSymbol: 'u₂',
      resultLabel: '先端の動き',
      resultUnit: 'm',
      evaluate: (v) => v.F / v.k1 + v.F / v.k2,
      substituted: (v) => `= ${formatSub(v.F)} / ${formatSub(v.k1)} + ${formatSub(v.F)} / ${formatSub(v.k2)}`,
      steps: [
        '梁を「壁 — バネ k₁ — 点 1 — バネ k₂ — 点 2（先端）」のように 2 本のバネでつなぐと考えます。FEM は、物体をこういう小さな部品に切って組み合わせる方法です。',
        '点 1 の動きを u₁、点 2 の動きを u₂ とします。力のつり合いを点ごとに書くと、2 本の式になります。',
        '点 1:  (k₁ + k₂)·u₁ − k₂·u₂ = 0　　点 2:  −k₂·u₁ + k₂·u₂ = F',
        'これを行列で書くと K·u = f。K = [[k₁+k₂, −k₂], [−k₂, k₂]]、u = [u₁, u₂]、f = [0, F]。',
        '解くと u₁ = F/k₁、u₂ = F/k₁ + F/k₂。バネを直列につなぐと、伸びが足し算になります。',
        'Studio M の強度解析は、これと同じ形の連立方程式を、数万個の点でまとめて解いています。',
      ],
      insight: ratioInsight('u₂', { F: 'F', k1: 'k₁', k2: 'k₂' }, (v) => v.F / v.k1 + v.F / v.k2),
      topics: [topic('連立方程式・行列', '大学'), topic('比例・一次関数', '中学')],
      why: [
        {
          question: 'なぜ行列を使うの？',
          answer: '未知数（動き）が数万個になると、連立方程式を 1 つずつ書けません。行列にまとめれば「K·u = f」の 1 行で書けて、コンピュータが一気に解けます。中学の連立方程式の、数が増えたものです。',
        },
        {
          question: 'バネの初期値が 2×(3EI/L³) なのはなぜ？',
          answer: '同じ硬さ k のバネを 2 本直列につなぐと、全体の硬さは k/2 になります。k₁ = k₂ = 2k とすると全体が k = 3EI/L³（片持ち梁の先端の硬さ）になり、梁の式と同じたわみになります。',
        },
      ],
      approx: '梁を 2 本のバネに置き換えた最小の例です。本物の FEM は、物体を数千〜数万の小さな要素に切って、同じ考え方で組み立てます。',
      simulation: maxDisp !== undefined ? { label: 'FEM の最大変位', value: maxDisp, unit: 'm' } : undefined,
    };

    return [hooke, second, deflection, bending, safety, springs];
  },
};
