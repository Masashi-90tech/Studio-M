import { topic } from '../topics';
import type { Lesson } from '../types';
import { bodies, boxOf } from '../providers/common';

export const metalShadowLesson: Lesson = {
  id: 'metal-shadow',
  presetId: 'metal-shadow',
  title: '金属板のかげと、電波の回り込み',
  summary: '波長と物体の大きさの比で、かげの深さと回り込みの角度が決まります。sin θ = λ / D を使います。',
  level: '高校',
  topics: [topic('三角関数', '高校')],
  minutes: 10,
  steps: [
    {
      kind: 'theory',
      title: '金属は電波を跳ね返す',
      body: `金属の表面では、電波の電場がほぼゼロになります。そのため、電波は金属を通れず、**ほとんど反射**します。

板の後ろには電波が届かない領域ができます。これが「かげ」です。

でも、かげは板の真後ろで終わりません。波は物体の縁を回り込みます（**回折**）。海の波が防波堤の裏へ回り込むのと同じです。`,
    },
    {
      kind: 'theory',
      title: '回り込みの広がりは sin θ = λ / D',
      body: `どのくらい回り込むかは、**波長 λ** と**板の大きさ D** の比で決まります：

**sin θ = λ ÷ D**

- D が λ よりずっと大きい → sin θ が小さい → ほとんど回り込まない（深いかげ）
- D が λ に近い → 大きく回り込む（かげが浅い）

直角三角形で、斜辺が D、向かいの辺が λ のとき、角度 θ の sin（サイン）が λ / D です。10 GHz の波長は 30 mm、板の高さは 70 mm なので、sin θ ≈ 0.43、θ ≈ **25°** になります。`,
      formulaId: 'em-diffraction',
    },
    {
      kind: 'quiz',
      question: '波長 λ = 30 mm、板の大きさ D = 70 mm のとき、回り込みの角度 θ はおよそいくつですか？（sin θ = λ ÷ D）',
      choices: ['8°', '25°', '43°', '90°'],
      answer: 1,
      explanation: 'sin θ = 30 ÷ 70 ≈ 0.43。sin 30° = 0.5 なので、それより少し小さい 25° 前後です。43 は sin θ の値そのもので、角度ではありません。',
    },
    {
      kind: 'try',
      title: '周波数を下げてみよう',
      instruction: '周波数を **5 GHz 以下**に下げて、計算してみましょう。波長が長くなるので、回り込みはどうなりますか？',
      hint: '10 GHz → 3 GHz にすると、波長は 30 mm → 100 mm。板の高さ 70 mm より長くなり、板は「かげ」を作りにくくなります。',
      check: ({ project }) => project.em.frequencyGHz <= 5,
    },
    {
      kind: 'quiz',
      question: '周波数を下げて波長を長くすると、板の後ろの「かげ」はどうなりますか？',
      choices: ['かげは大きくなる', 'かげは小さく（浅く）なる', '変わらない', 'かげが逆側にできる'],
      answer: 1,
      explanation: 'λ が長くなると sin θ = λ ÷ D が大きくなり、回り込みの角度が増えます。電波は物体より波長が長いほど物体を「またいで」進めるので、かげは浅くなります。低い周波数の電波が建物の裏へ届きやすいのは、このためです。',
    },
    {
      kind: 'practice',
      title: '板を大きくして、かげを深くしよう',
      goal: 'アルミ板の高さを、いまの 70 mm の 2 倍（**140 mm 以上**）にして計算し、かげの広がりを比べましょう。',
      hint: 'D が 2 倍になると sin θ は半分、θ はおよそ 12° になります（10 GHz のとき）。回り込みが小さくなり、かげが深く残ります。',
      check: ({ project }) =>
        bodies(project).some((s) => {
          const b = boxOf(s.geom);
          return b.y1 - b.y0 >= 0.139 || b.x1 - b.x0 >= 0.139;
        }),
    },
  ],
};
