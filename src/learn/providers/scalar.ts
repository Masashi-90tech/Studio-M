// 対流拡散（動画の Excel）の式。セルペクレ数・ハイブリッド法の係数・セルの更新式・収束。
import { resolveProject } from '../../core/auto';
import type { Project, ResultSet } from '../../core/types';
import { formatSig, formatSub } from '../format';
import { powerInsight, ratioInsight } from '../insight';
import { topic } from '../topics';
import type { Formula, MathProvider } from '../types';
import { mathVar, scalarOf } from './common';

/** セルの幅 Δx [m]。結果があればその格子、なければ自動格子 */
export function cellWidth(project: Project, result: ResultSet | null): number {
  if (result && result.h > 0) return result.h;
  try {
    return resolveProject(project, 'scalar').grid.h;
  } catch {
    return project.domain.width / Math.max(project.domain.nx, 1);
  }
}

/** ペクレ数の言い方（2 が中心差分とハイブリッド法の切り替わり） */
export function pecletWords(pe: number): string {
  if (!Number.isFinite(pe)) return '不明';
  if (pe <= 2) return '拡散が勝つ（中心差分でも安定）';
  return '対流が勝つ（風上側の値を使う必要がある）';
}

export const hybridW = (F: number, D: number): number => Math.max(F, D + F / 2, 0);
export const hybridE = (F: number, D: number): number => Math.max(-F, D - F / 2, 0);

/** 残差履歴から 1 反復あたりの縮み率 ρ を見積もる。見積もれなければ null */
export function residualRate(result: ResultSet | null): { rate: number; r0: number; k0: number } | null {
  const h = result?.history.find((x) => x.key === 'residual');
  if (!h || h.values.length < 3) return null;
  const n = h.values.length;
  const r0 = h.values[0];
  const r1 = h.values[n - 1];
  const dk = h.t[n - 1] - h.t[0];
  if (!(r0 > 0) || !(r1 > 0) || !(dk > 0) || r1 >= r0) return null;
  const rate = (r1 / r0) ** (1 / dk);
  return rate > 0 && rate < 1 ? { rate, r0, k0: h.t[0] } : null;
}

