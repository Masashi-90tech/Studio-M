// ワークベンチの登録表。画面（ハーネス）は解析の種類を見分けず、ここから引いて使う。
// 解析を足すときは modules/<kind>.ts を作り、index.ts で registerWorkbench に渡す。
import type { AnalysisKind, Material, Project, Raster, Solver, SolverFactory } from '../core/types';
import type { MathProvider } from '../learn/types';
import type { OverlayFactory, PanelFactory, PanelSlot, WorkbenchModule } from './types';

const modules = new Map<AnalysisKind, WorkbenchModule>();
/** 読み込み済みのソルバーの作り方（読み込み中の Promise も入れて二重に読まない） */
const solverLoads = new Map<AnalysisKind, Promise<SolverFactory>>();
const solverReady = new Map<AnalysisKind, SolverFactory>();
const mathLoads = new Map<AnalysisKind, Promise<MathProvider | null>>();
const panelLoads = new Map<string, Promise<PanelFactory | null>>();
const panelReady = new Map<string, PanelFactory>();

const slotKey = (kind: AnalysisKind, slot: PanelSlot): string => `${kind}:${slot}`;

/** ワークベンチを登録する。同じ種類を 2 回登録するとエラー（取り違えに気づくため） */
export function registerWorkbench(module: WorkbenchModule): void {
  if (modules.has(module.kind)) throw new Error(`ワークベンチ「${module.kind}」はすでに登録されています`);
  if (!module.label) throw new Error(`ワークベンチ「${module.kind}」に label がありません`);
  modules.set(module.kind, module);
}

export function getWorkbench(kind: AnalysisKind): WorkbenchModule | undefined {
  return modules.get(kind);
}

/** 登録済みのワークベンチを order の順に返す */
export function listWorkbenches(): WorkbenchModule[] {
  return [...modules.values()].sort((a, b) => a.order - b.order);
}

/** 材料プルダウンの表示名（解析ごとに添える情報が違う。例: 電磁波では比誘電率） */
export function materialLabel(opts: { kind: AnalysisKind; material: Material }): string {
  return modules.get(opts.kind)?.materialLabel?.(opts.material) ?? opts.material.name;
}

// ---------- ソルバー ----------

/** ソルバーの作り方を読み込む（初回だけ import する）。失敗したら次回やり直せる */
export function loadSolverFactory(kind: AnalysisKind): Promise<SolverFactory> {
  const cached = solverLoads.get(kind);
  if (cached) return cached;
  const wb = modules.get(kind);
  if (!wb) return Promise.reject(new Error(`解析「${kind}」は登録されていません`));
  const p = wb.loadSolver().then((f) => {
    solverReady.set(kind, f);
    return f;
  });
  solverLoads.set(kind, p);
  p.catch(() => solverLoads.delete(kind));
  return p;
}

/** 読み込み済みならソルバーの作り方をすぐ返す（再計算のたびに待たないため）。未読み込みは undefined */
export function peekSolverFactory(kind: AnalysisKind): SolverFactory | undefined {
  return solverReady.get(kind);
}

/** ソルバーを作る唯一の入口。画面は解析ごとの createXxxSolver を直接呼ばない */
export async function createSolver(opts: { kind: AnalysisKind; project: Project; raster: Raster }): Promise<Solver> {
  const factory = await loadSolverFactory(opts.kind);
  return factory(opts.project, opts.raster);
}

// ---------- パネル ----------

function panelLoader(wb: WorkbenchModule, slot: PanelSlot): (() => Promise<PanelFactory>) | undefined {
  switch (slot) {
    case 'settings':
      return wb.ui?.loadSettings;
    case 'easy':
      return wb.ui?.loadEasy;
    case 'pro':
      return wb.ui?.loadPro;
    case 'results':
      return wb.ui?.loadResultsExtra;
  }
}

/** パネルの作り方を読み込む。その解析にそのパネルがなければ null */
export function loadPanelFactory(kind: AnalysisKind, slot: PanelSlot): Promise<PanelFactory | null> {
  const key = slotKey(kind, slot);
  const cached = panelLoads.get(key);
  if (cached) return cached;
  const wb = modules.get(kind);
  const load = wb ? panelLoader(wb, slot) : undefined;
  if (!wb || !load) return Promise.resolve(null);
  const p = load.call(wb.ui).then((f) => {
    panelReady.set(key, f);
    return f;
  });
  panelLoads.set(key, p);
  p.catch(() => panelLoads.delete(key));
  return p;
}

/** 読み込み済みならパネルの作り方をすぐ返す（選択のたびに作り直しても点滅しないように） */
export function peekPanelFactory(kind: AnalysisKind, slot: PanelSlot): PanelFactory | undefined {
  return panelReady.get(slotKey(kind, slot));
}

/** キャンバスの重ね描きの作り方を読み込む。なければ null */
export async function loadOverlayFactory(kind: AnalysisKind): Promise<OverlayFactory | null> {
  const wb = modules.get(kind);
  return wb?.ui?.loadOverlay ? wb.ui.loadOverlay() : null;
}

// ---------- 数学の窓 ----------

/** 数学の窓の式の提供者を読み込む（初回だけ import する）。その解析に数学の窓がなければ null。失敗したら次回やり直せる */
export function loadMathProvider(kind: AnalysisKind): Promise<MathProvider | null> {
  const cached = mathLoads.get(kind);
  if (cached) return cached;
  const load = modules.get(kind)?.math?.loadProvider;
  if (!load) return Promise.resolve(null);
  const p = load();
  mathLoads.set(kind, p);
  p.catch(() => mathLoads.delete(kind));
  return p;
}
