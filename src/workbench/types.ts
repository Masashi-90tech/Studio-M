// ワークベンチの契約。1 つの解析（流れ・熱・強度・電磁波・対流拡散）に関する知識を 1 つのモジュールにまとめる。
//
// メイン画面（ハーネス: src/main.ts と src/ui/ のシェル）は、解析の種類を `if (kind === 'em')` のように
// 見分けずに、登録表（registry.ts）から WorkbenchModule を引いて使う。
// 解析を足す・直すときは、モジュール（modules/<kind>.ts）とその部品だけを触り、画面側は変えない。
//
// 約束:
//  - 項目を足すときは省略可能（`?`）にし、省略したら「何も特別なことをしない」動きにする
//  - 重いもの（ソルバー・パネル）は `load…()` で遅延 import する。モジュール本体は軽く保つ
//  - verdict など `load…` でない関数は、DOM に触れない純粋関数にする（毎フレーム呼ばれてもよいように）
import type { AnalysisKind, Material, Project, Raster, ResultSet, SolverFactory, SolverStatus } from '../core/types';
import type { MathProvider } from '../learn/types';
import type { Prefs } from '../ui/modes';
import type { Paint } from '../ui/overlay';
import type { CanvasView } from '../ui/render';
import type { Runner } from '../ui/runner';
import type { Store } from '../ui/state';

// ---------- パネル ----------

/** パネルを作るときに渡すもの */
export interface PanelOptions {
  /** アプリの状態（プロジェクト・表示モード・選択など） */
  store: Store;
  /** 計算ループ（結果・格子・ステータスを読む） */
  runner: Runner;
  /** パネルを描く先。パネルはこの中だけを触る */
  container: HTMLElement;
}

/** 作ったパネルの操作口。ホスト（settings / easy-panel）が呼ぶ */
export interface PanelHandle {
  /** プロジェクトや計算が変わったとき、表示中の値（読み出し欄・入力欄）を最新にする。省略可 */
  refresh?(): void;
  /** 毎フレーム呼ばれる。軽く保ち、必要なときだけ DOM を触る。省略可 */
  update?(): void;
  /**
   * パネルの「作り」が変わる条件を文字列で返す（例: 点波源かどうかで出す案内が変わる）。
   * 値が変わると、ホストはパネルを作り直す。値の変更だけで済むもの（数値など）は含めない。省略可
   */
  structureKey?(): string;
  /** container に足したものを片づける（解析・モードの切り替え時に呼ばれる） */
  dispose(): void;
}

/** パネルの作り方。作ったらすぐ container に描き、操作口を返す */
export type PanelFactory = (opts: PanelOptions) => PanelHandle;

/** パネルの種類: 標準モードの設定 / かんたんモードの質問 / プロモードの詳細設定 / 結果ボックスの追加表示 */
export type PanelSlot = 'settings' | 'easy' | 'pro' | 'results';

// ---------- キャンバスの重ね描き ----------

export interface OverlayOptions {
  store: Store;
  view: CanvasView;
}

/** 解析ごとの重ね描き（電磁波の波源の印など）の操作口 */
export interface OverlayHandle {
  /** キャンバスに重ねて描く。毎フレーム（再描画のたび）呼ばれる */
  draw?(paint: Paint): void;
  /** イベントなどを外す */
  dispose(): void;
}

export type OverlayFactory = (opts: OverlayOptions) => OverlayHandle;

// ---------- 判定 ----------

export type VerdictLevel = 'ok' | 'warn' | 'ng' | 'info' | 'pending';

/** 次の一手（かんたんモードのボタン）。適用は WorkbenchModule.applyAction */
export type VerdictAction =
  | { kind: 'thicker'; factor: number; label: string }
  | { kind: 'material'; materialId: string; label: string }
  | { kind: 'cooling'; h: number; label: string }
  | { kind: 'slab'; thicknessMm: number; label: string }
  /** 基板の銅箔の厚さを factor 倍にする（熱。project.pcb の各層の thicknessUm） */
  | { kind: 'copper'; factor: number; label: string }
  /** 部品を選んで、発熱などを見直せるようにする（熱） */
  | { kind: 'review'; shapeId: string; label: string };

export interface Verdict {
  level: VerdictLevel;
  /** チップに出す短い文字（OK / 注意 / NG / 目安 / 計算中） */
  chip: string;
  /** いちばん大きく見せる一文 */
  headline: string;
  /** 補足の行 */
  lines: string[];
  actions: VerdictAction[];
}

