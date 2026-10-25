// 熱の式。発熱・表面積・熱伝達率から温度上昇の目安を出す（物体全体が同じ温度という集中定数の近似）。
import { resolveProject } from '../../core/auto';
import { getMaterial } from '../../core/materials';
import { rasterize } from '../../core/raster';
import type { Project, Shape } from '../../core/types';
import { formatSig, formatSub, formatValue, ratioText } from '../format';
import { joinInsight, powerInsight, ratioInsight } from '../insight';
import { topic } from '../topics';
import type { Formula, MathProvider } from '../types';
import { bodiesBox, byRole, mathVar, primaryMaterial, safeMaterial, scalarOf, sectionLength } from './common';

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


// ---------- 基板（KiCad）の式に使う値 ----------

/** 発熱がいちばん大きい発熱体（基板でいちばん熱くなりそうな部品）。なければ undefined */
export function hottestPart(project: Project): Shape | undefined {
  return byRole(project, 'heatSource')
    .filter((s) => (s.heatW ?? 0) > 0)
    .sort((a, b) => (b.heatW ?? 0) - (a.heatW ?? 0))[0];
}

/** 銅箔の既定の厚さ [m]（1oz = 35 µm） */
const COPPER_1OZ = 35e-6;
/** 基板の既定の板厚 [m] */
const BOARD_T = 1.6e-3;
/** 接合部から周囲までの熱抵抗 θja の既定値 [K/W]（SOT-223 のような小さなパッケージの目安） */
const THETA_JA_DEFAULT = 50;

export interface BoardParams {
  /** 板厚 [m] */
  T: number;
  /** 銅箔の厚さの合計 [m]（全面が銅のベタと考えた値） */
  tCu: number;
  /** 基材の熱伝導率 [W/(m·K)] */
  kSub: number;
  /** 基材の名前 */
  substrate: string;
  fromPcb: boolean;
}

/** 基板の寸法と材料。project.pcb がなければ 1.6 mm・銅箔 35 µm・FR-4 */
export function boardParams(project: Project): BoardParams {
  const pcb = project.pcb;
  const sub = safeMaterial(pcb?.substrateId ?? 'fr4', 'fr4');
  if (!pcb) return { T: BOARD_T, tCu: COPPER_1OZ, kSub: sub.k, substrate: sub.name, fromPcb: false };
  const sum = pcb.layers.reduce((a, l) => a + l.thicknessUm * 1e-6, 0);
  const T = pcb.boardThicknessMm > 0 ? pcb.boardThicknessMm * 1e-3 : BOARD_T;
  return { T, tCu: sum > 0 ? Math.min(sum, T * 0.9) : COPPER_1OZ, kSub: sub.k, substrate: sub.name, fromPcb: true };
}

/** 銅と基材を厚さで重み付けした面内の実効熱伝導率（core/raster.ts の copperConductivity と同じ式、全面が銅の場合） */
export function mixedConductivity(opts: { T: number; tCu: number; kSub: number; kCu: number }): number {
  const { T, tCu, kSub, kCu } = opts;
  return (kSub * (T - tCu) + kCu * tCu) / T;
}

