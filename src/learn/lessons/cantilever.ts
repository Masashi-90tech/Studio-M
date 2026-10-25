import { beamParams } from '../providers/stress';
import { topic } from '../topics';
import type { Lesson } from '../types';
import { scalarOf } from './helpers';

export const cantileverLesson: Lesson = {
  id: 'cantilever',
  presetId: 'cantilever',
  title: '片持ち梁のたわみ — 3 乗の世界',
  summary: 'δ = PL³/(3EI)。長さと厚みが 3 乗で効くことを、手計算とシミュレーションの両方で確かめます。',
  level: '高校',
  topics: [topic('指数・対数', '高校'), topic('比例・一次関数', '中学'), topic('積分', '大学')],
  minutes: 12,
  steps: [
    {
      kind: 'theory',
      title: '机から定規を突き出すと',
      body: `机のふちから定規を突き出して、先を指で押してみてください。長く出すほどぐにゃっと曲がります。これが**片持ち梁**です。

先端のたわみ δ は、材料力学の教科書では

**δ = P × L³ ÷ (3 × E × I)**

- **P**: 先端にかける力
- **L**: 梁の長さ
- **E**: 材料の硬さ（縦弾性係数）
- **I**: 断面の形による曲がりにくさ

この梁（アルミ A6061、長さ 200 mm、断面 10 × 10 mm、荷重 100 N）なら、約 4.6 mm。シミュレーションと比べるのが今日の目標です。`,
      formulaId: 'stress-deflection',
    },
    {
      kind: 'theory',
      title: '曲がりにくさ I と、h の 3 乗',
      body: `長方形の断面（奥行き t、高さ h）では **I = t × h³ ÷ 12**。

高さ h が**3 乗**で効きます。高さを 2 倍にすると、

- 材料が 2 倍に増える
- その材料が真ん中から 2 倍遠くなる（てこの腕）
- 遠くの材料ほど、曲がりに強く逆らう

この 3 つの 2 倍が掛け合わさって、2 × 2 × 2 = **8 倍**曲がりにくくなります。定規を寝かせると曲がり、立てると曲がらないのはこのためです。`,
      formulaId: 'stress-inertia',
    },
    {
      kind: 'try',
      title: '長さを 2 倍にしてみよう',
      instruction: '数学の窓の「片持ち梁の先端のたわみ」で、**梁の長さ L** のスライダーを動かして 2 倍にしてみましょう。δ は何倍になりますか？',
      hint: 'スライダーは対数目盛りなので、真ん中から右へ 4 分の 1 動かすと 2 倍です。窓の青い帯に「L が 2 倍 → δ は 8 倍」と出ます。',
    },
    {
      kind: 'quiz',
      question: '梁の長さ L を半分にすると、先端のたわみ δ は何倍になりますか？',
      choices: ['1/2 倍', '1/4 倍', '1/8 倍', '変わらない'],
      answer: 2,
      explanation: 'δ は L の 3 乗に比例します。(1/2)³ = 1/8。長さを半分にするだけで、たわみは 8 分の 1 になります。',
    },
    {
      kind: 'quiz',
      question: '梁の高さ h を 2 倍にしたとき、たわみ δ と、根元の応力 σ（σ = 6PL ÷ t h²）は、それぞれ何倍になりますか？',
      choices: ['δ は 1/8、σ は 1/4', 'δ は 1/4、σ は 1/8', 'δ は 1/8、σ は 1/8', 'δ は 1/2、σ は 1/2'],
      answer: 0,
      explanation: 'δ は I ∝ h³ の分母なので 1/8。σ は h² の分母なので 1/4。たわみのほうが厚みに敏感です。厚みで剛性（曲がりにくさ）を稼ぐのは、とても効率がよい手です。',
    },
    {
      kind: 'try',
      title: '手計算とシミュレーションを比べよう',
      instruction: '「計算」を実行して、**最大変位**が手計算の約 4.6 mm に近いことを、数学の窓の「シミュレーションとの比較」で確かめましょう。',
      hint: '梁理論は細長い梁の近似、シミュレーションは 2D の要素法です。数 % のちがいは、荷重のかけ方や固定端の扱いから出ます。',
      check: ({ result }) => {
        const d = scalarOf(result, 'maxDisplacement');
        return d !== undefined && d > 0.0040 && d < 0.0052;
      },
    },
    {
      kind: 'practice',
      title: 'たわみを 2 mm 以下に',
      goal: '梁の形か材料を変えて、手計算のたわみ δ を **2 mm 以下**にしましょう。数学の窓の δ の欄で確かめられます。',
      hint: '高さ h を 10 mm から 13.5 mm にすると 1/2.5 くらい。材料を鉄（SS400、E = 206 GPa）にする手もあります。どちらが軽く済むか、考えてみましょう。',
      check: ({ project }) => {
        const b = beamParams(project);
        const I = (b.t * b.h ** 3) / 12;
        return b.fromShapes && (b.P * b.L ** 3) / (3 * b.E * I) <= 0.002;
      },
    },
  ],
};
