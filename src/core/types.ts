// Studio M の共通データモデル。
// 全モジュール（ソルバー・UI・Excel出力）はこのファイルの型だけを介してやり取りする。
//
// 座標系: 単位はメートル。原点は解析領域の左下、x は右、y は上。
// 格子: nx × ny の正方セル。セル (i, j) の配列インデックスは j * nx + i（j = 0 が一番下の行）。
// セル幅 h = domain.width / nx、ny = round(domain.height / h)。
// 2D解析は奥行き方向に厚さ project.thickness [m] を持つ板として扱う。

export type AnalysisKind = 'flow' | 'heat' | 'stress' | 'scalar' | 'em';

// ---------- 形状 ----------

export type ShapeGeom =
  | { kind: 'rect'; x: number; y: number; w: number; h: number } // (x, y) は左下の角
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'polygon'; points: [number, number][] }; // 閉じた多角形（フリーハンドもこれ）

/**
 * 形状の役割。shapes 配列の順に適用され、後のものが前のものを上書きする。
 * - solid:      材料でできた物体。流れでは障害物、熱では伝導体、強度では要素になる
 * - heatSource: solid と同じく物体になり、さらに heatW [W] を発熱する（体積で均等に配分）
 * - hole:       それまでに置かれた物体を削る（穴あけ）
 * - fixedTemp:  重ねた範囲のセルを tempC [°C] に固定する（熱解析のみ。物体は作らない）
 * - support:    重ねた範囲にある物体の節点を完全固定する（強度解析のみ。物体は作らない）
 * - load:       重ねた範囲にある物体に合計 force [N] を均等に配分して加える（強度解析のみ）
 */
export type ShapeRole = 'solid' | 'heatSource' | 'hole' | 'fixedTemp' | 'support' | 'load';

export interface Shape {
  id: string;
  name: string;
  geom: ShapeGeom;
  role: ShapeRole;
  /** solid / heatSource の材料ID（materials.ts） */
  materialId: string;
  /** heatSource の総発熱量 [W] */
  heatW?: number;
  /** fixedTemp の温度 [°C] */
  tempC?: number;
  /** load の合計荷重 [N]（x, y 成分） */
  force?: { fx: number; fy: number };
  /** この部品の上限温度の目安 [°C]（電子部品の動作温度など）。熱の判定で材料の maxTempC より優先する */
  maxTempC?: number;
  /** 取り込み元の情報（KiCad の部品番号・値・フットプリントなど）。表示と書き出しにだけ使う */
  meta?: Record<string, string>;
}

// ---------- 材料 ----------

export interface Material {
  id: string;
  name: string;
  kind: 'fluid' | 'solid';
  /** 密度 [kg/m³] */
  rho: number;
  /** 熱伝導率 [W/(m·K)] */
  k: number;
  /** 比熱 [J/(kg·K)] */
  cp: number;
  /** 縦弾性係数 [Pa]（solid） */
  E?: number;
  /** ポアソン比（solid） */
  nu?: number;
  /** 降伏応力（樹脂は引張強さ）[Pa]（solid） */
  yield?: number;
  /** 動粘性係数 [m²/s]（fluid） */
  viscosity?: number;
  /** 比誘電率（電磁波）。省略時 1 */
  epsR?: number;
  /** 誘電正接 tanδ（電磁波の損失）。導電率は σ = 2πf·ε0·εr·tanδ として周波数から求める */
  tanD?: number;
  /** 金属など電気をよく通す材料。電磁波では完全導体（電場 0）として扱う */
  conductor?: boolean;
  /** 使用上限の目安温度 [°C]（樹脂の軟化など）。かんたんモードの判定に使う */
  maxTempC?: number;
  /** 表示色 */
  color: string;
  note?: string;
}

// ---------- 解析条件 ----------

// 各解析の advanced はプロモード用の細かい設定。省略した項目はソルバーが自動で決める。

/** 反復法で解く解析（熱・強度・対流拡散）共通のプロ設定 */
export interface IterativeAdvanced {
  /** 収束判定の相対残差 */
  tolerance?: number;
  /** 最大反復回数 */
  maxIterations?: number;
}