export const scalarProvider: MathProvider = {
  kind: 'scalar',
  formulas({ project, result }) {
    const { u, gamma, rho, phiInlet, phiBody } = project.scalar;
    const dx = cellWidth(project, result);
    const F0 = rho * u * dx;
    const D0 = gamma;
    const peSim = scalarOf(result, 'cellPeclet');
    const iterSim = scalarOf(result, 'iterations');
    const lerp = (a: number) => phiBody + (phiInlet - phiBody) * a;
    const grid = `セルの幅 Δx は ${formatSig(dx * 1000)} mm（格子から）です。`;

    const peclet: Formula = {
      id: 'scalar-peclet',
      title: 'セルペクレ数（流れと広がりの力くらべ）',
      expression: 'Pe = ρ · u · Δx / Γ',
      vars: [
        mathVar({ key: 'rho', symbol: 'ρ', label: '密度', unit: 'kg/m³', value: rho, min: 0.1, max: 1000, log: true, source: '解析の設定' }),
        mathVar({ key: 'u', symbol: 'u', label: '流速', unit: 'm/s', value: u, source: '解析の設定' }),
        mathVar({ key: 'dx', symbol: 'Δx', label: 'セルの幅', unit: 'm', value: dx, source: '格子' }),
        mathVar({ key: 'gamma', symbol: 'Γ', label: '拡散係数', unit: 'kg/(m·s)', value: gamma, min: 1e-4, max: 100, log: true, source: '解析の設定' }),
      ],
      resultSymbol: 'Pe',
      resultLabel: 'セルペクレ数',
      resultUnit: '',
      evaluate: (v) => (v.rho * v.u * v.dx) / v.gamma,
      substituted: (v) => `= ${formatSub(v.rho)} × ${formatSub(v.u)} × ${formatSub(v.dx)} / ${formatSub(v.gamma)}`,
      steps: [
        'インクを水に落とすと、流れに運ばれて（対流）、同時にじわっと広がります（拡散）。',
        '1 つのセルで考えると、対流の強さは F = ρ·u·Δx（セルの面を通る流量）、拡散の強さは D = Γ。',
        '2 つの比 F / D がセルペクレ数 Pe = ρ·u·Δx / Γ です。',
        'Pe が小さい（約 2 以下）と拡散が勝ち、両隣の値の平均に近い、素直な計算で大丈夫。',
        'Pe が大きい（2 より上）と対流が勝ちます。このとき両隣の平均を使うと、計算が振動してしまいます。流れの上流側の値を使う「風上」の考え方が必要です。',
      ],
      insight: (vars, base) => {
        const power = powerInsight('Pe', [
          { key: 'rho', symbol: 'ρ', exp: 1 },
          { key: 'u', symbol: 'u', exp: 1 },
          { key: 'dx', symbol: 'Δx', exp: 1 },
          { key: 'gamma', symbol: 'Γ', exp: -1 },
        ])(vars, base);
        if (!power) return null;
        const pe = (vars.rho * vars.u * vars.dx) / vars.gamma;
        return `${power}。いまは${pecletWords(pe)}`;
      },
      topics: [topic('数値解析', '大学'), topic('比例・一次関数', '中学')],
      why: [
        {
          question: 'なぜ「2」が境目なの？',
          answer: '中心差分で作った係数 aE = D − F/2 が、F が D の 2 倍を超えるとマイナスになるからです。係数がマイナスということは「東隣が大きいほど自分は小さくなる」という不自然な式で、計算が波打って壊れます。F/D = Pe = 2 がちょうど境目です。',
        },
        {
          question: 'Δx を小さくすれば解決する？',
          answer: 'はい。Pe は Δx に比例するので、セルを細かくすれば Pe を 2 以下にできます。その代わりセルの数が増えて計算が重くなります。ハイブリッド法は、細かくしなくても安定に計算できる工夫です。',
        },
      ],
      approx: `${grid} 解析では 2D のセルごとに同じ値を使っています。`,
      simulation: peSim !== undefined ? { label: 'シミュレーションのセルペクレ数', value: peSim, unit: '' } : undefined,
    };

    const vF = mathVar({ key: 'F', symbol: 'F', label: '対流（流量）ρ·u·Δx', unit: '', value: F0, source: 'ρ·u·Δx' });
    const vD = mathVar({ key: 'D', symbol: 'D', label: '拡散 Γ', unit: '', value: D0, source: 'Γ' });
    const hybridWhy = {
      question: 'ハイブリッド法はなぜ「max」を使うの？',
      answer:
        'max(F, D + F/2, 0) は、3 つの候補の大きいほうを選びます。Pe ≤ 2 のときは D + F/2（平均を使う中心差分）が大きく、Pe > 2 のときは F（上流の値だけを使う風上差分）が大きい。' +
        '「最後の 0」は、係数が決してマイナスにならないようにする安全装置です。場合分けを 1 つの max で書けるのがポイントです。',
    };
    const aW: Formula = {
      id: 'scalar-hybrid-aw',
      title: 'ハイブリッド法の係数（上流の西側）',
      expression: 'aW = max( F,  D + F/2,  0 )',
      vars: [vF, vD],
      resultSymbol: 'aW',
      resultLabel: '西隣の係数',
      resultUnit: '',
      evaluate: (v) => hybridW(v.F, v.D),
      substituted: (v) => `= max( ${formatSig(v.F)}, ${formatSig(v.D)} + ${formatSig(v.F)}/2, 0 ) = max( ${formatSig(v.F)}, ${formatSig(v.D + v.F / 2)}, 0 )`,
      steps: [
        'セルの値 φP は、両隣の値に引っぱられて決まります。西隣（流れの上流）の影響の強さが aW です。',
        '拡散だけなら影響は D。流れがあると上流の値が運ばれてくるぶん、影響が強まります。',
        'Pe が小さいときは aW = D + F/2。Pe が大きいときは aW = F。その切り替えを max で書いたのがハイブリッド法です。',
        'Excel では、このセルに =MAX(F, D+F/2, 0) と書くだけです。',
      ],
      insight: ratioInsight('aW', { F: 'F', D: 'D' }, (v) => hybridW(v.F, v.D)),
      topics: [topic('数値解析', '大学'), topic('微分', '高校')],
      why: [hybridWhy],
      approx: '1 次元の流れ方向（x）に流速があるときの係数です。上下（y）方向には流れがないので、aN = aS = D です。',
    };
    const aE: Formula = {
      id: 'scalar-hybrid-ae',
      title: 'ハイブリッド法の係数（下流の東側）',
      expression: 'aE = max( −F,  D − F/2,  0 )',
      vars: [vF, vD],
      resultSymbol: 'aE',
      resultLabel: '東隣の係数',
      resultUnit: '',
      evaluate: (v) => hybridE(v.F, v.D),
      substituted: (v) => `= max( −${formatSig(v.F)}, ${formatSig(v.D)} − ${formatSig(v.F)}/2, 0 ) = max( ${formatSig(-v.F)}, ${formatSig(v.D - v.F / 2)}, 0 )`,
      steps: [
        '東隣は流れの下流です。下流の値は、上流には届きにくい（流れに逆らう）ので、影響が弱くなります。',
        'Pe が小さいときは aE = D − F/2（拡散から対流ぶんを引く）。',
        'Pe が 2 を超えると D − F/2 がマイナスになるので、max によって 0 になります。下流の値は無視する、という意味です。',
      ],
      insight: ratioInsight('aE', { F: 'F', D: 'D' }, (v) => hybridE(v.F, v.D)),
      topics: [topic('数値解析', '大学')],
      why: [hybridWhy],
      approx: '流れが +x 向き（左から右）の場合の係数です。逆向きの流れでは東と西が入れ替わります。',
    };

    const aEv = hybridE(F0, D0);
    const aWv = hybridW(F0, D0);
    const phiSymbols = { phiW: 'φW', phiE: 'φE', phiN: 'φN', phiS: 'φS' };
    const gsEval = (v: Record<string, number>): number => {
      const aP = v.aE + v.aW + v.aN + v.aS;
      return aP > 0 ? (v.aE * v.phiE + v.aW * v.phiW + v.aN * v.phiN + v.aS * v.phiS) / aP : 0;
    };
    const coefVar = (key: string, symbol: string, label: string, value: number) => mathVar({ key, symbol, label, unit: '', value, min: 0, max: Math.max(value * 4, 0.01), log: false, source: 'ハイブリッド法の係数' });
    const phiVar = (key: string, symbol: string, label: string, value: number) => mathVar({ key, symbol, label, unit: '', value, min: Math.min(phiBody, phiInlet), max: Math.max(phiBody, phiInlet) || 1, log: false, source: 'φ の例' });
    const gs: Formula = {
      id: 'scalar-gauss-seidel',
      title: 'Excel のセルの式（ガウス・ザイデル法）',
      expression: 'φP = (aE·φE + aW·φW + aN·φN + aS·φS) / aP　（aP = aE + aW + aN + aS）',
      vars: [
        coefVar('aE', 'aE', '東隣の係数', aEv),
        coefVar('aW', 'aW', '西隣の係数', aWv),
        coefVar('aN', 'aN', '北隣の係数', D0),
        coefVar('aS', 'aS', '南隣の係数', D0),
        phiVar('phiE', 'φE', '東隣の値', lerp(0.3)),
        phiVar('phiW', 'φW', '西隣の値', lerp(0.8)),
        phiVar('phiN', 'φN', '北隣の値', lerp(0.5)),
        phiVar('phiS', 'φS', '南隣の値', lerp(0.5)),
      ],
      resultSymbol: 'φP',
      resultLabel: 'このセルの新しい値',
      resultUnit: '',
      evaluate: gsEval,
      substituted: (v) => {
        const aP = v.aE + v.aW + v.aN + v.aS;
        return `= (${formatSig(v.aE)}×${formatSig(v.phiE)} + ${formatSig(v.aW)}×${formatSig(v.phiW)} + ${formatSig(v.aN)}×${formatSig(v.phiN)} + ${formatSig(v.aS)}×${formatSig(v.phiS)}) / ${formatSig(aP)}`;
      },
      steps: [
        '各セルの値は、「両隣の値の重みつき平均」で決まる、という式です。重みが a（係数）です。',
        '重みの合計が aP なので、重みつき平均は (Σ a·φ) / aP。aP は 4 つの係数の合計です。',
        'Excel では、1 つのセルに =(E5*C4 + W5*A4 + N5*B3 + S5*B5) / P5 のように書き、全部のセルにコピーします。これがそのまま計算の本体です。',
        'でも隣のセルも同じ式で動いているので、1 回では答えになりません。Excel の「反復計算」で、全セルを何周も更新し続けます。',
        '更新した最新の値を、すぐ次のセルの計算に使うやり方がガウス・ザイデル法です。何周かすると値が動かなくなる（収束する）ので、そこが答えです。',
      ],
      insight: (vars, base) => {
        const parts: string[] = [];
        for (const [key, symbol] of Object.entries({ ...phiSymbols, aE: 'aE', aW: 'aW', aN: 'aN', aS: 'aS' })) {
          if (Math.abs(vars[key] - base[key]) > 1e-12) parts.push(`${symbol} を ${formatSig(base[key])} → ${formatSig(vars[key])}`);
        }
        if (parts.length === 0) return null;
        return `${parts.join('、')} にすると φP は ${formatSig(gsEval(base))} → ${formatSig(gsEval(vars))}`;
      },
      topics: [topic('数値解析', '大学'), topic('連立方程式・行列', '大学'), topic('数列・収束', '高校')],
      why: [
        {
          question: 'なぜこれで微分方程式が解けるの？',
          answer: '対流拡散の式は、各点の値と、その周りの値の関係（微分）を表します。微分を「隣との差」に置き換えて整理すると、各セルについて「自分 = 隣の重みつき平均」という足し算・掛け算だけの式になります。それが上の式です。',
        },
        {
          question: 'これは連立方程式なの？',
          answer: 'そうです。セル 1 個につき 1 本の式があり、未知数はセルの数だけあります。セルが 数万個 なら数万元の連立方程式。ガウス・ザイデル法は、これを何周も回して少しずつ正解に近づける方法です。',
        },
      ],
      approx: `セル 1 つを取り出した計算です。実際は全セルが同時に動いているので、1 回の計算では答えになりません（次の「収束」の式を見てください）。${grid}`,
    };

    const rate = residualRate(result);
    const tol0 = project.scalar.advanced?.tolerance ?? 1e-8;
    const rho0 = rate ? rate.rate : 0.999;
    const k0 = rate ? rate.k0 : 0;
    const convEval = (v: Record<string, number>): number => k0 + Math.log(v.tol / v.r0) / Math.log(v.rate);
    const conv: Formula = {
      id: 'scalar-convergence',
      title: '何周で収束するか（等比数列と対数）',
      expression: 'rₖ = r₀ · ρᵏ　→　k = log(tol / r₀) / log(ρ)',
      vars: [
        mathVar({ key: 'r0', symbol: 'r₀', label: '最初の残差', unit: '', value: rate ? rate.r0 : 1, min: 1e-6, max: 1e3, log: true, source: rate ? '残差の履歴' : '規格化した値' }),
        mathVar({ key: 'tol', symbol: 'tol', label: '収束判定', unit: '', value: tol0, min: 1e-12, max: 1e-2, log: true, source: '解析の設定' }),
        mathVar({ key: 'rate', symbol: 'ρ', label: '1 周あたりの縮み率', unit: '', value: rho0, min: 0.5, max: 0.99999, log: false, step: 0.0001, display: (x) => formatSig(x, 5), source: rate ? '残差の履歴から見積り' : '仮の値' }),
      ],
      resultSymbol: 'k',
      resultLabel: '収束までの反復回数',
      resultUnit: '回',
      evaluate: convEval,
      substituted: (v) => `= ${formatSig(k0)} + log(${formatSig(v.tol)} / ${formatSig(v.r0)}) / log(${formatSig(v.rate, 5)})`,
      steps: [
        '残差とは、いまの値が方程式をどれだけ満たしていないかの目安です。答えに近づくほど小さくなります。',
        'ガウス・ザイデル法では、1 周するごとに残差がだいたい同じ割合 ρ（0 < ρ < 1）倍に縮みます。',
        'だから k 周後の残差は r₀, r₀ρ, r₀ρ², … と続く等比数列：rₖ = r₀ · ρᵏ。',
        'これが収束判定 tol より小さくなる周回数 k を求めるには、r₀ρᵏ = tol を k について解きます。指数の中の k を取り出すのが対数です：k = log(tol / r₀) / log ρ。',
        'ρ が 1 に近いほど、縮み方が遅く、周回数が爆発的に増えます。ρ = 0.99 なら約 230 周で 1/10 に、ρ = 0.999 なら約 2300 周かかります。',
        '緩和係数 ω（SOR）は、この ρ を小さくして収束を速める工夫です。',
      ],
      insight: ratioInsight('k', { r0: 'r₀', tol: 'tol', rate: 'ρ' }, convEval),
      topics: [topic('数列・収束', '高校'), topic('指数・対数', '高校'), topic('数値解析', '大学')],
      why: [
        {
          question: 'なぜ ρ が 1 に近いと急に遅くなるの？',
          answer: 'k は log(ρ) で割るので、ρ が 1 に近づくと log(ρ) が 0 に近づき、k が急に大きくなります。ρ = 0.9 → 0.99 → 0.999 と近づけるたびに、必要な周回数が約 10 倍ずつ増えます。',
        },
        {
          question: 'なぜ縮み率がほぼ一定になるの？',
          answer: '反復は「同じ計算を何度も繰り返す」ので、1 周ごとの誤差の変わり方も同じです。行列で言えば、誤差に同じ行列を掛け続けることになり、最終的にいちばん縮みにくい成分が支配して、一定の率 ρ になります（ρ は行列の固有値）。',
        },
      ],
      approx: `縮み率が一定という仮定の見積りです。最初のうちは速く縮み、あとでゆっくりになるなど、実際の履歴は少し曲がります。${rate ? '残差の履歴から ρ を見積もりました。' : 'まだ履歴がないので、ρ は仮の値です。'}`,
      simulation: iterSim !== undefined ? { label: 'シミュレーションの反復回数', value: iterSim, unit: '回', note: '収束するまでに実際に回った数です。' } : undefined,
    };

    return [peclet, aW, aE, gs, conv];
  },
};
