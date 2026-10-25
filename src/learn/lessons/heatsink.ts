import { topic } from '../topics';
import type { Lesson } from '../types';
import { scalarOf } from './helpers';

export const heatsinkLesson: Lesson = {
  id: 'heatsink',
  presetId: 'heatsink',
  title: 'ヒートシンクは、なぜ冷える？',
  summary: '発熱 10 W のアルミのフィン。「出る熱 = 入る熱」で温度が決まることを、比例と反比例で見ます。',
  level: '中学',
  topics: [topic('比例・一次関数', '中学')],
  minutes: 8,
  steps: [
    {
      kind: 'theory',
      title: '温度は「熱の出入り」で決まる',
      body: `10 W の発熱体は、スイッチを入れているあいだ、ずっと熱を出し続けます。

その熱は、空気にふれている**表面**から逃げていきます。

- 温度が低いうちは、逃げる熱が少ないので、温度は上がる
- 温度が上がると、逃げる熱が増える
- **入る熱 = 出る熱** になったところで、温度は止まる

この「止まった状態」を**定常状態**といいます。シミュレーションが求めているのも、この温度です。`,
      formulaId: 'heat-balance',
    },
    {
      kind: 'theory',
      title: '式にすると、反比例になる',
      body: `空気へ逃げる熱は Q = h × A × ΔT です。

- **h**: 熱の逃げやすさ（冷やし方）。ファンがあると大きい
- **A**: 表面積
- **ΔT**: 室温より何度高いか

入る熱 P と等しいので、P = h × A × ΔT。ΔT について解くと、

**ΔT = P ÷ (h × A)**

分母の A や h を大きくするほど、ΔT は小さくなります。これが反比例です。ヒートシンクのフィンは、A を増やすための形です。`,
      formulaId: 'heat-convection',
    },
    {
      kind: 'try',
      title: '面積を 2 倍にしてみよう',
      instruction: '数学の窓の「温度上昇の目安」を開き、**放熱面積 A** のスライダーを動かして 2 倍にしてみましょう。ΔT はどうなりましたか？',
      hint: '「A が 2 倍 → ΔT は半分」と、窓に出るはずです。スライダーの真ん中が元の値で、右へ動かすと大きくなります。',
    },
    {
      kind: 'quiz',
      question: 'フィンを増やして表面積 A を 3 倍に、さらにファンを付けて h を 2 倍にしました。温度上昇 ΔT は元の何倍になりますか？',
      choices: ['1/6 倍', '1/5 倍', '5 倍', '6 倍'],
      answer: 0,
      explanation: 'ΔT = P ÷ (h × A) で、分母が 3 × 2 = 6 倍になります。だから ΔT は 1/6 倍。たし算ではなく、かけ算で効くところがポイントです。',
    },
    {
      kind: 'try',
      title: '小型ファンを付けてみよう',
      instruction: '設定で**熱伝達率 h** を 25 W/(m²·K) 以上（小型ファンの目安）にして、計算してみましょう。',
      hint: 'かんたんモードなら「冷やし方」を「小型ファン」にします。プロモードなら熱伝達率の欄に 25 を入れます。',
      check: ({ project }) => project.heat.surfaceH >= 20,
    },
    {
      kind: 'practice',
      title: '温度上昇を 20 K 以下に',
      goal: 'シミュレーションの**平均温度**が、室温より 20 K 以上は高くならないようにしましょう。計算が終わると、この欄が ✓ になります。',
      hint: 'h を 25 にすると、式では ΔT ≈ 14 K です。式の答えとシミュレーションが近いことも確かめてみてください。',
      check: ({ project, result }) => {
        const avg = scalarOf(result, 'avgTemp');
        return avg !== undefined && avg - project.heat.ambientC <= 20;
      },
    },
  ],
};
