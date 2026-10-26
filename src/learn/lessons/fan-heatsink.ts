import { topic } from '../topics';
import type { Lesson } from '../types';
import { scalarOf } from './helpers';

export const fanHeatsinkLesson: Lesson = {
  id: 'fan-heatsink',
  presetId: 'fan-heatsink',
  title: 'ファンの風は、どれだけ熱を運ぶ？',
  summary: '風が運び出す熱を、風速に比例・反比例の式で見積もります。風を強くしたとき、部品の温度がどれだけ下がるかを確かめます。',
  level: '中学',
  topics: [topic('比例・一次関数', '中学')],
  minutes: 8,
  steps: [
    {
      kind: 'theory',
      title: '発熱した分は、風が運び出す',
      body: `ヒートシンクの熱は、最後は**風**に乗って、ダクトの外へ出ていきます。温度が落ち着いたとき、

**発熱 P = 風が運び出す熱**

になっています。風が運べる熱の量は、

**運び出す熱 = ρ × cp × U × A × ΔT**

- **ρ × cp**: 空気 1 m³ を 1 K 温めるのに必要な熱（約 1200 J）
- **U × A**: 1 秒間に通り抜ける空気の体積。流速 U × ダクトの断面積 A
- **ΔT**: 風が通り抜けて、何度温まったか

P を決めて ΔT について解くと、**ΔT = P ÷ (ρ × cp × U × A)**。風が速いほど、風の温まり方は小さくなります（反比例）。`,
    },
    {
      kind: 'quiz',
      question: '発熱 8 W、ダクトの断面 0.07 m × 0.04 m、流速 0.8 m/s のとき、風は通り抜けるあいだに何 K 温まりますか？（ρ × cp ≈ 1200 J/(m³·K)）',
      choices: ['約 0.3 K', '約 3 K', '約 30 K', '約 300 K'],
      answer: 1,
      explanation: '1 秒に通る空気は 0.8 × 0.07 × 0.04 ≈ 0.0022 m³。1 K あたり 1200 × 0.0022 ≈ 2.7 W を運べるので、ΔT = 8 ÷ 2.7 ≈ 3 K。部品の温度は、この風の温まり方に、フィンの表面と風の温度差が足されたものです。',
    },
    {
      kind: 'try',
      title: '風を強くしてみよう',
      instruction: '流入速度を **1.2 m/s 以上**（いまの 1.5 倍）にして計算してみましょう。部品の最高温度はどうなりますか？',
      hint: 'かんたんモードの判定カードにある「風を強くする」ボタンでも、設定の流入速度でも変えられます。温度が落ち着くまで、数十秒かかります。',
      check: ({ project }) => project.flow.inletVelocity >= 1.2,
    },
    {
      kind: 'theory',
      title: '風を 2 倍にしても、温度上昇は半分にならない',
      body: `風の温まり方 ΔT は、風速に反比例します。でも、部品の温度は **風の温度 + フィンの表面と風の温度差** で決まります。

表面から風へ熱が渡る**やすさ**は、風速が 2 倍になっても 2 倍にはならず、**約 1.4 倍**（風速の平方根）にしか増えません。

だから、風を 2 倍にしても、部品の温度上昇は半分にはならず、**約 0.7 倍**になります。冷やす効果は、風を強くするほど「頭打ち」になっていきます。`,
    },
    {
      kind: 'quiz',
      question: '風速を 4 倍にすると、表面から風への熱の渡りやすさは、およそ何倍になりますか？（風速の平方根に比例するとします）',
      choices: ['2 倍', '4 倍', '8 倍', '16 倍'],
      answer: 0,
      explanation: '√4 = 2 倍です。風を 4 倍にしても、効きは 2 倍。ファンを大きくするより、フィンの表面積を増やす方が効く場面もあります。',
    },
    {
      kind: 'practice',
      title: '部品に余裕を持たせよう',
      goal: '発熱する部品の**最高温度**を、上限 85°C から 10 K 以上離れた **75°C 以下**にしましょう。温度が落ち着くまで計算を続けて、この欄が ✓ になるのを待ちます。',
      hint: '風を強くするのが近道です。1.2 m/s で約 71°C になります。計算を始めた直後は温度が低いので、風が発熱の 85% 以上を運び出せるまで（温度が落ち着くまで）は ✓ になりません。',
      check: ({ result }) => {
        if (!result || result.analysis !== 'flow') return false;
        const maxT = scalarOf(result, 'maxTemp');
        const heatIn = scalarOf(result, 'heatIn');
        const heatOut = scalarOf(result, 'heatOut');
        if (maxT === undefined || heatIn === undefined || heatOut === undefined || !(heatIn > 0)) return false;
        return heatOut >= 0.85 * heatIn && maxT <= 75;
      },
    },
  ],
};
