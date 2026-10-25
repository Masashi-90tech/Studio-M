// 流れの式。レイノルズ数・抗力・揚力・渦の周期（ストローハル数）。
import type { Project } from '../../core/types';
import { formatSig, formatSub, formatPow, formatValue } from '../format';
import { joinInsight, powerInsight } from '../insight';
import { topic } from '../topics';
import type { Formula, MathProvider } from '../types';
import { bodiesBox, mathVar, safeMaterial, scalarOf } from './common';

/** レイノルズ数の境目の目安（verdict.ts と同じ: 40 で渦ができ始め、1000 を超えると乱れる） */
export function flowRegime(re: number): string {
  if (!Number.isFinite(re) || re < 0) return '不明';
  if (re < 40) return 'なめらかな流れ（物体に沿って流れる）';
  if (re < 1000) return '渦ができる流れ（後ろに渦が交互にできる）';
  return '乱れた流れ（乱流）';
}

export interface FlowInputs {
  U: number;
  L: number;
  nu: number;
  rho: number;
  /** 正面の面積（L × 奥行き）[m²] */
  A: number;
  fluidName: string;
  fromBody: boolean;
}

/** プロジェクトから流れの量を取り出す。L は物体の高さ（ソルバーの代表長さと同じ向き） */
export function flowInputs(project: Project): FlowInputs {
  const fluid = safeMaterial(project.flow.fluidId, 'air');
  const box = bodiesBox(project);
  const L = box ? box.y1 - box.y0 : project.domain.height;
  const u = Math.abs(project.flow.inletVelocity);
  const t = project.thickness > 0 ? project.thickness : 0.01;
  return {
    U: u > 1e-9 ? u : 1,
    L,
    nu: fluid.viscosity ?? 1.5e-5,
    rho: fluid.rho,
    A: L * t,
    fluidName: fluid.name,
    fromBody: box !== null,
  };
}

const reOf = (v: Record<string, number>): number => (v.U * v.L) / v.nu;

const REGIME_WHY = {
  question: '「Re が 40 や 1000」の境目は、どこから来たの？',
  answer:
    '円柱まわりの実験でわかった目安です。Re が約 40 より小さいと、流れは円柱に沿って後ろでくっつきます。約 40 を超えると後ろに渦が交互にできはじめ（カルマン渦）、約 200 を超えると渦が 3 次元的に乱れ、約 1000 以上では後ろの流れ全体が乱流になります。' +
    '物の形で境目は変わります。丸い管の中なら約 2300、平らな板の上なら約 50 万が目安です。',
};

