// アプリ全体の状態（プロジェクト・選択・ツール・表示設定）と変更通知。
// UI の各部品はここを購読し、変更は必ずここの関数を通す。
import { DEFAULT_ANALYSIS } from '../core/analyses';
import { defaultProject, newShapeId } from '../core/project';
import type { AnalysisKind, Project, Shape, ShapeGeom, ShapeRole } from '../core/types';
import type { ColormapName } from './colormap';
import { DEFAULT_PREFS, saveUiState, type Prefs, type UiMode } from './modes';
import { ensureRoleDefaults, nextShapeName } from './project-utils';

export type Tool = 'select' | 'rect' | 'circle' | 'polygon' | 'freehand' | 'delete' | 'probe' | 'section';

/**
 * - project:   形状や条件が変わった（再計算が必要）。source は変更元（'canvas' | 'props' | 'settings' ...）
 * - load:      プロジェクトが丸ごと入れ替わった（新規・プリセット・読込・元に戻す）
 * - analysis:  解析タブが変わった
 * - selection: 選択が変わった
 * - tool:      ツール・新規図形の役割/材料が変わった
 * - view:      表示設定だけが変わった（再計算は不要）
 * - mode:      表示モード（かんたん / 標準 / プロ）が変わった。見せ方だけが変わる
 */
export type StoreEvent = 'project' | 'load' | 'analysis' | 'selection' | 'tool' | 'view' | 'mode';

export interface ViewOptions {
  smooth: boolean;
  grid: boolean;
  snap: boolean;
  particles: boolean;
  deform: boolean;
  colormap: ColormapName;
}

type Listener = (source?: string) => void;

const UNDO_LIMIT = 60;

export class Store {
  project: Project;
  analysis: AnalysisKind = DEFAULT_ANALYSIS;
  tool: Tool = 'select';
  newRole: ShapeRole = 'solid';
  newMaterialId = 'al6061';
  selectedId: string | null = null;
  view: ViewOptions = { smooth: false, grid: true, snap: false, particles: true, deform: true, colormap: 'turbo' };
  /** 解析ごとに選んでいる表示フィールド */
  fieldKeys: Partial<Record<AnalysisKind, string>> = {};
  /** 表示モード。プロジェクトのデータは変えず、見せるものだけを切り替える */
  mode: UiMode = 'standard';
  /** かんたんモードの質問の答え（閲覧者ごと） */
  prefs: Prefs = { ...DEFAULT_PREFS };

  private listeners = new Map<StoreEvent, Set<Listener>>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastCoalesce = { key: '', at: 0 };

  constructor(project: Project) {
    this.project = project;
  }

  on(ev: StoreEvent, fn: Listener): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(ev: StoreEvent, source?: string): void {
    this.listeners.get(ev)?.forEach((fn) => fn(source));
  }

  // ---------- 元に戻す ----------

  /** 変更の直前に呼ぶ。同じ key が coalesceMs 以内に続く場合は 1 回分にまとめる */
  checkpoint(key = '', coalesceMs = 0): void {
    const now = performance.now();
    if (key && this.lastCoalesce.key === key && now - this.lastCoalesce.at < coalesceMs) {
      this.lastCoalesce.at = now;
      return;
    }
    this.lastCoalesce = { key, at: now };
    const json = JSON.stringify(this.project);
    if (this.undoStack[this.undoStack.length - 1] !== json) {
      this.undoStack.push(json);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    }
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const json = this.undoStack.pop();
    if (json === undefined) return false;
    this.redoStack.push(JSON.stringify(this.project));
    this.replaceProject(JSON.parse(json) as Project);
    return true;
  }

  redo(): boolean {
    const json = this.redoStack.pop();
    if (json === undefined) return false;
    this.undoStack.push(JSON.stringify(this.project));
    this.replaceProject(JSON.parse(json) as Project);
    return true;
  }

  private replaceProject(p: Project): void {
    this.project = p;
    if (this.selectedId && !p.shapes.some((s) => s.id === this.selectedId)) this.selectedId = null;
    this.emit('load');
    this.emit('selection');
  }

  // ---------- プロジェクトの入れ替え ----------

