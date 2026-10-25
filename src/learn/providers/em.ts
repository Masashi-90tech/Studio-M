// 電磁波の式。波長・半波長の厚み・板の透過率・dB・斜め入射・回折・距離による減衰。
import type { Material, Project } from '../../core/types';
import { formatSig, formatSub, formatValue } from '../format';
import { dbInsight, powerInsight, ratioInsight } from '../insight';
import { C0, amplitudeToDb, freeSpaceLossDb, halfWaveThickness, powerToDb, slabPower, toDeg, toRad, wavelength } from '../physics';
import { topic } from '../topics';
import type { Formula, MathProvider } from '../types';
import { bodies, bodiesBox, boxOf, mathVar, safeMaterial, scalarOf } from './common';

export interface EmInputs {
  freqHz: number;
  /** 背景の媒質の比誘電率 */
  mediumEpsR: number;
  /** 板として見る材料（最初の金属でない物体。なければ PLA） */
  slab: Material;
  /** 板の厚み [m]（長方形なら短辺。なければ半波長） */
  thickness: number;
  /** 物体の大きさ（回折の目安に使う長辺）[m] */
  size: number;
  /** 入射角（法線から）[度] */
  incidenceDeg: number;
  hasSlab: boolean;
  hasConductor: boolean;
}

export function emInputs(project: Project): EmInputs {
  const freqHz = Math.max(project.em.frequencyGHz, 1e-3) * 1e9;
  const medium = safeMaterial(project.em.mediumId, 'air');
  const list = bodies(project);
  const dielectric = list.find((s) => !safeMaterial(s.materialId).conductor);
  const slab = dielectric ? safeMaterial(dielectric.materialId) : safeMaterial('pla');
  let thickness = 0;
  if (dielectric) {
    const b = boxOf(dielectric.geom);
    thickness = Math.min(b.x1 - b.x0, b.y1 - b.y0);
  }
  if (!(thickness > 0)) thickness = halfWaveThickness(freqHz, slab.epsR ?? 1);
  const box = bodiesBox(project);
  const size = box ? Math.max(box.x1 - box.x0, box.y1 - box.y0) : 0.05;
  const angle = project.em.source === 'plane' ? Math.min(80, Math.abs(project.em.angleDeg) % 180) : 30;
  return {
    freqHz,
    mediumEpsR: medium.epsR ?? 1,
    slab,
    thickness,
    size,
    incidenceDeg: angle > 90 ? 180 - angle : angle,
    hasSlab: !!dielectric,
    hasConductor: list.some((s) => safeMaterial(s.materialId).conductor === true),
  };
}

const GHz = (v: number): string => `${formatSig(v / 1e9)} GHz`;
const DEG = (v: number): string => `${formatSig(v)}°`;
const pct = (v: number): string => `${formatSig(v)} %`;

const EPSR_WHY = {
  question: 'なぜ比誘電率 εr が大きいと波長が短くなるの？',
  answer:
    '電波は「電気の揺れ」が隣へ隣へと伝わっていくものです。誘電体の中では、物質が電気を溜めるぶん伝わるのが遅くなります（速さは c/√εr）。周波数 f は変わらないので、速さ ÷ 周波数 = 波長 が短くなります。波が詰まったバネのように縮むイメージです。',
};