const um = (v: number): string => `${formatSig(v * 1e6)} µm`;
const mmText = (v: number): string => `${formatSig(v * 1e3)} mm`;

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

    // ---- 基板の式 1: LDO（リニアレギュレーター）の損失 ----
    const hot = project.pcb ? hottestPart(project) : undefined;
    const ldoVin = 5;
    const ldoVout = 3.3;
    const ldoI = hot ? (hot.heatW ?? 0) / (ldoVin - ldoVout) : 0.5;
    const ldo: Formula = {
      id: 'heat-ldo-loss',
      title: 'レギュレーターの発熱（LDO の損失）',
      expression: 'P = (Vin − Vout) × I',
      vars: [
        mathVar({ key: 'Vin', symbol: 'Vin', label: '入力電圧', unit: 'V', value: ldoVin, min: 3.5, max: 24, log: true, source: '5 V の電源を仮定' }),
        mathVar({ key: 'Vout', symbol: 'Vout', label: '出力電圧', unit: 'V', value: ldoVout, min: 0.8, max: 5, log: true, source: '3.3 V の電源を仮定' }),
        mathVar({
          key: 'I',
          symbol: 'I',
          label: '流れる電流',
          unit: 'A',
          value: ldoI,
          min: 0.05,
          max: 3,
          log: true,
          source: hot ? `${hot.name} の発熱から逆算（Vin 5 V・Vout 3.3 V の場合）` : '負荷の電流',
        }),
      ],
      resultSymbol: 'P',
      resultLabel: 'レギュレーターの発熱',
      resultUnit: 'W',
      evaluate: (v) => Math.max(0, v.Vin - v.Vout) * v.I,
      substituted: (v) => `= (${formatSub(v.Vin)} − ${formatSub(v.Vout)}) × ${formatSub(v.I)}`,
      steps: [
        'LDO は、入力の電圧を出力の電圧まで「捨てて」下げる部品です。捨てた電圧ぶんは、そのまま熱になります。',
        '電力は P = 電圧 × 電流。LDO で捨てる電圧は Vin − Vout なので、熱になる電力は P = (Vin − Vout) × I です。',
        '出力側へ流れる電力 Vout × I は負荷の仕事になり、熱にはなりません。入力 5 V から 3.3 V を作ると、1.7 V ぶんが熱になります。',
        'I が 2 倍なら P も 2 倍（比例）。Vin − Vout が 2 倍でも P は 2 倍になります。',
        'Vin が Vout より低いと LDO は電圧を作れません（ここでは損失 0 として扱います）。',
      ],
      insight: (vars, base) => {
        const rI = vars.I / base.I;
        const onlyI = Math.abs(vars.Vin - base.Vin) < 1e-9 && Math.abs(vars.Vout - base.Vout) < 1e-9;
        if (onlyI && Math.abs(rI - 1) > 0.005) return `電流 I が ${ratioText(rI)} → 発熱 P も ${ratioText(rI)}（比例だから）`;
        return ratioInsight('P', { Vin: 'Vin', Vout: 'Vout', I: 'I' }, (v) => Math.max(0, v.Vin - v.Vout) * v.I)(vars, base);
      },
      topics: [topic('比例・一次関数', '中学')],
      why: [
        {
          question: 'なぜ電圧を下げると熱が出るの？',
          answer: 'LDO は、余った電圧を部品の中で「抵抗」のように受け止めて下げています。抵抗に電流が流れると P = 電圧 × 電流の熱が出るので、下げる電圧が大きいほど、流す電流が多いほど熱くなります。',
        },
        {
          question: '熱を減らすにはどうすればいい？',
          answer: 'Vin − Vout を小さくする（入力電圧を下げる）か、スイッチングレギュレーター（DC-DC）に替えます。DC-DC は電圧を捨てずに変換するので、損失がずっと小さくなります。',
        },
      ],
      approx: hot
        ? `基板でいちばん発熱の大きい部品 ${hot.name}（${formatValue(hot.heatW ?? 0, 'W')}）を LDO とみなし、入力 5 V・出力 3.3 V のときの電流を逆算しています。静止電流（LDO 自身が使う小さな電流）は無視しています。`
        : '静止電流（LDO 自身が使う小さな電流）は無視した、いちばん簡単な式です。入力 5 V・出力 3.3 V・0.5 A なら約 0.85 W です。',
    };

    // ---- 基板の式 2: 銅箔と基材の混ぜ合わせ（重み付き平均） ----
    const bp = boardParams(project);
    const kCu = safeMaterial('c1100').k;
    const copper: Formula = {
      id: 'heat-copper-mix',
      title: '基板の熱の通しやすさ（銅箔 + 基材の重み付き平均）',
      expression: 'k_eff = (k_FR4 · (T − t_cu) + k_cu · t_cu) / T',
      vars: [
        mathVar({ key: 'kSub', symbol: 'k_FR4', label: `基材の熱伝導率（${bp.substrate}）`, unit: 'W/(m·K)', value: bp.kSub, fixed: true, source: '材料表の値（面内）' }),
        mathVar({ key: 'kCu', symbol: 'k_cu', label: '銅の熱伝導率', unit: 'W/(m·K)', value: kCu, fixed: true, source: '銅 C1100' }),
        mathVar({ key: 'T', symbol: 'T', label: '板厚', unit: 'm', value: bp.T, min: 0.4e-3, max: 3.2e-3, log: true, display: mmText, source: bp.fromPcb ? '取り込んだ基板の板厚' : '標準の 1.6 mm' }),
        mathVar({
          key: 'tCu',
          symbol: 't_cu',
          label: '銅箔の厚さの合計',
          unit: 'm',
          value: bp.tCu,
          min: 5e-6,
          max: 200e-6,
          log: true,
          display: um,
          source: bp.fromPcb ? '各層の銅箔の厚さの合計（全面ベタとして）' : '1oz = 35 µm（片面）',
        }),
      ],
      resultSymbol: 'k_eff',
      resultLabel: '基板の面内の実効熱伝導率',
      resultUnit: 'W/(m·K)',
      evaluate: (v) => mixedConductivity({ T: v.T, tCu: Math.min(v.tCu, v.T), kSub: v.kSub, kCu: v.kCu }),
      substituted: (v) => `= (${formatSub(v.kSub)} × (${mmText(v.T)} − ${um(v.tCu)}) + ${formatSub(v.kCu)} × ${um(v.tCu)}) / ${mmText(v.T)}`,
      steps: [
        '基板は、板の厚さ方向に「基材（FR-4）」と「銅箔」が重なっています。熱は板の面に沿って、この両方を通って広がります。',
        '銅箔の厚さが t_cu、板全体の厚さが T なら、銅の割合は t_cu / T、基材の割合は (T − t_cu) / T。',
        '熱の通しやすさ k を、この割合で混ぜた平均が k_eff。「割合 × 値」を足し合わせる、重み付き平均です。',
        'FR-4 の k は約 0.3、銅は約 390 と 1300 倍ちがいます。銅が板厚のわずか 2% でも、熱の通り道としては基材を大きく上回ります。',
        '銅箔を 35 µm から 70 µm（2oz）に厚くすると、銅の割合がほぼ 2 倍になり、k_eff もほぼ 2 倍になります。',
      ],
      insight: ratioInsight('k_eff', { T: 'T', tCu: 't_cu' }, (v) => mixedConductivity({ T: v.T, tCu: Math.min(v.tCu, v.T), kSub: v.kSub, kCu: v.kCu })),
      topics: [topic('比例・一次関数', '中学')],
      why: [
        {
          question: '重み付き平均って何？',
          answer: 'テストの平均点で、配点の大きい科目を重く数えるのと同じです。ここでは板の厚さが「配点」で、薄い銅も熱をとても通しやすいので、少しの厚さでも大きく効きます。',
        },
        {
          question: '銅箔を 35 µm から 70 µm にするとどうなる？',
          answer: 'k_eff はほぼ 2 倍になります（銅の割合が 2 倍になるため。基材の割合が少し減るぶん、ぴったりの 2 倍よりわずかに小さくなります）。スライダーで t_cu を動かして確かめましょう。',
        },
      ],
      approx: '全面が銅のベタだとみなした値です。実際の配線は一部にしか銅がないので、Studio M の計算では場所ごとに銅の面積の割合を数えて、この式を各セルに当てはめています（2D の近似）。',
    };

    // ---- 基板の式 3: 接合部温度 Tj = Ta + P·θja ----
    const part = hottestPart(project);
    const hotPower = part ? (part.heatW ?? 0) : totalPower(project, scalarOf(result, 'totalHeat')).P;
    const ta = project.heat.ambientC;
    const partResult = part ? result?.perShape?.find((s) => s.shapeId === part.id) : undefined;
    const partMax = partResult?.values.find((x) => x.key === 'maxTemp')?.value;
    const simTheta = partMax !== undefined && hotPower > 0 ? (partMax - ta) / hotPower : NaN;
    const fromSim = Number.isFinite(simTheta) && simTheta > 0;
    const theta0 = fromSim ? simTheta : THETA_JA_DEFAULT;
    const tjOf = (v: Record<string, number>): number => v.Ta + v.P * v.theta;
    const junction: Formula = {
      id: 'heat-junction',
      title: '部品の温度（接合部温度）',
      expression: 'Tj = Ta + P · θja',
      vars: [
        mathVar({ key: 'Ta', symbol: 'Ta', label: '周囲の温度', unit: '°C', value: ta, min: Math.min(ta, 0), max: Math.max(ta, 60), source: '熱の設定の周囲温度' }),
        mathVar({ key: 'P', symbol: 'P', label: '部品の発熱', unit: 'W', value: hotPower, source: part ? `${part.name} の発熱（いちばん発熱の大きい部品）` : '発熱体の合計' }),
        mathVar({
          key: 'theta',
          symbol: 'θja',
          label: '熱抵抗（接合部 → 周囲）',
          unit: 'K/W',
          value: theta0,
          min: 2,
          max: 200,
          log: true,
          source: fromSim ? `${part?.name} のシミュレーション結果から逆算（この基板での値）` : 'データシートの目安（小さなパッケージ）',
        }),
      ],
      resultSymbol: 'Tj',
      resultLabel: '部品の温度',
      resultUnit: '°C',
      evaluate: tjOf,
      substituted: (v) => `= ${formatSub(v.Ta)} + ${formatSub(v.P)} × ${formatSub(v.theta)}`,
      steps: [
        '部品の温度は、周囲の温度 Ta に、部品が自分の熱で上げたぶんを足したものです。',
        '上がるぶんは、前に出てきた「熱のオームの法則」ΔT = P × R そのもの。ここでは R を θja（シータ ジェイ エー）と呼びます。',
        'θja は部品の中の熱が、基板や空気を通って周囲へ逃げるまでの通りにくさ [K/W]。小さいほどよく冷えます。',
        'たとえば P = 1 W、θja = 50 K/W なら、周囲より 50 K 高くなります。周囲が 25°C なら Tj = 75°C です。',
        '基板に銅ベタを広げる、ファンで風を当てる、は θja を小さくすることです。P を減らしても Tj は下がります。',
      ],
      insight: (vars, base) => {
        const dTa = vars.Ta - base.Ta;
        const rise = ratioInsight('温度上昇', { P: 'P', theta: 'θja' }, (v) => v.P * v.theta)(vars, base);
        const ta2 = Math.abs(dTa) > 0.05 ? `Ta が ${dTa > 0 ? '+' : '−'}${formatSig(Math.abs(dTa))} K → Tj も同じだけ変わります` : null;
        return joinInsight(rise, ta2);
      },
      topics: [topic('比例・一次関数', '中学')],
      why: [
        {
          question: 'Tj の「j」って何？',
          answer: 'junction（接合部）の頭文字です。半導体の中でいちばん熱くなる、チップの本体のことです。データシートには「Tj の上限」が書かれていて、これを超えると壊れたり寿命が縮んだりします。',
        },
      ],
      approx: fromSim
        ? `θja はシミュレーションの最高温度から ( 最高温度 − Ta ) / P で逆算した、この基板での値です。データシートの θja は標準の試験基板での値なので、実際の基板とは違います。`
        : 'θja の 50 K/W は、小さなパッケージの目安です。データシートの θja は標準の試験基板での値で、実際の基板では銅の広さや風で大きく変わります。',
    };

    return [convection, conduction, balance, transient, ldo, copper, junction];
  },
};