export interface FlowSettings {
  fluidId: string;
  /** 左端から流入する一様流速 [m/s] */
  inletVelocity: number;
  /** 上下の壁: slip = 対称（動画と同じ）、noslip = 壁面 */
  walls: 'slip' | 'noslip';
  advanced?: {
    /** Smagorinsky 定数（乱流の渦粘性モデル）。0 で無効 */
    smagorinskyCs?: number;
    /** 格子単位の流入速度（0.02〜0.15）。小さいほど正確だが遅い */
    latticeU?: number;
    /** 渦の発生を促す初期の揺らぎの強さ（0 で無し） */
    perturbation?: number;
  };
}

export type EdgeBC =
  | { type: 'adiabatic' }
  | { type: 'temp'; tempC: number }
  | { type: 'convection'; h: number };

export interface HeatSettings {
  /** 周囲（物体のないセル）の温度 [°C]。物体のないセルはこの温度の空気として扱う */
  ambientC: number;
  /** 物体表面から周囲への熱伝達率 [W/(m²·K)]。自然対流でおよそ 5〜10、ファンで 20〜100 */
  surfaceH: number;
  /** 板の表裏の面からも周囲へ放熱するか（薄い板・ヒートシンクで重要） */
  faceCooling: boolean;
  /** 解析領域の4辺の境界条件（物体が辺に接している場合だけ効く） */
  edges: { left: EdgeBC; right: EdgeBC; top: EdgeBC; bottom: EdgeBC };
  advanced?: IterativeAdvanced;
}

export interface StressSettings {
  /** 自重を考慮するか（重力は -y 方向） */
  selfWeight: boolean;
  advanced?: IterativeAdvanced;
}

/** レベル①: 動画と同じ対流拡散。一様流 u で運ばれるスカラー φ（物体表面で φ = phiBody） */
export interface ScalarSettings {
  /** x 方向の一様流速 [m/s] */
  u: number;
  /** 拡散係数 Γ [kg/(m·s)] */
  gamma: number;
  /** 密度 ρ [kg/m³] */
  rho: number;
  /** 流入側の φ */
  phiInlet: number;
  /** 物体表面の φ */
  phiBody: number;
  advanced?: IterativeAdvanced & {
    /** 対流項の離散化。hybrid = 動画と同じ */
    scheme?: 'hybrid' | 'upwind' | 'central';
    /** SOR の緩和係数（1〜1.95）。省略時はセルペクレ数から自動 */
    relaxation?: number;
  };
}

/** 電磁波（レーダー・電波）。2D FDTD。物体のないセルは mediumId の材料で満たす */
export interface EMSettings {
  /** 周波数 [GHz] */
  frequencyGHz: number;
  /** plane = 平面波（遠くのレーダーから来る波）、point = 点波源（アンテナ） */
  source: 'plane' | 'point';
  /** 平面波の進む向き [度]。0 = 左から右へ、90 = 下から上へ */
  angleDeg: number;
  /** 点波源の位置 [m] */
  pointX: number;
  pointY: number;
  /** TM = 電場が紙面に垂直（2D面に垂直）、TE = 磁場が紙面に垂直 */
  polarization: 'TM' | 'TE';
  /** 背景の材料ID（通常 air） */
  mediumId: string;
  advanced?: {
    /** 1波長あたりのセル数（媒質中の最短波長に対して）。省略時 20 */
    cellsPerWavelength?: number;
    /** 吸収境界（PML）の厚さ [セル]。省略時 12 */
    pmlCells?: number;
    /** クーラン数（2D の安定限界は 1/√2 ≈ 0.707）。省略時 0.5 */
    courant?: number;
    /** cw = 連続波、pulse = ガウスパルス */
    waveform?: 'cw' | 'pulse';
  };
}

export interface Project {
  version: 1;
  name: string;
  /**
   * autoGrid が true（省略時も true とみなす）なら、格子数 nx は解析ごとに
   * core/auto.ts の autoGrid() が決める。false ならここの nx をそのまま使う。
   */
  domain: { width: number; height: number; nx: number; autoGrid?: boolean };
  /** 2D解析の奥行き厚さ [m] */
  thickness: number;
  /** KiCad などから取り込んだ基板の情報。あれば熱解析で銅箔の効果を入れる */
  pcb?: PcbInfo;
  shapes: Shape[];
  flow: FlowSettings;
  heat: HeatSettings;
  stress: StressSettings;
  scalar: ScalarSettings;
  em: EMSettings;
}