export const emProvider: MathProvider = {
  kind: 'em',
  formulas({ project, result }) {
    const e = emInputs(project);
    const epsR = e.slab.epsR ?? 1;
    const tanD = e.slab.tanD ?? 0;
    const trans = scalarOf(result, 'transmission');
    const lambdaSim = scalarOf(result, 'wavelength');
    const slabNote = e.hasSlab
      ? `板の材料は ${e.slab.name}（εr = ${formatSig(epsR)}、tanδ = ${formatSig(tanD)}）、厚みは物体の短辺 ${formatValue(e.thickness, 'm')} から取っています。`
      : '板になる物体がないので、PLA の板を仮に置いています。';
    const metalNote = e.hasConductor ? '金属は電波をほとんど通さず反射します（この式は誘電体の板用です）。' : '';

    const vF = mathVar({ key: 'f', symbol: 'f', label: '周波数', unit: 'Hz', value: e.freqHz, display: GHz, source: '解析の周波数' });
    const vC = mathVar({ key: 'c', symbol: 'c', label: '光速', unit: 'm/s', value: C0, fixed: true, display: () => '3.00×10⁸ m/s' });
    const vEps = mathVar({ key: 'epsR', symbol: 'εr', label: '比誘電率', unit: '', value: epsR, min: 1, max: 80, log: true, source: e.slab.name });
    const vD = mathVar({ key: 'd', symbol: 'd', label: '板の厚み', unit: 'm', value: e.thickness, source: '物体の短辺' });
    const vTan = mathVar({ key: 'tanD', symbol: 'tanδ', label: '誘電正接（損失）', unit: '', value: tanD || 0.001, min: 1e-4, max: 0.3, log: true, source: e.slab.name });

    const lam: Formula = {
      id: 'em-wavelength',
      title: '波長（電波の「ものさし」）',
      expression: 'λ = c / f',
      vars: [vC, vF],
      resultSymbol: 'λ',
      resultLabel: '空気中の波長',
      resultUnit: 'm',
      evaluate: (v) => v.c / v.f,
      substituted: (v) => `= ${formatSub(v.c)} / ${formatSub(v.f)}`,
      steps: [
        '電波は 1 秒間に f 回振動しながら、光と同じ速さ c で進みます。',
        '1 回振動する間に進む距離が波長 λ。だから λ = 速さ ÷ 回数 = c / f。',
        '周波数が高い（f が大きい）ほど、波長は短くなります（反比例）。2.4 GHz の Wi-Fi は約 12.5 cm、24 GHz のレーダーは約 12.5 mm。',
        '波長は、電波にとっての「ものさし」です。物体の大きさが波長より大きいか小さいかで、電波の振る舞いが変わります。',
      ],
      insight: powerInsight('λ', [{ key: 'f', symbol: 'f', exp: -1 }]),
      topics: [topic('比例・一次関数', '中学'), topic('三角関数', '高校')],
      why: [
        {
          question: 'なぜ「速さ ÷ 回数 = 距離」になるの？',
          answer: '中学の「速さ = 距離 ÷ 時間」と同じです。1 回振動する時間は 1/f 秒。その間に進む距離は 速さ × 時間 = c × (1/f) = c / f。',
        },
        {
          question: 'GHz の「G」はなに？',
          answer: 'G（ギガ）は 10⁹ = 10 億倍です。24 GHz は 1 秒に 240 億回の振動。k（キロ）が 10³、M（メガ）が 10⁶、G が 10⁹ と覚えます。',
        },
      ],
      approx: '真空（ほぼ空気）中の波長です。解析の背景が空気でなければ、媒質中の波長はこれを √εr で割ったものになります。',
      simulation: lambdaSim !== undefined ? { label: 'シミュレーションの波長（背景の媒質中）', value: lambdaSim / 1000, unit: 'm' } : undefined,
    };

    const lamIn: Formula = {
      id: 'em-wavelength-material',
      title: '物質の中では波長が縮む',
      expression: 'λm = λ / √εr = c / (f · √εr)',
      vars: [vC, vF, vEps],
      resultSymbol: 'λm',
      resultLabel: '物質の中の波長',
      resultUnit: 'm',
      evaluate: (v) => v.c / v.f / Math.sqrt(v.epsR),
      substituted: (v) => `= ${formatSub(v.c)} / (${formatSub(v.f)} × √${formatSub(v.epsR)})`,
      steps: [
        '電波が物質（プラスチック、ガラス、コンクリート）に入ると、速さが c/√εr に遅くなります。',
        '周波数 f は変わらないので、波長 = 速さ ÷ 周波数 も 1/√εr 倍に縮みます。',
        `いまの ${e.slab.name}（εr = ${formatSig(epsR)}）なら、波長は空気中の 1/${formatSig(Math.sqrt(epsR))} です。`,
        'εr が 4 倍になると √4 = 2 で、波長は半分。平方根が出てくる典型例です。',
      ],
      insight: powerInsight('λm', [
        { key: 'f', symbol: 'f', exp: -1 },
        { key: 'epsR', symbol: 'εr', exp: -0.5 },
      ]),
      topics: [topic('指数・対数', '高校'), topic('比例・一次関数', '中学')],
      why: [EPSR_WHY],
      approx: '損失（tanδ）が小さい材料での近似です。損失が大きい材料では、波が弱まりながら進みます。',
    };

    const half: Formula = {
      id: 'em-halfwave',
      title: 'よく電波を通す厚み（半波長）',
      expression: 'd = λ / (2 · √εr) = c / (2 · f · √εr)',
      vars: [vC, vF, vEps],
      resultSymbol: 'd',
      resultLabel: 'いちばん通る厚み',
      resultUnit: 'm',
      evaluate: (v) => v.c / v.f / (2 * Math.sqrt(v.epsR)),
      substituted: (v) => `= ${formatSub(v.c)} / (2 × ${formatSub(v.f)} × √${formatSub(v.epsR)})`,
      steps: [
        '板の表面と裏面では、それぞれ電波の一部が反射します。2 つの反射波が逆向きに重なって打ち消し合えば、反射はゼロになります。',
        '裏面の反射波は、板の中を 1 往復（距離 2d）ぶん遅れて戻ってきます。',
        '往復の距離 2d が、板の中の波長 λm のちょうど 1 つぶん（2d = λm）なら、遅れが 1 周期になって位相が元に戻ります。',
        '表面の反射（空気 → 板）では波の山と谷が入れ替わり、裏面の反射（板 → 空気）では入れ替わりません。だから 2 つの反射波は最初から逆向きで、遅れがちょうど 1 周期なら逆向きのまま重なって消えます。',
        'ここから d = λm / 2 = λ / (2√εr)。これが「半波長」の厚みです。',
        `PLA（εr = 2.8）の 24 GHz なら d ≈ 3.7 mm。レーダーカバーを 3.7 mm（またはその整数倍）にするのは、この計算からです。`,
      ],
      insight: powerInsight('d', [
        { key: 'f', symbol: 'f', exp: -1 },
        { key: 'epsR', symbol: 'εr', exp: -0.5 },
      ]),
      topics: [topic('三角関数', '高校'), topic('指数・対数', '高校')],
      why: [
        {
          question: '「打ち消し合う」って、数学ではどういうこと？',
          answer: '波は sin のグラフで表せます。sin の山に、ちょうど半周期ずれた sin（谷）を足すと、山と谷が打ち消してゼロの直線になります。これを「逆位相」といいます。',
        },
        EPSR_WHY,
      ],
      approx: `垂直に当たる電波と、損失の小さい板の目安です。斜めに当たると必要な厚みが変わります（斜め入射の式を見てください）。${slabNote}`,
    };

    const slabT0 = slabPower(epsR, tanD, e.thickness, e.freqHz).transmission;
    const slabEval = (v: Record<string, number>): number => slabPower(v.epsR, v.tanD, v.d, v.f).transmission * 100;
    const slab: Formula = {
      id: 'em-slab',
      title: '板の透過率（反射の重なり）',
      expression: 'T = |t₁₂ · t₂₃ · e^(−jδ) / (1 − r₁₂² · e^(−2jδ))|²　（δ = 2π · n · d / λ）',
      vars: [vD, vEps, vTan, vF],
      resultSymbol: 'T',
      resultLabel: '電力の透過率',
      resultUnit: '%',
      evaluate: slabEval,
      substituted: (v) => {
        const n = Math.sqrt(v.epsR);
        const delta = (2 * Math.PI * n * v.d * v.f) / C0;
        const r1 = ((n - 1) / (n + 1)) ** 2;
        return `n = √${formatSig(v.epsR)} = ${formatSig(n)}、δ = 2π × ${formatSig(n)} × ${formatSig(v.d)} / ${formatSig(wavelength(v.f))} = ${formatSig(delta)} rad（1 面の反射 ${pct(r1 * 100)}）→ T = ${pct(slabEval(v))}`;
      },
      steps: [
        '板に電波が当たると、表面で一部が反射し、残りが板の中に入ります。裏面でもまた一部が反射して戻り、行き来を繰り返します。',
        '1 つの面の反射率は R = ((n − 1)/(n + 1))²。n = √εr が空気（1）から離れるほど、反射が大きくなります（PLA で約 6 %）。',
        '波は「大きさと位相（ずれ）」を持つので、複素数で表すと足し算が楽になります。板の中を通ると位相が δ = 2π·n·d/λ だけ進み、これが e^(−jδ)（複素数）です。',
        '表面の反射、裏面で反射して戻ってきた波、さらに行き来した波……を全部足すと、等比数列の和 1/(1 − r²e^(−2jδ)) になります。',
        '透過する電力は、この複素数の大きさの 2 乗。d が半波長の整数倍なら、反射が打ち消し合って T がほぼ 100 % になります。',
        '損失 tanδ が大きいと、板の中で電波が熱になって減ります。',
      ],
      insight: (vars, base) => {
        const T = slabEval(vars);
        const T0 = slabEval(base);
        const changed = Object.keys(vars).some((k) => Math.abs(vars[k] - base[k]) > 1e-9 * Math.abs(base[k]));
        if (!changed) return null;
        const k = vars.d / halfWaveThickness(vars.f, vars.epsR);
        const near = Math.round(k);
        const q = k * 2;
        let tail = '';
        if (k >= 0.45 && Math.abs(k - near) < 0.06 && near >= 1) tail = `（厚みは半波長の ${near} 倍に近いので、反射が打ち消し合います）`;
        else if (Math.abs(q - Math.round(q)) < 0.12 && Math.round(q) % 2 === 1) tail = `（厚みは 1/4 波長の奇数倍に近いので、反射が強め合って通りにくい厚みです）`;
        return `透過は ${pct(T0)} → ${pct(T)}${tail}`;
      },
      topics: [topic('複素数・フーリエ', '大学'), topic('数列・収束', '高校'), topic('三角関数', '高校')],
      why: [
        {
          question: 'なぜ複素数を使うの？',
          answer: '波は「大きさ」と「位相（山の位置のずれ）」の 2 つの情報を持ちます。複素数なら 1 つの数で両方を持てて、「位相を進める」が「e^(−jδ) を掛ける」というただの掛け算になります。sin と cos の加法定理を、まとめて計算してくれる道具です。',
        },
        {
          question: 'なぜ等比数列の和が出てくるの？',
          answer: '裏面で反射して戻る → 表面でまた反射して進む……を繰り返すたびに、波は同じ倍率 r²e^(−2jδ) が掛かります。1 回目、2 回目、3 回目……を足すと a + ar + ar² + … = a/(1 − r)。高校の等比級数の公式そのものです。',
        },
      ],
      approx: `垂直入射・無限に広い板の厳密な式です。2D シミュレーションは板が有限で縁から電波が回り込むため、透過率が少しずれたり 100 % を超えて見えたりします。${slabNote}${metalNote}`,
      simulation: trans !== undefined ? { label: 'シミュレーションの透過率', value: trans, unit: '%', note: '板の縁での回り込みの影響を含みます。' } : undefined,
    };

    const oblique: Formula = {
      id: 'em-oblique',
      title: '斜めに入射すると、板の中の道のりが伸びる',
      expression: 'sin θt = sin θi / √εr　→　d′ = d / cos θt',
      vars: [
        vD,
        mathVar({ key: 'theta', symbol: 'θi', label: '入射角（板の垂線から）', unit: '°', value: Math.max(e.incidenceDeg, 0.1), min: 0, max: 80, log: false, step: 1, display: DEG, source: '平面波の向き' }),
        vEps,
      ],
      resultSymbol: 'd′',
      resultLabel: '板の中を通る道のり',
      resultUnit: 'm',
      evaluate: (v) => {
        const sinT = Math.sin(toRad(v.theta)) / Math.sqrt(v.epsR);
        return v.d / Math.sqrt(1 - sinT * sinT);
      },
      substituted: (v) => {
        const sinT = Math.sin(toRad(v.theta)) / Math.sqrt(v.epsR);
        return `sin θt = sin ${DEG(v.theta)} / √${formatSig(v.epsR)} = ${formatSig(sinT)}、θt = ${DEG(toDeg(Math.asin(sinT)))} → d′ = ${formatSig(v.d)} / cos θt`;
      },
      steps: [
        '斜めに当たった電波は、板に入るときに折れ曲がります（屈折）。空気中の角度 θi と、板の中の角度 θt の関係がスネルの法則 sin θt = sin θi / n です。',
        '板の中の電波が進む道は斜めの線です。厚み d の板を、角度 θt で斜めに横切ると、道のりは直角三角形の斜辺になります。',
        'cos θt = d / d′ なので、d′ = d / cos θt。斜めになるほど cos が小さくなり、道のりが長くなります。',
        '道のりが伸びると、位相の進みも変わります。だから、斜めに当たるレーダーでは、いちばん通る厚みが垂直のときと変わります。',
      ],
      insight: ratioInsight('d′', { d: 'd', theta: 'θi', epsR: 'εr' }, (v) => {
        const sinT = Math.sin(toRad(v.theta)) / Math.sqrt(v.epsR);
        return v.d / Math.sqrt(1 - sinT * sinT);
      }),
      topics: [topic('三角関数', '高校'), topic('三平方・ベクトル', '中学')],
      why: [
        {
          question: 'sin と cos の関係 sin² + cos² = 1 は、ここでどう使う？',
          answer: 'sin θt が分かれば、cos θt = √(1 − sin²θt) で求められます。直角三角形で、斜辺を 1 にしたときの「高さ」と「底辺」の 2 乗を足すと 1（三平方の定理）だからです。',
        },
      ],
      approx: '道のりの長さだけを見た目安です。斜めの入射では、偏波（TM / TE）によって各面の反射率も変わるので、実際の透過率はこの道のりだけでは決まりません。',
    };

    const diffraction: Formula = {
      id: 'em-diffraction',
      title: '回り込み（回折）の広がり',
      expression: 'sin θ = λ / D',
      vars: [
        vF,
        vC,
        mathVar({ key: 'D', symbol: 'D', label: '物体（すき間）の大きさ', unit: 'm', value: e.size, source: '物体の長辺' }),
      ],
      resultSymbol: 'θ',
      resultLabel: '回り込みの広がりの角度',
      resultUnit: '°',
      evaluate: (v) => toDeg(Math.asin(Math.min(1, v.c / v.f / v.D))),
      substituted: (v) => `= asin(${formatSig(v.c / v.f)} / ${formatSig(v.D)}) = asin(${formatSig(Math.min(1, v.c / v.f / v.D))})`,
      steps: [
        '波は、すき間や物体の縁を通ると、直進せずに広がります（回折）。海の波が防波堤の裏へ回り込むのと同じです。',
        '広がる角度 θ は、波長 λ とすき間の大きさ D の比で決まります：sin θ = λ / D。',
        'D が λ よりずっと大きいと sin θ は小さく、ほとんど直進します（かげができる）。D が λ に近いと、大きく広がります。',
        'Wi-Fi（波長 12.5 cm）が出入口（90 cm）から広がるのも、レーダー（波長 12.5 mm）が鋭いビームになるのも、この比です。',
      ],
      insight: ratioInsight('θ', { f: 'f', D: 'D' }, (v) => toDeg(Math.asin(Math.min(1, v.c / v.f / v.D)))),
      topics: [topic('三角関数', '高校'), topic('複素数・フーリエ', '大学')],
      why: [
        {
          question: 'sin θ = λ/D はどこから来たの？',
          answer: 'すき間の両端から出た波の道のりの差が、ちょうど 1 波長ぶんになる方向が、波が打ち消し合う最初の方向です。直角三角形で「対辺 ÷ 斜辺 = sin θ」を使うと、対辺が λ、斜辺が D になって sin θ = λ/D です（スリットの回折の目安）。',
        },
      ],
      approx: '幅 D のすき間（スリット）の最初の暗い方向を表す目安の式です。板の縁（ナイフエッジ）の回り込みは、もっとなだらかに広がります。',
    };

    const ratioP0 = trans !== undefined ? Math.max(trans / 100, 0.001) : Math.max(slabT0, 0.001);
    const dbPower: Formula = {
      id: 'em-db-power',
      title: 'dB（電力の比を対数で言う）',
      expression: 'dB = 10 · log₁₀(P₂ / P₁)',
      vars: [mathVar({ key: 'ratio', symbol: 'P₂/P₁', label: '電力の比', unit: '', value: ratioP0, min: 0.001, max: 10, log: true, source: trans !== undefined ? 'シミュレーションの透過率' : '板の透過率の計算' })],
      resultSymbol: 'dB',
      resultLabel: '電力の比（dB）',
      resultUnit: 'dB',
      evaluate: (v) => powerToDb(Math.max(v.ratio, 1e-12)),
      substituted: (v) => `= 10 × log₁₀(${formatSig(v.ratio)})`,
      steps: [
        '電波の強さは、桁がものすごく広がります（強い電波と弱い電波で 1 兆倍ちがう）。',
        'log₁₀ は「10 を何回掛けると、その数になるか」。100 なら 2、1000 なら 3、0.1 なら −1。大きい数も小さい数も、小さな数字で扱えます。',
        '電力の比を 10·log₁₀ で言い直したものが dB。電力が 10 倍なら +10 dB、1/10 なら −10 dB、2 倍なら約 +3 dB、半分なら約 −3 dB。',
        '壁を 2 枚通ると、電力は 0.5 × 0.5 = 0.25 倍。dB なら −3 + −3 = −6 dB と、掛け算が足し算になります。',
      ],
      insight: dbInsight('dB', { ratio: 'P₂/P₁' }, (v) => powerToDb(Math.max(v.ratio, 1e-12))),
      topics: [topic('指数・対数', '高校')],
      why: [
        {
          question: 'なぜ「対数」を使うと掛け算が足し算になるの？',
          answer: '10² × 10³ = 10⁵ のように、指数は足し算になります（2 + 3 = 5）。log はその指数を取り出す操作なので、log(a × b) = log a + log b。だから、損失が段々に重なるときは dB を足すだけで合計が出ます。',
        },
        {
          question: 'なぜ 10 倍して 10·log₁₀ なの？',
          answer: '元は「ベル」という単位で、log₁₀(電力比) をそのまま使っていました。値が小さくて使いにくいので、10 分の 1 の「デシベル」を使うようになりました。dB の d は deci（10 分の 1）です。',
        },
      ],
      approx: '電力の比の定義そのものなので、近似ではありません。透過率 T は電力の比なので、10·log₁₀(T) が透過損失（−の値）です。',
    };

    const dbAmp: Formula = {
      id: 'em-db-amplitude',
      title: 'dB（電圧・電場の振幅の比）',
      expression: 'dB = 20 · log₁₀(A₂ / A₁)',
      vars: [mathVar({ key: 'ratio', symbol: 'A₂/A₁', label: '振幅の比', unit: '', value: Math.sqrt(ratioP0), min: 0.001, max: 10, log: true, source: '電力の比の平方根' })],
      resultSymbol: 'dB',
      resultLabel: '振幅の比（dB）',
      resultUnit: 'dB',
      evaluate: (v) => amplitudeToDb(Math.max(v.ratio, 1e-12)),
      substituted: (v) => `= 20 × log₁₀(${formatSig(v.ratio)})`,
      steps: [
        '電力は振幅の 2 乗に比例します（振幅が 2 倍なら電力は 4 倍）。',
        '電力の比を dB にすると 10·log₁₀(振幅比²) = 10 × 2 × log₁₀(振幅比) = 20·log₁₀(振幅比)。',
        'だから、振幅（電圧・電場）の比では係数が 20 になります。振幅が 2 倍で +6 dB、10 倍で +20 dB。',
      ],
      insight: dbInsight('dB', { ratio: 'A₂/A₁' }, (v) => amplitudeToDb(Math.max(v.ratio, 1e-12))),
      topics: [topic('指数・対数', '高校')],
      why: [
        {
          question: '20 と 10 のちがいは、なぜ出るの？',
          answer: 'log(a²) = 2·log(a) という対数の性質のためです。電力 = 振幅² なので、電力の dB で 10 を掛けていたところが、振幅の dB では 2 倍の 20 になります。',
        },
      ],
      approx: '定義そのものなので近似ではありません。同じ現象でも、電力で言うか振幅で言うかで係数が 10 か 20 かが変わります。',
    };

    const fspl: Formula = {
      id: 'em-fspl',
      title: '距離による電波の弱まり',
      expression: 'L = 20 · log₁₀(4π · d · f / c)',
      vars: [
        mathVar({ key: 'dist', symbol: 'd', label: '距離', unit: 'm', value: 3, min: 0.3, max: 100, log: true, source: 'ルーターからの距離（仮）' }),
        vF,
        vC,
      ],
      resultSymbol: 'L',
      resultLabel: '距離による損失',
      resultUnit: 'dB',
      evaluate: (v) => freeSpaceLossDb(v.dist, v.f),
      substituted: (v) => `= 20 × log₁₀(4π × ${formatSig(v.dist)} × ${formatSig(v.f)} / ${formatSig(v.c)}) = 20 × log₁₀(${formatSig((4 * Math.PI * v.dist * v.f) / v.c)})`,
      steps: [
        '電波は点から球のように広がるので、距離 d の球の表面積 4πd² に電力が薄まります。電力は距離の 2 乗に反比例して弱くなります。',
        'これを dB にすると、距離が 2 倍になるごとに約 6 dB（電力は 1/4）減ります。',
        '周波数が高いほど、同じアンテナの大きさに受けられる電力が減るので、損失も大きくなります（f に比例して、dB では 20·log₁₀ f）。',
        '壁を通る損失（dB）は、この距離の損失（dB）に足し算できます。',
      ],
      insight: dbInsight('L', { dist: 'd', f: 'f' }, (v) => freeSpaceLossDb(v.dist, v.f)),
      topics: [topic('指数・対数', '高校')],
      why: [
        {
          question: '距離が 2 倍で 6 dB なのはなぜ？',
          answer: '電力は距離の 2 乗に反比例するので、距離 2 倍で電力 1/4。10·log₁₀(1/4) = −6.02 dB です。距離が 10 倍なら電力 1/100 で −20 dB です。',
        },
      ],
      approx: '壁や床のない、何もない空間（自由空間）の式です。部屋の中は壁の反射が重なるので、実際の弱まり方は式と違います。2D のシミュレーションは、球面ではなく円で広がる（1/d で弱まる）ので、また違います。',
    };

    return [lam, lamIn, half, slab, oblique, diffraction, dbPower, dbAmp, fspl];
  },
};
