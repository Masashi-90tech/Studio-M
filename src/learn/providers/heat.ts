// 熱の式。発熱・表面積・熱伝達率から温度上昇の目安を出す（物体全体が同じ温度という集中定数の近似）。
import { resolveProject } from '../../core/auto';
import { getMaterial } from '../../core/materials';
import { rasterize } from '../../core/raster';
import type { Project } from '../../core/types';
import { formatSig, formatSub, formatValue } from '../format';
import { powerInsight, ratioInsight } from '../insight';
import { topic } from '../topics';
import type { Formula, MathProvider } from '../types';
import { bodiesBox, byRole, mathVar, primaryMaterial, scalarOf, sectionLength } from './common';

export interface HeatGeometry {
  /** 物体の断面積（2D の面積）[m²] */
  area: number;
  /** 空気に接している周囲の長さ [m]（解析領域の端は断熱なので数えない） */
  perimeter: number;
  /** 熱容量 Σ ρ·cp·体積 [J/K] */
  capacity: number;
}

/** 格子化して面積・周囲の長さ・熱容量を数える。物体がなければ 0 */
export function heatGeometry(project: Project): HeatGeometry {
  const out: HeatGeometry = { area: 0, perimeter: 0, capacity: 0 };
  try {
    const { project: resolved } = resolveProject(project, 'heat');
    const r = rasterize(resolved);
    const { nx, ny, h } = r;
    const t = project.thickness;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (!r.solid[c]) continue;
        out.area += h * h;
        const id = r.materialId[c];
        if (id) {
          try {
            const m = getMaterial(id);
            out.capacity += m.rho * m.cp * h * h * t;
          } catch {
            /* 未知の材料は熱容量に数えない */
          }
        }
        if (i > 0 && !r.solid[c - 1]) out.perimeter += h;
        if (i < nx - 1 && !r.solid[c + 1]) out.perimeter += h;
        if (j > 0 && !r.solid[c - nx]) out.perimeter += h;
        if (j < ny - 1 && !r.solid[c + nx]) out.perimeter += h;
      }
    }
  } catch {
    /* 格子化できないときは 0 のまま（下で既定値に置き換える） */
  }
  return out;
}

/** 発熱の合計 [W]。発熱体がなければ結果の総発熱量、それもなければ 5 W */
export function totalPower(project: Project, totalHeat?: number): { P: number; fromShapes: boolean } {
  const p = byRole(project, 'heatSource').reduce((a, s) => a + (s.heatW ?? 0), 0);
  if (p > 0) return { P: p, fromShapes: true };
  if (totalHeat !== undefined && totalHeat > 0) return { P: totalHeat, fromShapes: false };
  return { P: 5, fromShapes: false };
}

/** 放熱面積 A = 周囲 × 奥行き（+ 表裏の面 2 × 面積）[m²] */
export function coolingArea(g: HeatGeometry, thickness: number, faceCooling: boolean): number {
  const a = g.perimeter * thickness + (faceCooling ? 2 * g.area : 0);
  return a > 0 ? a : 0.01;
}

const cm2 = (v: number): string => `${formatSig(v * 1e4)} cm²`;
const kelvin = (v: number): string => `${formatSig(v)} K`;

