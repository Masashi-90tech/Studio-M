import { topic } from '../topics';
import type { Lesson } from '../types';
import { hasResult } from './helpers';

export const wifiRoomLesson: Lesson = {
  id: 'wifi-room',
  presetId: 'wifi-room',
  title: 'Wi-Fi はどこまで届く？ — dB で考える',
  summary: '距離で弱くなる電波と、壁で弱くなる電波を、dB の足し算で見積もります。',
  level: '高校',
  topics: [topic('指数・対数', '高校'), topic('比例・一次関数', '中学')],
  minutes: 10,
  steps: [
    {
      kind: 'theory',
      title: '電波は広がるほど薄まる',
      body: `ルーターから出た電波は、風船がふくらむように四方へ広がります。同じ電力が広い面積に薄まるので、遠くほど弱くなります。

自由空間（何もない空間）では、電力は距離の **2 乗に反比例**して弱くなります。距離が 2 倍なら電力は 1/4。これを dB で言うと、**約 6 dB の損失**です。

2.4 GHz、距離 3 m なら、損失は約 50 dB。電力でいうと 1/100,000 です。`,
      formulaId: 'em-fspl',
    },
    {
      kind: 'theory',
      title: 'dB は「掛け算を足し算にする」道具',
      body: `**dB = 10 × log₁₀(電力の比)**

log₁₀ は「10 を何回掛けるとその数になるか」。1000 なら 3、0.001 なら −3 です。

ふつうの比では、壁を 2 枚通ると 0.25 × 0.25 = 0.0625 と掛け算が必要です。dB なら、**−6 dB + −6 dB = −12 dB** と足し算で済みます。

- 距離による弱まり（dB）
- 壁 1 枚ごとの弱まり（dB）

を全部足すと、部屋のどこでどれだけ弱いかが見積もれます。`,
      formulaId: 'em-db-power',
    },
    {
      kind: 'quiz',
      question: 'ルーターからの距離が 3 m から 6 m になりました。損失は約何 dB 増えますか？',
      choices: ['約 3 dB', '約 6 dB', '約 12 dB', '約 20 dB'],
      answer: 1,
      explanation: '距離が 2 倍だと電力は 1/4。10 × log₁₀(1/4) = −6.02 dB なので、約 6 dB 増えます。10 倍なら 20 dB です。',
    },
    {
      kind: 'quiz',
      question: '壁 1 枚で電力が 1/4（−6 dB）になるとします。壁を 2 枚通ると、電力は元の何分の 1 ですか？',
      choices: ['1/8', '1/12', '1/16', '1/32'],
      answer: 2,
      explanation: 'dB なら −6 + −6 = −12 dB。電力で言うと 1/4 × 1/4 = 1/16 で、−12 dB と一致します（10^(−1.2) ≈ 1/15.8）。',
    },
    {
      kind: 'quiz',
      question: '周波数を 2.4 GHz から 4.8 GHz（2 倍）にすると、同じ距離での自由空間の損失は約何 dB 増えますか？',
      choices: ['約 3 dB', '約 6 dB', '約 10 dB', '変わらない'],
      answer: 1,
      explanation: '損失 = 20 × log₁₀(4π d f ÷ c) で、f が 2 倍なら 20 × log₁₀2 ≈ 6 dB 増えます。高い周波数ほど同じ距離で弱くなり、壁でも減りやすい傾向があるので、5 GHz の Wi-Fi は 2.4 GHz より届きにくいのです。',
    },
    {
      kind: 'try',
      title: '電波が広がるようすを見よう',
      instruction: '「計算」を実行して、部屋の中の電波の広がりと、**出入口からの漏れ**を探してみましょう。',
      hint: 'コンクリートの壁の中では、波長が約 53 mm と、空気中の 125 mm より短く縮んでいます。壁の中の細かい縞に注目してみてください。',
      check: (ctx) => hasResult(ctx, 'em'),
    },
    {
      kind: 'practice',
      title: '木のドアを外したら？',
      goal: '**木のドア**を消して計算し直し、出入口から出る電波がドアありのときとどう変わるか比べましょう。',
      hint: '木のドアの形を選んで削除します。木は電波をある程度通しますが、εr と損失があるので、少し弱めています。',
      check: ({ project }) => !project.shapes.some((s) => s.materialId === 'wood'),
    },
  ],
};
