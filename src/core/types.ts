// Studio M の共通データモデル。
// 全モジュール（ソルバー・UI・Excel出力）はこのファイルの型だけを介してやり取りする。
//
// 座標系: 単位はメートル。原点は解析領域の左下、x は右、y は上。
// 格子: nx × ny の正方セル。セル (i, j) の配列インデックスは j * nx + i（j = 0 が一番下の行）。
// セル幅 h = domain.width / nx、ny = round(domain.height / h)。
// 2D解析は奥行き方向に厚さ project.thickness [m] を持つ板として扱う。

export type AnalysisKind = 'flow' | 'heat' | 'stress' | 'scalar';

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
  /** 表示色 */
  color: string;
  note?: string;
}

// ---------- 解析条件 ----------

export interface FlowSettings {
  fluidId: string;
  /** 左端から流入する一様流速 [m/s] */
  inletVelocity: number;
  /** 上下の壁: slip = 対称（動画と同じ）、noslip = 壁面 */
  walls: 'slip' | 'noslip';
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
}

export interface StressSettings {
  /** 自重を考慮するか（重力は -y 方向） */
  selfWeight: boolean;
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
}

export interface Project {
  version: 1;
  name: string;
  domain: { width: number; height: number; nx: number };
  /** 2D解析の奥行き厚さ [m] */
  thickness: number;
  shapes: Shape[];
  flow: FlowSettings;
  heat: HeatSettings;
  stress: StressSettings;
  scalar: ScalarSettings;
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
