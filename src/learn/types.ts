// 学びモードの契約（型だけ）。数学の窓・レッスン・各解析の式提供者はこのファイルの型でやり取りする。
// 単位はすべて SI 基本単位（m・N・Pa・W・K・Hz・s）で持つ。表示の接頭辞（mm・MPa・GHz）は format.ts が付ける。
import type { AnalysisKind, Project, ResultSet } from '../core/types';

// ---------- 数学の分野 ----------

/** 学び直しの段階。中学 → 高校 → 大学の順にやさしい */
export type MathLevel = '中学' | '高校' | '大学';

/** ROADMAP 「数学の学び直し」の分野 */
export type MathTopicName =
  | '比例・一次関数'
  | '三平方・ベクトル'
  | '三角関数'
  | '指数・対数'
  | '微分'
  | '積分'
  | '数列・収束'
  | '連立方程式・行列'
  | '偏微分方程式'
  | '複素数・フーリエ'
  | '数値解析';

/** 式やレッスンが使う数学の分野と、その使い方の段階 */
export interface MathTopic {
  name: MathTopicName;
  level: MathLevel;
}

// ---------- 数学の窓 ----------

/** 式の中の 1 つの変数。スライダーで動かせる */
export interface MathVar {
  /** evaluate / substituted / insight が値を取り出すキー */
  key: string;
  /** 式の中の記号（例: 'L'、'σy'） */
  symbol: string;
  /** 日本語の名前（例: '梁の長さ'） */
  label: string;
  /** value の単位（SI 基本単位。例: 'm'、'Pa'）。無次元は '' */
  unit: string;
  /** 今のプロジェクトから取り出した値（スライダーの「元に戻す」位置） */
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** true なら対数目盛りのスライダー（1e9〜4e11 のように桁が広い量） */
  log?: boolean;
  /** スライダー横の値の表示。省略時は SI 接頭辞つき（200 mm など） */
  display?: (v: number) => string;
  /** true ならスライダーなしの定数（光速など） */
  fixed?: boolean;
  /** この値をどう決めたかの補足（「荷重の合計から」など）。表示は任意 */
  source?: string;
}

/** 式の結果と比べるシミュレーション値（resultUnit と同じ単位で持つ） */
export interface SimulationValue {
  /** 例: 'FEM の最大変位' */
  label: string;
  value: number;
  unit: string;
  /** 比べるときの注意（例: 根元の応力集中で FEM の方が大きく出る） */
  note?: string;
}

/** 「なぜ？」の掘り下げ。中学の知識まで降りて説明してよい */
export interface WhyEntry {
  question: string;
  answer: string;
}

export interface Formula {
  id: string;
  title: string;
  /** 式を文字で書いたもの。例: 'δ = P·L³ / (3·E·I)' */
  expression: string;
  vars: MathVar[];
  resultSymbol: string;
  resultLabel: string;
  /** 結果の単位（SI 基本単位） */
  resultUnit: string;
  /** vars のキー → 値 の辞書から結果を出す（純粋関数） */
  evaluate(vars: Record<string, number>): number;
  /** 式に数字を入れた形。例: '= 100 × 0.2³ / (3 × 68.9×10⁹ × 1.67×10⁻⁹)' */
  substituted(vars: Record<string, number>): string;
  /** 導き方を普通の言葉で（1 項目 1 ステップ） */
  steps?: string[];
  /** スライダーを動かしたときの一言。base は元の値。変化がなければ null */
  insight?(vars: Record<string, number>, base: Record<string, number>): string | null;
  topics: MathTopic[];
  why?: WhyEntry[];
  /** 式がシミュレーションの近似であるときの説明（梁の理論と 2D FEM の違いなど） */
  approx?: string;
  /** 結果が出ているとき、比べるシミュレーション値 */
  simulation?: SimulationValue;
}

/** 数学の窓・レッスンが見る「いまのアプリの状態」 */
export interface LearnContext {
  project: Project;
  /** 計算結果。まだ計算していないときは null（式は既定値で動く） */
  result: ResultSet | null;
}

/** 解析の種類ごとの式の提供者。DOM に触れない純粋関数 */
export interface MathProvider {
  kind: AnalysisKind;
  formulas(input: LearnContext): Formula[];
}

// ---------- レッスン ----------

export type LessonStep =
  | {
      kind: 'theory';
      title: string;
      /** 短い段落を空行で区切る。**太字** と「- 」で始まる箇条書きが使える */
      body: string;
      /** 数学の窓で開く式の id */
      formulaId?: string;
    }
  | {
      kind: 'try';
      title: string;
      instruction: string;
      hint?: string;
      /** アプリの状態から達成を確かめる。省略時は「やってみた」ボタン */
      check?: (ctx: LearnContext) => boolean;
    }
  | {
      kind: 'quiz';
      title?: string;
      question: string;
      choices: string[];
      /** 正解の番号（0 始まり） */
      answer: number;
      explanation: string;
    }
  | {
      kind: 'practice';
      title: string;
      goal: string;
      hint?: string;
      check?: (ctx: LearnContext) => boolean;
    };

export interface Lesson {
  id: string;
  /** presets.ts の id */
  presetId: string;
  title: string;
  /** 一言の紹介（一覧に出す） */
  summary: string;
  level: MathLevel;
  topics: MathTopic[];
  /** かかる時間の目安（分） */
  minutes: number;
  steps: LessonStep[];
}

/** 学ぶ順番の 1 段階 */
export interface LearningStage {
  level: MathLevel;
  title: string;
  description: string;
  lessonIds: string[];
}

/** レッスンパネルの途中経過（保存・復元に使う） */
export interface LessonState {
  lessonId: string;
  /** いま開いているステップ（0 始まり） */
  stepIndex: number;
  /** ステップごとの完了（theory は見たら、quiz は正解したら、try / practice は達成したら） */
  completed: Record<number, boolean>;
  /** クイズで最後に選んだ番号 */
  quizChoice: Record<number, number>;
  /** 最後のステップまで終えた */
  done: boolean;
}

/** レッスンごとの進み具合（localStorage に保存） */
export interface LessonProgress {
  done: boolean;
  /** 最後に開いていたステップ */
  step?: number;
  /** 完了したステップの数 */
  completedSteps?: number;
  /** 更新時刻（ms） */
  updatedAt?: number;
}
