import { emInputs } from '../providers/em';
import { slabTransmission } from '../../core/slab';
import { topic } from '../topics';
import type { Lesson } from '../types';

export const radarCoverLesson: Lesson = {
  id: 'radar-cover',
  presetId: 'radar-cover',
  title: 'レーダーカバーの厚みを決める',
  summary: '24 GHz の電波を通す PLA カバー。波長・半波長・dB の計算で、なぜ 3.7 mm なのかが分かります。',
  level: '高校',
  topics: [topic('三角関数', '高校'), topic('指数・対数', '高校'), topic('複素数・フーリエ', '大学')],
  minutes: 12,
  steps: [
    {
      kind: 'theory',
      title: '電波の「ものさし」は波長',
      body: `電波は 1 秒に f 回ゆれながら、光と同じ速さ c で進みます。1 回ゆれる間に進む距離が**波長 λ**。

**λ = c ÷ f**（速さ = 距離 ÷ 時間 の形です）

24 GHz なら、λ = 3.0×10⁸ ÷ 24×10⁹ ≈ **12.5 mm**。周波数が高いほど波長は短くなります。

プラスチックの中では電波が遅くなり、波長も縮みます。**λ_材料 = λ ÷ √εr**。PLA（εr = 2.8）なら √2.8 ≈ 1.67 で割って、約 7.5 mm です。`,
      formulaId: 'em-wavelength-material',
    },
    {
      kind: 'theory',
      title: '半波長の厚みなら、反射が消える',
      body: `板の表面と裏面では、それぞれ電波が少し反射します。この 2 つの反射波が**逆向き**に重なると、打ち消し合って反射がなくなります。

打ち消し合うのは、板の中の波長のちょうど**半分**の厚みのとき：

**d = λ ÷ (2 × √εr)**

PLA で 24 GHz なら、d = 12.5 ÷ (2 × 1.67) ≈ **3.7 mm**。プリセットのカバーの厚みは、この計算で決まっています。`,
      formulaId: 'em-halfwave',
    },
    {
      kind: 'quiz',
      question: 'PLA（εr = 2.8）のカバーが 24 GHz の電波をいちばんよく通す、いちばん薄い厚みはどれですか？',
      choices: ['1.9 mm', '3.7 mm', '6.2 mm', '12.5 mm'],
      answer: 1,
      explanation: '半波長の厚み d = λ ÷ (2√εr) = 12.5 mm ÷ (2 × 1.67) ≈ 3.7 mm。1.9 mm はその半分（1/4 波長）で、いちばん反射が強め合う厚みです。12.5 mm は空気中の波長そのものです。',
    },
    {
      kind: 'try',
      title: '厚みを 1.9 mm にしてみよう',
      instruction: 'カバーの厚みを **1.9 mm**（半波長のほぼ半分）にして、計算してみましょう。透過率はどうなりますか？',
      hint: 'カバーの長方形の幅（x 方向の大きさ）を 1.9 mm に変えます。数学の窓の「板の透過率」では、厚み d を動かしても確かめられます（約 76 % になります）。',
      check: ({ project }) => {
        const t = emInputs(project).thickness;
        return Math.abs(t - 1.9e-3) < 0.15e-3;
      },
    },
    {
      kind: 'theory',
      title: '透過率を dB で言う',
      body: `電波の強さは桁がものすごく広いので、**dB（デシベル）**で言います。

**dB = 10 × log₁₀(電力の比)**

- 電力が 10 倍 → +10 dB、1/10 → −10 dB
- 電力が 2 倍 → 約 +3 dB、半分 → 約 −3 dB
- 掛け算が足し算になる。カバーを 2 枚通れば、dB を足すだけ

透過 96 % なら 10 × log₁₀(0.96) ≈ −0.18 dB。ほとんど損失なしです。`,
      formulaId: 'em-db-power',
    },
    {
      kind: 'quiz',
      question: '電波の透過率が 50 %（電力が半分）になったとき、約何 dB の損失ですか？',
      choices: ['−1 dB', '−3 dB', '−5 dB', '−10 dB'],
      answer: 1,
      explanation: '10 × log₁₀(0.5) = −3.01 dB。「半分は約 −3 dB」は、電波の世界でよく使う覚え方です。−10 dB は電力が 1/10 になる場合です。',
    },
    {
      kind: 'practice',
      title: '半波長の 2 倍の厚みでも通るか確かめよう',
      goal: 'カバーの厚みを、半波長の **2 倍（約 7.5 mm）**にして、板の透過率の計算値が **90 % 以上**になることを確かめましょう。',
      hint: '半波長の整数倍なら、反射は打ち消し合います。ただし厚くなると、材料の損失（tanδ）で電波が少しずつ熱になって減ります。数学の窓の「板の透過率」で、3.7 mm と見比べてください。',
      check: ({ project }) => {
        const e = emInputs(project);
        if (!e.hasSlab || Math.abs(e.thickness - 3.73e-3) < 0.3e-3) return false;
        return slabTransmission(e.slab.epsR ?? 1, e.slab.tanD ?? 0, e.thickness, e.freqHz).transmission >= 0.9;
      },
    },
  ],
};