  /** 新規・プリセット・ファイル読込。元に戻せるよう直前の状態を残す */
  loadProject(p: Project, analysis?: AnalysisKind): void {
    this.checkpoint();
    this.project = p;
    this.selectedId = null;
    if (analysis) this.analysis = analysis;
    this.emit('load');
    this.emit('selection');
    this.emit('analysis', 'load');
  }

  newProject(): void {
    const p = defaultProject();
    p.name = '新しいプロジェクト';
    p.shapes = [];
    this.loadProject(p);
  }

  setMode(mode: UiMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // プロ専用のツールはプロ以外では使えない
    if (mode !== 'pro' && (this.tool === 'probe' || this.tool === 'section')) {
      this.tool = 'select';
      this.emit('tool');
    }
    saveUiState(this.mode, this.prefs);
    this.emit('mode');
  }

  /** かんたんモードの答えを変える（再計算は不要、判定の見え方だけが変わる） */
  setPrefs(patch: Partial<Prefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    saveUiState(this.mode, this.prefs);
    this.emit('view');
  }

  setAnalysis(kind: AnalysisKind): void {
    if (kind === this.analysis) return;
    this.analysis = kind;
    this.emit('analysis');
  }

  // ---------- 形状の編集 ----------

  getShape(id: string | null): Shape | undefined {
    return id ? this.project.shapes.find((s) => s.id === id) : undefined;
  }

  select(id: string | null): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.emit('selection');
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.emit('tool');
  }

  /** 現在の「新規図形の役割・材料」で図形を追加して選択する */
  addShape(geom: ShapeGeom, overrides: Partial<Shape> = {}): Shape {
    this.checkpoint();
    const role = overrides.role ?? this.newRole;
    const s: Shape = {
      id: newShapeId(),
      name: nextShapeName(this.project, role),
      geom,
      role,
      materialId: this.newMaterialId,
      ...overrides,
    };
    ensureRoleDefaults(s);
    this.project.shapes.push(s);
    this.selectedId = s.id;
    this.tool = 'select';
    this.emit('project', 'canvas');
    this.emit('selection');
    this.emit('tool');
    return s;
  }

  /** できあがった図形をまとめて追加する（画像からの取り込みなど）。元に戻すは1回で全部戻る */
  addShapes(shapes: Shape[]): void {
    if (shapes.length === 0) return;
    this.checkpoint();
    this.project.shapes.push(...shapes);
    this.selectedId = shapes[0].id;
    this.emit('project', 'canvas');
    this.emit('selection');
  }

  deleteShape(id: string): void {
    const i = this.project.shapes.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.checkpoint();
    this.project.shapes.splice(i, 1);
    if (this.selectedId === id) {
      this.selectedId = null;
      this.emit('selection');
    }
    this.emit('project', 'canvas');
  }

  duplicateShape(id: string): void {
    const s = this.getShape(id);
    if (!s) return;
    const copy = JSON.parse(JSON.stringify(s)) as Shape;
    copy.id = newShapeId();
    copy.name = `${s.name} のコピー`;
    // 少しずらして重なりに気づけるようにする
    const d = this.project.domain.width / 40;
    if (copy.geom.kind === 'rect') {
      copy.geom.x += d;
      copy.geom.y -= d;
    } else if (copy.geom.kind === 'circle') {
      copy.geom.cx += d;
      copy.geom.cy -= d;
    } else {
      copy.geom.points = copy.geom.points.map(([x, y]) => [x + d, y - d]);
    }
    this.checkpoint();
    this.project.shapes.push(copy);
    this.selectedId = copy.id;
    this.emit('project', 'canvas');
    this.emit('selection');
  }

  /** 重ね順を 1 つ前後に動かす（delta = +1 で前面＝後から適用） */
  moveShape(id: string, delta: number): void {
    const i = this.project.shapes.findIndex((s) => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.project.shapes.length) return;
    this.checkpoint();
    const [s] = this.project.shapes.splice(i, 1);
    this.project.shapes.splice(j, 0, s);
    this.emit('project', 'order');
  }

  /** 値の変更を通知する（呼び出し側が先に project を書き換える） */
  touch(source: string): void {
    this.emit('project', source);
  }
}