// ---------- 格子化した形状（raster.ts が生成） ----------

export interface Raster {
  nx: number;
  ny: number;
  /** セル幅 [m] */
  h: number;
  /** 1 = 物体がある */
  solid: Uint8Array;
  /** 物体セルの材料ID（物体がなければ null） */
  materialId: (string | null)[];
  /** 発熱密度 [W/m³] */
  heatGen: Float32Array;
  /** 固定温度 [°C]。固定でなければ NaN */
  fixedTemp: Float32Array;
  /** 1 = support 範囲 */
  support: Uint8Array;
  /** セルに加わる荷重 [N]（x, y） */
  loadFx: Float32Array;
  loadFy: Float32Array;
  /**
   * そのセルを最後に塗った形状の、project.shapes での番号（なければ -1）。
   * 部品ごとの結果（部品の最高温度など）を出すのに使う。省略時は部品ごとの結果を出さない
   */
  shapeIndex?: Int32Array;
  /**
   * 面内の実効熱伝導率 [W/(m·K)]。基板の銅箔のように、材料の k をセルごとに上書きしたいときに使う。
   * NaN または省略なら材料の k を使う
   */
  kEff?: Float32Array;
}

// ---------- 解析結果 ----------

export interface Field {
  key: string;
  label: string;
  unit: string;
  /** 長さ nx * ny、インデックスは j * nx + i */
  data: Float32Array;
  /** 値が意味を持つセル（1）。省略時は全セル有効 */
  mask?: Uint8Array;
  /** 0 を中心に正負で色分けする量（渦度など） */
  diverging?: boolean;
}

export interface ScalarValue {
  key: string;
  label: string;
  unit: string;
  value: number;
}

export interface History {
  key: string;
  label: string;
  unit: string;
  /** 横軸（時刻 [s] または反復回数） */
  t: number[];
  values: number[];
}

export interface ResultSet {
  analysis: AnalysisKind;
  nx: number;
  ny: number;
  h: number;
  fields: Field[];
  scalars: ScalarValue[];
  history: History[];
  /** 利用者に見せる注意（精度の限界、条件の自動調整など） */
  warnings: string[];
  /** 形状（部品）ごとの結果。熱なら部品ごとの最高温度など。省略可 */
  perShape?: ShapeResult[];
  /** 出どころの表示名（例: 「CalculiX 本計算」）。省略時は Lite の結果。Excel のシート名や見出しに使う */
  label?: string;
}

export interface ShapeResult {
  shapeId: string;
  /** 表示名（部品番号や形状の名前） */
  label: string;
  /** 値の一覧。key は ScalarValue と同じ書き方（例: maxTemp） */
  values: ScalarValue[];
}

// ---------- ソルバー ----------

export interface SolverStatus {
  /** 収束した（流れのような非定常解析は常に false） */
  done: boolean;
  /** 0〜1 の進捗の目安 */
  progress: number;
  iteration: number;
  residual?: number;
  message?: string;
}

/**
 * ソルバーは少しずつ進める方式にする。UI は requestAnimationFrame ごとに step を呼び、
 * そのたびに result() で描画する。これで画面を固めずにアニメーションできる。
 */
export interface Solver {
  readonly analysis: AnalysisKind;
  /** 最大 budgetMs ミリ秒だけ計算を進める */
  step(budgetMs: number): SolverStatus;
  /** 現時点の結果（毎回新しく作らなくてよいが、呼び出し側は描画にしか使わない） */
  result(): ResultSet;
}

export type SolverFactory = (project: Project, raster: Raster) => Solver;

// ---------- 基板（KiCad 取り込み） ----------

/** 銅箔の層。polygons は基板座標を Studio M の座標（m、y 上向き）に直した多角形 */
export interface CopperLayer {
  /** 層の名前（F.Cu、B.Cu、In1.Cu など） */
  name: string;
  /** 銅箔の厚さ [µm]。1oz ≈ 35 µm */
  thicknessUm: number;
  /** 配線・ベタ・パッドを多角形にしたもの */
  polygons: [number, number][][];
}

export interface PcbInfo {
  /** 取り込んだファイル名 */
  source: string;
  /** 基板全体の厚さ [mm]（通常 1.6） */
  boardThicknessMm: number;
  /** 基材の材料ID（通常 fr4） */
  substrateId: string;
  layers: CopperLayer[];
}
