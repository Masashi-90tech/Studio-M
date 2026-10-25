import { topic } from '../topics';
import type { Lesson } from '../types';
import { areaOfMaterial } from './helpers';

// 基板の熱: レギュレーターの損失 → 部品の温度（熱抵抗） → 銅ベタ → ファン。
// 将来 KiCad の基板を取り込んだプリセットが増えたときも、同じ式（heat-ldo-loss / heat-junction / heat-copper-mix）を使う。
export const boardLesson: Lesson = {
  id: 'board',
  presetId: 'board',
  title: '基板のどこが熱くなる？',
  summary: 'レギュレーターの損失から、部品の温度、銅ベタとファンの効き目まで。電気の「オームの法則」と同じ形で、基板の熱を読みます。',
  level: '中学',
  topics: [topic('比例・一次関数', '中学')],
  minutes: 10,
  steps: [
    {
      kind: 'theory',
      title: '電圧を捨てると、熱になる',
      body: `基板でよく熱くなるのは、**LDO（リニアレギュレーター）**です。5 V の電源から 3.3 V を作るとき、余った 1.7 V をそのまま捨てています。

捨てた電圧は、熱になります。電力は「電圧 × 電流」なので、

**P = (Vin − Vout) × I**

- Vin − Vout: 捨てる電圧
- I: 流れる電流

電流が 2 倍になれば、熱も 2 倍。これは比例です。5 V から 3.3 V を 0.5 A で作ると、P = 1.7 × 0.5 = **0.85 W** も熱になります。`,
      formulaId: 'heat-ldo-loss',
    },
    {
      kind: 'quiz',
      question: '12 V の電源から LDO で 5 V を作り、0.3 A 流しています。LDO は何 W の熱を出しますか？',
      choices: ['0.9 W', '1.5 W', '2.1 W', '3.6 W'],
      answer: 2,
      explanation: 'P = (Vin − Vout) × I = (12 − 5) × 0.3 = 2.1 W。5 V × 0.3 A = 1.5 W は負荷の仕事、残りの 2.1 W が LDO で熱になります。入力電圧が高いほど、LDO は熱くなります。',
    },
    {
      kind: 'theory',
      title: '熱にも「オームの法則」がある',
      body: `電気では **V = I × R** でした。熱もそっくりです。

- 電圧 V → **温度の差 ΔT**
- 電流 I → **熱の流れ P**（W）
- 抵抗 R → **熱抵抗 θ**（K/W）

つまり **ΔT = P × θ**。部品の温度は、周囲の温度 Ta にこれを足して、

**Tj = Ta + P × θja**

θja は「部品から周囲へ熱が逃げるまでの通りにくさ」。小さいほどよく冷えます。銅ベタを広げる、ファンで風を当てる、はどちらも θja を小さくすることです。`,
      formulaId: 'heat-junction',
    },
    {
      kind: 'quiz',
      question: 'CPU が 1.5 W の熱を出し、熱抵抗が 20 K/W の道で逃がしています。周囲が 25°C のとき、CPU は何°C になりますか？',
      choices: ['26.5°C', '38.5°C', '55°C', '77°C'],
      answer: 2,
      explanation: 'ΔT = P × θ = 1.5 W × 20 K/W = 30 K。Tj = Ta + ΔT = 25 + 30 = 55°C。単位も W × (K/W) = K と、きれいに消えます。',
    },
    {
      kind: 'theory',
      title: '銅ベタは、熱の通り道',
      body: `基板の熱は、板の面に沿って広がります。FR-4 の熱伝導率 k は約 0.3、銅は約 390。**1300 倍**もちがいます。

基板は、基材と銅箔が重なった板です。熱の通しやすさは、厚さで重み付けした平均になります。

**k_eff = (k_FR4 × (T − t_cu) + k_cu × t_cu) ÷ T**

銅箔 t_cu が板厚 T（1.6 mm）のわずか 2% でも、k_eff は基材の約 30 倍。銅箔を 35 µm から 70 µm（2oz）にすると、k_eff はほぼ 2 倍になります。

部品の下に**銅ベタ（広い銅箔）**を広げると、熱が基板全体に広がって、部品の温度が下がります。`,
      formulaId: 'heat-copper-mix',
    },
    {
      kind: 'practice',
      title: '銅パッドを広げよう',
      goal: '銅（C1100）の部分の面積の合計を、いまの約 670 mm² から **900 mm² 以上**に増やしてみましょう。そのあと計算して、最高温度が下がるか見てください。',
      hint: '銅パッドの長方形を大きくするか、新しい銅の長方形を発熱体のまわりに足します。熱を広げる道が太くなり、θ が小さくなります。',
      check: ({ project }) => areaOfMaterial(project, 'c1100') * 1e6 >= 900,
    },
    {
      kind: 'try',
      title: 'ファンで冷やしてみよう',
      instruction: '設定で**熱伝達率 h** を 25 W/(m²·K) 以上（小型ファンの目安）にして、計算してみましょう。銅パッドだけの場合と、最高温度を比べます。',
      hint: 'かんたんモードなら「冷やし方」を「小型ファン」にします。h が大きいほど、空気へ逃げる熱が増えて θja が小さくなります。',
      check: ({ project }) => project.heat.surfaceH >= 25,
    },
  ],
};