/** 平板（空気中）の電力透過率。core/slab.ts の slabTransmission と同じ形 */
export type SlabFn = (epsR: number, tanD: number, thicknessM: number, freqHz: number) => { transmission: number; reflection: number };

/** 判定に渡すもの。DOM を含まない */
export interface VerdictInput {
  kind: AnalysisKind;
  /** 格子を決め終えた計算用のプロジェクト */
  project: Project;
  result: ResultSet | null;
  status: SolverStatus | null;
  raster: Raster | null;
  prefs: Prefs;
  /** 電磁波の「おすすめの厚み」に使う平板の式。省略時は core/slab.ts の式 */
  slab?: SlabFn;
}

// ---------- 注意書き・表示の癖 ----------

/** 解析前の注意（物体がない、支持がない…）を作るための入力 */
export interface HintInput {
  /** 格子を決め終えた計算用のプロジェクト */
  project: Project;
  raster: Raster;
}

/** キャンバスの描き方の違い */
export interface ViewTraits {
  /** 速度場（ux, uy）に mask がないとき、どのセルを有効とみなすか: 'fluid' = 流体セル、'solid' = 物体セル */
  vectorMask?: 'fluid' | 'solid';
  /** 「流線を動かす」を使える（速度場があるとき） */
  particles?: boolean;
  /** 「変形を強調表示」を使える（変位場があるとき） */
  deform?: boolean;
}

// ---------- ワークベンチ ----------

/**
 * 1 つの解析のまとめ。登録表（registry.ts）に 1 種類につき 1 つだけ登録する。
 * 画面は kind を見分けず、ここにある関数・ローダーを呼ぶだけにする。
 */
export interface WorkbenchModule {
  /** 解析の種類（登録表のキー。重複しない） */
  kind: AnalysisKind;
  /** 画面とブックに出す名前（core/analyses.ts と同じもの） */
  label: string;
  /** タブのツールチップなどに出す一行説明 */
  shortHint: string;
  /** タブなどの並び順（小さいほど先） */
  order: number;
  /** タブに添える小さなバッジ（例: 'Excel式'）。省略可 */
  tabBadge?: string;

  /** ソルバーの作り方を遅延 import で読み込む（重いので、解析を開くまで読み込まない） */
  loadSolver(): Promise<SolverFactory>;

  /** 画面の部品。どれも省略可（省略したパネルは出さない）。遅延 import で読み込む */
  ui?: {
    /** 標準モードの「解析の設定」カード */
    loadSettings?(): Promise<PanelFactory>;
    /** かんたんモードの質問パネル */
    loadEasy?(): Promise<PanelFactory>;
    /** プロモードの「詳細設定」カード */
    loadPro?(): Promise<PanelFactory>;
    /** キャンバスの重ね描き（波源の印など） */
    loadOverlay?(): Promise<OverlayFactory>;
    /** 結果ボックスの下に足す表示（熱の部品ごとの一覧など）。container の中だけを触る */
    loadResultsExtra?(): Promise<PanelFactory>;
  };

  /** 解析を始める前の案内（物体がない、など）。初心者向けの文で返す。省略時は案内なし */
  hints?(input: HintInput): string[];

  /** 判定カードの見出し。省略時は判定カードを出さない */
  verdictTitle?: string;
  /**
   * 結果から OK / 注意 / NG の判定を作る純粋関数。結果が出ていないときは「計算中」の判定を返す。
   * 判定を出さない解析は省略するか null を返す。
   */
  verdict?(input: VerdictInput): Verdict | null;
  /** 判定の「次の一手」をプロジェクトに反映する。この解析の verdict が返す action を扱う */
  applyAction?(opts: { project: Project; action: VerdictAction; selectShape?: (shapeId: string | null) => void }): void;

  /** 材料プルダウンの表示名（例: 電磁波では比誘電率を添える）。省略時は材料名 */
  materialLabel?(material: Material): string;
  /** キャンバスの描き方の違い。省略時は特別な描き方をしない */
  viewTraits?: ViewTraits;
  /** 最初に表示する場の key（結果の fields にあるもの）。省略時は先頭の場 */
  defaultField?: string;
  /** この解析で開くプリセットの id（ui/presets.ts の PRESETS にあるもの） */
  presets?: string[];

  /**
   * 数学の窓（判定の裏の式を今の数値で見せる部品）。src/learn が提供する MathProvider を遅延 import で返す。
   * learn の型だけを使う（実行時の依存はこの import() の先にだけある）。省略可。
   */
  math?: { loadProvider(): Promise<MathProvider> };
}