export const heatProvider: MathProvider = {
  kind: 'heat',
  formulas({ project, result }) {
    const g = heatGeometry(project);
    const t = project.thickness > 0 ? project.thickness : 0.01;
    const { P, fromShapes } = totalPower(project, scalarOf(result, 'totalHeat'));
    const hc = project.heat.surfaceH > 0 ? project.heat.surfaceH : 10;
    const A = coolingArea(g, t, project.heat.faceCooling);
    const dT0 = P / (hc * A);
    const mat = primaryMaterial(project, 'al6061');

    const avg = scalarOf(result, 'avgTemp');
    const heatOut = scalarOf(result, 'heatOut');
    const areaNote = project.heat.faceCooling
      ? `放熱面積は「周囲の長さ × 奥行き」と「表と裏の面（2 × 断面積）」の合計 ${cm2(A)} で数えています。`
      : `放熱面積は「周囲の長さ × 奥行き」${cm2(A)} で数えています（表裏の面からの放熱は切ってあります）。`;
    const powerNote = fromShapes ? '発熱は発熱体の合計です。' : '発熱体がないので、仮の値を入れています。';

    const vP = mathVar({ key: 'P', symbol: 'P', label: '発熱', unit: 'W', value: P, source: '発熱体の合計' });
    const vH = mathVar({ key: 'h', symbol: 'h', label: '熱伝達率（冷やし方）', unit: 'W/(m²·K)', value: hc, min: 2, max: 200, log: true, source: '自然対流 5〜10、ファン 20〜100' });
    const vA = mathVar({ key: 'A', symbol: 'A', label: '放熱面積', unit: 'm²', value: A, display: cm2, source: '格子から数えた面積' });

    const convection: Formula = {
      id: 'heat-convection',
      title: '温度上昇の目安（対流で熱を逃がす）',
      expression: 'ΔT = P / (h · A)',
      vars: [vP, vH, vA],
      resultSymbol: 'ΔT',
      resultLabel: '室温からの温度上昇',
      resultUnit: 'K',
      evaluate: (v) => v.P / (v.h * v.A),
      substituted: (v) => `= ${formatSub(v.P)} / (${formatSub(v.h)} × ${formatSub(v.A)})`,
      steps: [
        '発熱 P [W] は、熱を逃がせるようになるまで物体の温度を上げ続けます。',
        '表面から空気へ逃げる熱の量は Q = h · A · ΔT（逃げやすさ h × 表面積 A × 温度差 ΔT）。温度差が大きいほど、たくさん逃げます。',
        '温度が上がるにつれて逃げる熱が増え、「入る熱 P = 逃げる熱 Q」になったところで温度が止まります。これが定常状態です。',
        'P = h · A · ΔT を ΔT について解くと ΔT = P / (h · A)。',
        '分母にある A や h を大きくするほど ΔT は下がります（反比例）。ヒートシンクのフィンは A を増やすため、ファンは h を上げるためのものです。',
      ],
      insight: powerInsight('ΔT', [
        { key: 'P', symbol: 'P', exp: 1 },
        { key: 'h', symbol: 'h', exp: -1 },
        { key: 'A', symbol: 'A', exp: -1 },
      ]),
      topics: [topic('比例・一次関数', '中学')],
      why: [
        {
          question: 'なぜフィンを付けると冷えるの？',
          answer: '熱が空気へ逃げるのは「表面」からです。フィンで表面積 A を増やすと、同じ温度差でも逃げる熱が A に比例して増えます。A が 2 倍なら、同じ発熱で ΔT は半分で済みます。',
        },
        {
          question: 'ΔT が反比例って、グラフにするとどうなる？',
          answer: 'ΔT = P / (h·A) は、A を横軸にすると「A を 2 倍にすると半分」を繰り返す曲線（双曲線）です。最初のうちは A を増やすと効果が大きく、増やすほど効き目がゆるやかになります。',
        },
      ],
      approx: `${powerNote}${areaNote} 物体全体が同じ温度だとみなした目安なので、熱源のそばの最高温度はこれより高く、遠いところは低くなります。シミュレーションの「平均温度 − 室温」と比べます。`,
      simulation: avg !== undefined ? { label: 'シミュレーションの平均温度上昇', value: avg - project.heat.ambientC, unit: 'K', note: '最高温度ではなく平均です。最高温度は熱源のそばでこれより高くなります。' } : undefined,
    };

    // ---- 熱伝導の熱抵抗 ----
    const box = bodiesBox(project);
    const alongX = box ? box.x1 - box.x0 >= box.y1 - box.y0 : true;
    const Lrod = box ? (alongX ? box.x1 - box.x0 : box.y1 - box.y0) : 0.05;
    const mid = box ? (alongX ? (box.x0 + box.x1) / 2 : (box.y0 + box.y1) / 2) : 0;
    const width = box ? sectionLength(project, alongX ? 'x' : 'y', mid) : 0.01;
    const Ac = t * (width > 0 ? width : 0.01);
    const conduction: Formula = {
      id: 'heat-conduction',
      title: '熱の通りにくさ（熱抵抗）',
      expression: 'R = L / (k · A)',
      vars: [
        mathVar({ key: 'L', symbol: 'L', label: '熱の通る長さ', unit: 'm', value: Lrod, source: '物体のいちばん長い向き' }),
        mathVar({ key: 'k', symbol: 'k', label: '熱伝導率', unit: 'W/(m·K)', value: mat.k, min: 0.02, max: 500, log: true, source: mat.name }),
        mathVar({ key: 'Ac', symbol: 'A', label: '熱の通る断面積', unit: 'm²', value: Ac, display: cm2, source: '長さの真ん中の断面' }),
      ],
      resultSymbol: 'R',
      resultLabel: '熱抵抗',
      resultUnit: 'K/W',
      evaluate: (v) => v.L / (v.k * v.Ac),
      substituted: (v) => `= ${formatSub(v.L)} / (${formatSub(v.k)} × ${formatSub(v.Ac)})`,
      steps: [
        '電気で「電圧 V をかけると電流 I が流れ、V = I·R」というオームの法則があります。熱もそっくりです。',
        '電圧にあたるのが温度差 ΔT、電流にあたるのが熱の流れ P [W]、抵抗にあたるのが熱抵抗 R [K/W]。つまり ΔT = P · R。',
        '長い棒ほど熱が通りにくい（R は L に比例）。太い棒ほど通りやすい（R は断面積 A に反比例）。材料が熱を通しやすいほど（k が大きいほど）R は小さい。',
        'この 3 つをまとめて R = L / (k · A)。電気抵抗 R = ρ·L / A と同じ形です。',
      ],
      insight: powerInsight('R', [
        { key: 'L', symbol: 'L', exp: 1 },
        { key: 'k', symbol: 'k', exp: -1 },
        { key: 'Ac', symbol: 'A', exp: -1 },
      ]),
      topics: [topic('比例・一次関数', '中学')],
      why: [
        {
          question: '電気と熱が同じ式になるのはなぜ？',
          answer: 'どちらも「差があると、高いほうから低いほうへ流れる」現象で、流れる量は差に比例し、通り道の長さに反比例し、太さに比例するからです。数学では同じ形の式になります。',
        },
        {
          question: 'FR-4 基板に銅パッドを付けると何が変わる？',
          answer: 'FR-4 の k は約 0.3、銅は約 390 です。k が 1300 倍になると、同じ形でも R は 1/1300。熱が基板の中を一気に広がります。スライダーで k を動かしてみましょう。',
        },
      ],
      approx: '1 本の棒に熱が一方向に流れるときの式です。実際の熱は広がって流れるので、あくまで「どの材料・どの形が通しやすいか」の比較に使います。',
    };

    // ---- 発熱 = 放熱 ----
    const balance: Formula = {
      id: 'heat-balance',
      title: '熱のつり合い（入る熱 = 出る熱）',
      expression: 'Q = h · A · ΔT',
      vars: [
        vH,
        vA,
        mathVar({ key: 'dT', symbol: 'ΔT', label: '室温からの温度上昇', unit: 'K', value: dT0, display: kelvin, source: '上の式で出した値' }),
      ],
      resultSymbol: 'Q',
      resultLabel: '空気へ逃げる熱',
      resultUnit: 'W',
      evaluate: (v) => v.h * v.A * v.dT,
      substituted: (v) => `= ${formatSub(v.h)} × ${formatSub(v.A)} × ${formatSub(v.dT)}`,
      steps: [
        '温度が落ち着いた状態では、発熱している量と、空気へ逃げる量がぴったり同じです（エネルギーは増えも減りもしない）。',
        `いまの発熱は P = ${formatValue(P, 'W')} です。ΔT を上の式の答えにすると、Q は P と同じになります。`,
        'ΔT を小さくすると Q が足りず、まだ温度が上がり続ける。大きくすると Q が多すぎて、温度は下がる。ちょうどつり合う ΔT が答えです。',
        'シミュレーションでは「総発熱量」と「放熱量」が一致するかを、収束の確認に使えます。',
      ],
      insight: powerInsight('Q', [
        { key: 'h', symbol: 'h', exp: 1 },
        { key: 'A', symbol: 'A', exp: 1 },
        { key: 'dT', symbol: 'ΔT', exp: 1 },
      ]),
      topics: [topic('比例・一次関数', '中学')],
      why: [
        {
          question: 'つり合っていないとどうなる？',
          answer: '入る熱のほうが多ければ温度が上がり続け、そのぶん逃げる熱も増えて、いつかつり合います。出る熱のほうが多ければ温度が下がります。どちらでも最後はつり合う点に落ち着きます。',
        },
      ],
      approx: `${areaNote}2D の計算では、放熱は格子の表面から空気へ出る熱の合計で数えます。`,
      simulation: heatOut !== undefined ? { label: 'シミュレーションの放熱量', value: heatOut, unit: 'W', note: '収束していれば総発熱量と同じ値になります。' } : undefined,
    };

    // ---- 温度が上がっていく時間（指数） ----
    const C = g.capacity > 0 ? g.capacity : 10;
    const tau0 = C / (hc * A);
    const transient: Formula = {
      id: 'heat-transient',
      title: '温度が上がっていくようす（指数関数）',
      expression: 'ΔT(t) = P / (h·A) · (1 − e^(−t/τ))　（τ = C / (h·A)）',
      vars: [
        vP,
        vH,
        vA,
        mathVar({ key: 'C', symbol: 'C', label: '熱容量（温まりにくさ）', unit: 'J/K', value: C, source: '密度 × 比熱 × 体積の合計' }),
        mathVar({ key: 't', symbol: 't', label: '経過時間', unit: 's', value: tau0, source: '最初は τ（時定数）' }),
      ],
      resultSymbol: 'ΔT(t)',
      resultLabel: 't 秒後の温度上昇',
      resultUnit: 'K',
      evaluate: (v) => (v.P / (v.h * v.A)) * (1 - Math.exp((-v.t * v.h * v.A) / v.C)),
      substituted: (v) => {
        const tau = v.C / (v.h * v.A);
        return `= ${formatSub(v.P / (v.h * v.A))} × (1 − e^(−${formatSig(v.t)} / ${formatSig(tau)}))`;
      },
      steps: [
        '電源を入れた直後は温度差が小さいので、熱があまり逃げず、温度が速く上がります。',
        '温度が上がるほど逃げる熱が増えるので、上がり方はだんだんゆるやかになります。',
        'この「近づき方」を表すのが 1 − e^(−t/τ)。t = 0 で 0、t が大きいと 1 に近づきます（e ≈ 2.718）。',
        'τ（時定数）= 熱容量 ÷ (h·A)。t = τ のときに最終温度の約 63 %、t = 3τ で約 95 % に届きます。',
        '重い（C が大きい）ほど温まるのに時間がかかり、よく冷える（h·A が大きい）ほど早く落ち着きます。',
      ],
      insight: ratioInsight('ΔT(t)', { P: 'P', h: 'h', A: 'A', C: 'C', t: 't' }, (v) => (v.P / (v.h * v.A)) * (1 - Math.exp((-v.t * v.h * v.A) / v.C))),
      topics: [topic('指数・対数', '高校')],
      why: [
        {
          question: 'なぜ e が出てくるの？',
          answer: '「いまの温度差に比例して変化する」現象は、必ず e の指数関数になります。冷めるコーヒー、充電中のコンデンサ、薬が体から抜けるようすも同じ形です。e は「増え方が自分自身に比例する」ときの自然な底です。',
        },
        {
          question: 'τ のとき 63 % になるのはなぜ？',
          answer: 't = τ を入れると 1 − e⁻¹ = 1 − 0.368 = 0.632 だからです。e⁻¹ ≈ 0.368 を覚えておくと、時定数の見積りができます。',
        },
      ],
      approx: '物体全体を 1 つの温度で考えた近似です。熱の通りにくい材料（樹脂）や大きな物体では、内部の温度ムラがあり、実際はもっとゆっくりです。',
    };

    return [convection, conduction, balance, transient];
  },
};
