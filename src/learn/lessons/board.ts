import { topic } from '../topics';
import type { Lesson } from '../types';
import { areaOfMaterial } from './helpers';

export const boardLesson: Lesson = {
  id: 'board',
  presetId: 'board',
  title: '基板のどこが熱くなる？',
  summary: '電気の「オームの法則」と同じ形で、熱の通りにくさ（熱抵抗）を考えます。銅パッドが効く理由が分かります。',
  level: '中学',
  topics: [topic('比例・一次関数', '中学')],
  minutes: 8,
  steps: [
    {
      kind: 'theory',
      title: '熱にも「オームの法則」がある',
      body: `電気では、電圧 V をかけると電流 I が流れて、**V = I × R** でした。熱もそっくりです。

- 電圧 V → **温度の差 ΔT**
- 電流 I → **熱の流れ P**（W）
- 抵抗 R → **熱抵抗 R**（K/W）

つまり **ΔT = P × R**。熱が通りにくい道（R が大きい）ほど、同じ熱を流すのに大きな温度差が必要です。`,
      formulaId: 'heat-conduction',
    },
    {
      kind: 'theory',
      title: '熱抵抗は「長さ ÷ (材料 × 太さ)」',
      body: `R = L ÷ (k × A)

- **L**: 熱の通る道の長さ。長いほど通りにくい
- **A**: 道の断面積。太いほど通りやすい
- **k**: 熱伝導率。材料の「熱の通しやすさ」

FR-4（基板の材料）の k は約 0.3、銅は約 390。**1300 倍**もちがいます。基板の中の熱が広がらないのは、このためです。`,
      formulaId: 'heat-conduction',
    },
    {
      kind: 'try',
      title: '材料を FR-4 から銅に変えてみよう',
      instruction: '数学の窓の「熱の通りにくさ」で、**熱伝導率 k** のスライダーを右いっぱいまで動かしてみましょう。R はどうなりますか？',
      hint: 'k は対数目盛りのスライダーです。右へ動かすほど R は小さくなり、k が 2 倍で R は半分です。',
    },
    {
      kind: 'quiz',
      question: '同じ長さの銅の道で、断面積 A を 4 倍にしました。熱抵抗 R は何倍になりますか？',
      choices: ['4 倍', '2 倍', '1/2 倍', '1/4 倍'],
      answer: 3,
      explanation: 'R = L ÷ (k × A) で、A は分母にあります。A が 4 倍なら R は 1/4。道幅が 4 倍の道路は、4 倍の車が通れる、というイメージです。',
    },
    {
      kind: 'quiz',
      question: 'CPU が 1.5 W の熱を出し、熱抵抗が 20 K/W の道で逃がしています。CPU は周りより何 K 高くなりますか？',
      choices: ['0.075 K', '13.5 K', '30 K', '21.5 K'],
      answer: 2,
      explanation: 'ΔT = P × R = 1.5 W × 20 K/W = 30 K。単位も W × (K/W) = K と、きれいに消えます。',
    },
    {
      kind: 'practice',
      title: '銅パッドを広げよう',
      goal: '銅（C1100）の部分の面積の合計を、いまの約 670 mm² から **900 mm² 以上**に増やしてみましょう。そのあと計算して、最高温度が下がるか見てください。',
      hint: '銅パッドの長方形を大きくするか、新しい銅の長方形を発熱体のまわりに足します。熱を広げる道が太くなり、R が小さくなります。',
      check: ({ project }) => areaOfMaterial(project, 'c1100') * 1e6 >= 900,
    },
  ],
};