export const flowProvider: MathProvider = {
  kind: 'flow',
  formulas({ project, result }) {
    const f = flowInputs(project);
    const Cd0 = scalarOf(result, 'Cd');
    const Cl0 = scalarOf(result, 'Cl');
    const St0 = scalarOf(result, 'strouhal');
    const drag = scalarOf(result, 'drag');
    const lift = scalarOf(result, 'lift');
    const reSim = scalarOf(result, 'Re');
    const Cd = Cd0 !== undefined && Cd0 > 0 ? Cd0 : 1.2;
    const Cl = Cl0 !== undefined && Math.abs(Cl0) > 0.01 ? Math.abs(Cl0) : 0.8;
    const St = St0 !== undefined && St0 > 0 ? St0 : 0.2;
    const lenNote = f.fromBody ? '代表の長さ L は物体の高さ（流れに垂直な幅）です。' : '物体がないので、領域の高さを L にしています。';

    const vU = mathVar({ key: 'U', symbol: 'U', label: '流速', unit: 'm/s', value: f.U, source: '流入速度' });
    const vL = mathVar({ key: 'L', symbol: 'L', label: '代表の長さ', unit: 'm', value: f.L, source: '物体の高さ' });
    const vRho = mathVar({ key: 'rho', symbol: 'ρ', label: '密度', unit: 'kg/m³', value: f.rho, min: 0.1, max: 2000, log: true, source: f.fluidName });
    const vA = mathVar({ key: 'A', symbol: 'A', label: '正面の面積', unit: 'm²', value: f.A, display: (v) => `${formatSig(v * 1e4)} cm²`, source: '高さ × 奥行き' });

    const reynolds: Formula = {
      id: 'flow-reynolds',
      title: 'レイノルズ数（流れのようすを決める数）',
      expression: 'Re = U · L / ν',
      vars: [
        vU,
        vL,
        mathVar({ key: 'nu', symbol: 'ν', label: '動粘性係数', unit: 'm²/s', value: f.nu, min: 1e-7, max: 1e-3, log: true, source: `${f.fluidName}（空気 1.5×10⁻⁵、水 1.0×10⁻⁶）` }),
      ],
      resultSymbol: 'Re',
      resultLabel: 'レイノルズ数',
      resultUnit: '',
      evaluate: reOf,
      substituted: (v) => `= ${formatSub(v.U)} × ${formatSub(v.L)} / ${formatSub(v.nu)}`,
      steps: [
        '流れには 2 つの性格があります。進み続けようとする力（慣性）と、ねばって流れをなめらかにする力（粘性）。',
        '慣性は「速く・大きい」ほど強く、粘性は「ねばり気（ν）が大きい」ほど強くなります。',
        'その比が Re = 慣性 ÷ 粘性 = U·L / ν です。単位が全部消えて、ただの数になります。',
        'Re が小さいと粘性が勝って、流れはなめらか。Re が大きいと慣性が勝って、渦ができ、乱れます。',
        'だから「小さな模型を水の中で動かして、大きな実物の空気の流れを調べる」ことができます。Re を同じにすれば、流れのようすが同じになるからです。',
      ],
      insight: (vars, base) => {
        const power = powerInsight('Re', [
          { key: 'U', symbol: 'U', exp: 1 },
          { key: 'L', symbol: 'L', exp: 1 },
          { key: 'nu', symbol: 'ν', exp: -1 },
        ])(vars, base);
        if (!power) return null;
        const now = flowRegime(reOf(vars));
        return joinInsight(power, flowRegime(reOf(base)) === now ? `いまは${now}` : `${now}に変わりました`);
      },
      topics: [topic('比例・一次関数', '中学'), topic('偏微分方程式', '大学')],
      why: [
        REGIME_WHY,
        {
          question: '単位が消える数に、どうして意味があるの？',
          answer: '「何倍か」という割合だからです。身長が 170 cm でも 1.7 m でも、体重との比（BMI の考え方）は変わりません。割合は単位や大きさに関係なく、「性格」だけを表します。',
        },
        {
          question: 'ナビエ–ストークス方程式とのつながりは？',
          answer: '流れを表す式（ナビエ–ストークス方程式）を、速さと長さで割って無次元にすると、粘性の項の前に 1/Re が付きます。つまり Re 1 つで、流れの性格が決まります。大学の偏微分方程式で出会います。',
        },
      ],
      approx: `${lenNote} 解析では格子の 1 セルの高さ単位で L を数えるので、ここの値と少しずれることがあります。`,
      simulation: reSim !== undefined ? { label: 'シミュレーションの Re', value: reSim, unit: '' } : undefined,
    };

    const dragF: Formula = {
      id: 'flow-drag',
      title: '抗力（流れに押される力）',
      expression: 'F = ½ · ρ · U² · Cd · A',
      vars: [vRho, vU, mathVar({ key: 'Cd', symbol: 'Cd', label: '抗力係数', unit: '', value: Cd, min: 0.05, max: 5, log: true, source: Cd0 !== undefined && Cd0 > 0 ? 'シミュレーション' : '円柱の目安' }), vA],
      resultSymbol: 'F',
      resultLabel: '抗力',
      resultUnit: 'N',
      evaluate: (v) => 0.5 * v.rho * v.U ** 2 * v.Cd * v.A,
      substituted: (v) => `= 0.5 × ${formatSub(v.rho)} × ${formatPow(v.U, 2)} × ${formatSub(v.Cd)} × ${formatSub(v.A)}`,
      steps: [
        '流れの中の物体は、空気の粒にぶつかって押されます。',
        'ぶつかる粒の数は「速さ U × 正面の面積 A」に比例します。',
        '粒 1 個がぶつかるときの強さも U に比例します。だから力は U × U = U² に比例（速さが 2 倍なら力は 4 倍）。',
        'ρ（密度）が大きい流体ほど、粒が重いので力も大きい（水は空気の約 800 倍）。',
        'ぶつかり方は形で変わるので、まとめて抗力係数 Cd で表します。丸い円柱は約 1.2、流線形の翼は 0.05 くらい。',
        '½ρU² は「動圧」と呼ばれる、流れが持つ圧力です。',
      ],
      insight: powerInsight('F', [
        { key: 'rho', symbol: 'ρ', exp: 1 },
        { key: 'U', symbol: 'U', exp: 2 },
        { key: 'Cd', symbol: 'Cd', exp: 1 },
        { key: 'A', symbol: 'A', exp: 1 },
      ]),
      topics: [topic('指数・対数', '高校'), topic('積分', '大学')],
      why: [
        {
          question: 'なぜ速さの 2 乗なの？',
          answer: '①単位時間にぶつかる空気の量が U に比例、②ぶつかった空気の勢いも U に比例。U × U で U²。自転車で速度を 2 倍にすると、風の抵抗は 4 倍になります。',
        },
        {
          question: '抗力は本当はどう決まっているの？',
          answer: '物体の表面全体で、圧力（押す力）と摩擦（引きずる力）を足し合わせたものです。表面の小さな欠片ごとの力を全部足す計算が積分です。係数 Cd は、その結果を ½ρU²A で割った「形の通信簿」です。',
        },
      ],
      approx: `2D の計算なので、奥行き（解析の厚み）をそのまま掛けた力です。Cd は流れの状態（Re）で大きく変わるので、${Cd0 !== undefined && Cd0 > 0 ? 'シミュレーションで出た値' : '円柱の目安 1.2'} を入れています。`,
      simulation: drag !== undefined ? { label: 'シミュレーションの抗力', value: drag, unit: 'N', note: '渦が出る流れでは時間とともに揺れます。' } : undefined,
    };

    const liftF: Formula = {
      id: 'flow-lift',
      title: '揚力（流れに直角に働く力）',
      expression: 'Fl = ½ · ρ · U² · Cl · A',
      vars: [vRho, vU, mathVar({ key: 'Cl', symbol: 'Cl', label: '揚力係数', unit: '', value: Cl, min: 0.01, max: 3, log: true, source: Cl0 !== undefined && Math.abs(Cl0) > 0.01 ? 'シミュレーション' : '迎角を付けた翼の目安' }), vA],
      resultSymbol: 'Fl',
      resultLabel: '揚力の大きさ',
      resultUnit: 'N',
      evaluate: (v) => 0.5 * v.rho * v.U ** 2 * v.Cl * v.A,
      substituted: (v) => `= 0.5 × ${formatSub(v.rho)} × ${formatPow(v.U, 2)} × ${formatSub(v.Cl)} × ${formatSub(v.A)}`,
      steps: [
        '翼を傾けて（迎角を付けて）流れに入れると、流れは下向きに曲げられます。',
        '流れを下へ曲げると、その反作用で翼は上に押されます。これが揚力です。',
        '形は抗力と同じで、動圧 ½ρU² × 面積 A × 係数（揚力係数 Cl）。',
        '迎角を大きくすると Cl は増えますが、約 15° を超えると流れが翼から剥がれて（失速）急に減ります。',
      ],
      insight: powerInsight('Fl', [
        { key: 'rho', symbol: 'ρ', exp: 1 },
        { key: 'U', symbol: 'U', exp: 2 },
        { key: 'Cl', symbol: 'Cl', exp: 1 },
        { key: 'A', symbol: 'A', exp: 1 },
      ]),
      topics: [topic('三角関数', '高校'), topic('三平方・ベクトル', '中学'), topic('積分', '大学')],
      why: [
        {
          question: '翼の上の流れが速いと、なぜ持ち上がるの？',
          answer: '速い流れのところは圧力が低くなります（ベルヌーイの定理）。翼の上は圧力が低く、下は高いので、その差で上向きの力がかかります。表面の圧力を全部足し合わせた（積分した）ものが揚力です。',
        },
        {
          question: '迎角はどんな数学？',
          answer: '流れの向きと翼の弦（前縁から後縁への線）のなす角度です。流れの速度を「翼に沿う成分（cos）」と「翼に垂直な成分（sin）」に分けると、垂直な成分が大きいほど流れを大きく曲げられます。',
        },
      ],
      approx: '2D 計算なので、翼の幅（スパン方向）の端で起きる流れ（翼端渦）は含みません。実際の飛行機の翼は、この値より揚力が小さくなります。',
      simulation: lift !== undefined ? { label: 'シミュレーションの揚力（大きさ）', value: Math.abs(lift), unit: 'N' } : undefined,
    };

    const T0 = f.L / (St * f.U);
    const strouhal: Formula = {
      id: 'flow-strouhal',
      title: '渦ができる周波数（ストローハル数）',
      expression: 'f = St · U / L',
      vars: [mathVar({ key: 'St', symbol: 'St', label: 'ストローハル数', unit: '', value: St, min: 0.05, max: 0.5, log: true, source: St0 !== undefined ? 'シミュレーション' : '円柱は約 0.2' }), vU, vL],
      resultSymbol: 'f',
      resultLabel: '渦の周波数',
      resultUnit: 'Hz',
      evaluate: (v) => (v.St * v.U) / v.L,
      substituted: (v) => `= ${formatSub(v.St)} × ${formatSub(v.U)} / ${formatSub(v.L)}`,
      steps: [
        `円柱の後ろにできる渦は、一定のリズムで左右交互に放たれます。いまの値なら約 ${formatValue(T0, 's')} に 1 周期です。`,
        '実験すると、渦と渦の間隔は円柱の幅 L のおよそ 1/St 倍（St = 0.2 なら 5 倍）で、流速によらずほぼ一定です。',
        '流れがその間隔 L/St を進むのにかかる時間が 1 周期 T = L / (St·U)。周波数はその逆数なので f = 1/T = St·U / L。',
        'St は形が同じなら、ほぼ一定の値（円柱は Re が 300〜10⁵ で約 0.2）。流速 U が 2 倍なら渦の周波数も 2 倍になります。',
        '電線が風でヒューと鳴る音（エオルス音）や、橋のケーブルが揺れる原因がこの周波数です。',
      ],
      insight: powerInsight('f', [
        { key: 'St', symbol: 'St', exp: 1 },
        { key: 'U', symbol: 'U', exp: 1 },
        { key: 'L', symbol: 'L', exp: -1 },
      ]),
      topics: [topic('比例・一次関数', '中学'), topic('複素数・フーリエ', '大学')],
      why: [
        {
          question: '周波数ってなに？ 周期とはちがう？',
          answer: '周期 T は「1 回ぶん揺れるのにかかる時間」、周波数 f は「1 秒に何回揺れるか」。T = 1/f の関係です。T = 0.5 秒なら f = 2 Hz。',
        },
        {
          question: 'フーリエ変換とのつながりは？',
          answer: '揚力の時間変化は、ほぼ正弦波（サインカーブ）の揺れです。複雑な揺れをいろいろな周波数のサインカーブの足し算に分けるのがフーリエ変換で、渦の周波数はそのいちばん大きな山として見つかります。',
        },
      ],
      approx: '円柱では St ≈ 0.2 ですが、角のある形や翼では値が変わります。また 2D 計算は 3 次元の乱れを含まないので、Re が高いと実際とずれます。',
    };

    return [reynolds, dragF, liftF, strouhal];
  },
};
