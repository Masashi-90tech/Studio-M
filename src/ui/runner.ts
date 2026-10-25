// 計算ループの管理。プロジェクトを格子化してソルバーを作り、requestAnimationFrame ごとに少しずつ進める。
import { ANALYSIS_KINDS } from '../core/analyses';
import { resolveProject, type AutoGrid } from '../core/auto';
import { rasterize } from '../core/raster';
import type { AnalysisKind, Field, Project, Raster, ResultSet, Solver, SolverFactory, SolverStatus } from '../core/types';
import { getWorkbench, loadSolverFactory, peekSolverFactory } from '../workbench';
import { withLoading } from './lazy';
import { projectForFormula } from './project-utils';
import type { Store } from './state';

/** 1 フレームで計算に使う時間 [ms] */
const STEP_BUDGET_MS = 12;
/** ソルバーログに残す最大行数 */
const LOG_LIMIT = 4000;
/** 変更から再計算までの待ち時間 [ms] */
const REBUILD_DELAY_MS = 200;

export interface LogEntry {
  iteration: number;
  residual?: number;
  progress: number;
  message?: string;
}

export class Runner {
  solver: Solver | null = null;
  raster: Raster | null = null;
  status: SolverStatus | null = null;
  result: ResultSet | null = null;
  /** ソルバーを作れなかった・実行中に失敗したときのメッセージ */
  error: string | null = null;
  /** UI 側で気づいた注意（支持がない、など） */
  hints: string[] = [];
  /** 計算に使った格子（自動 / 手動と、その理由） */
  grid: AutoGrid | null = null;
  /** 格子を決め終えた計算用のプロジェクト（編集中のプロジェクトとは別の複製） */
  resolved: Project | null = null;
  /** 反復ごとの残差の記録（プロの「ソルバーログ」用） */
  log: LogEntry[] = [];
  running = true;
  /** result が更新されるたびに増える */
  resultVersion = 0;
  /** ソルバーを作り直すたびに増える（流線などの描画状態のリセット用） */
  generation = 0;

  private rev = 0;
  private kind: AnalysisKind;
  private timer: number | undefined;
  private cache = new Map<AnalysisKind, { rev: number; result: ResultSet }>();

  constructor(private store: Store) {
    this.kind = store.analysis;
    // 名前だけの変更では計算をやり直さない
    store.on('project', (src) => this.onProjectChanged(src === 'name' || src === 'label'));
    store.on('load', () => {
      this.rev++;
      this.cache.clear();
      this.rebuild();
    });
    store.on('analysis', (src) => {
      if (src === 'load') return; // load で作り直し済み
      this.stash();
      this.rebuild();
    });
  }

  /** 現在の結果を、解析を切り替える前に退避する（Excel 出力用） */
  private stash(): void {
    if (this.result) this.cache.set(this.kind, { rev: this.rev, result: this.result });
  }

  private onProjectChanged(labelOnly: boolean): void {
    if (labelOnly) return;
    this.rev++;
    this.cache.clear();
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.rebuild(), REBUILD_DELAY_MS);
  }

  /** 格子化してソルバーを作り直す（再計算の開始） */
  rebuild(): void {
    window.clearTimeout(this.timer);
    const project = this.store.project;
    this.kind = this.store.analysis;
    this.generation++;
    this.error = null;
    this.status = null;
    this.result = null;
    this.solver = null;
    this.log = [];
    this.grid = null;
    this.resolved = null;
    try {
      // 格子の細かさは解析ごとに自動で決める（手動設定なら project.domain.nx のまま）
      const { project: resolved, grid } = resolveProject(project, this.kind);
      this.grid = grid;
      this.resolved = resolved;
      this.raster = rasterize(resolved);
      this.hints = getWorkbench(this.kind)?.hints?.({ project: resolved, raster: this.raster }) ?? [];
    } catch (e) {
      this.raster = null;
      this.hints = [];
      this.error = `形状の格子化に失敗しました: ${message(e)}`;
      this.resultVersion++;
      return;
    }
    this.startSolver(project);
  }

  /**
   * ソルバーを作って最初の結果を取る。解析エンジンは初めて使うときだけ遅延 import で読み込む。
   * 読み込み済みなら今まで通り同期で始まり、未読み込みなら読み込みが終わるまで「準備中」になる。
   */
  private startSolver(fallback: Project): void {
    const kind = this.kind;
    const raster = this.raster;
    if (!raster) return;
    const project = this.resolved ?? fallback;
    const start = (factory: SolverFactory): void => {
      try {
        this.solver = factory(project, raster);
        this.result = this.solver.result();
      } catch (e) {
        this.solver = null;
        this.error = `計算を始められませんでした: ${message(e)}`;
      }
      this.resultVersion++;
    };
    const ready = peekSolverFactory(kind);
    if (ready) {
      start(ready);
      return;
    }
    const gen = this.generation;
    this.resultVersion++;
    void withLoading({ label: `${getWorkbench(kind)?.label ?? kind}の解析エンジン`, task: loadSolverFactory(kind) }).then((factory) => {
      if (gen !== this.generation) return; // 待っている間に作り直された
      if (!factory) {
        this.error = '解析エンジンを読み込めませんでした。ページを開き直してみてください';
        this.resultVersion++;
        return;
      }
      start(factory);
    });
  }

  reset(): void {
    this.rebuild();
    this.running = true;
  }

  setRunning(on: boolean): void {
    this.running = on;
  }

  /** 1 フレーム分だけ計算を進める。結果が更新されたら true */
  tick(): boolean {
    if (!this.solver || !this.running || document.hidden) return false;
    if (this.status?.done) return false;
    try {
      this.status = this.solver.step(STEP_BUDGET_MS);
      this.result = this.solver.result();
      this.record(this.status);
      this.resultVersion++;
      return true;
    } catch (e) {
      this.error = `計算中にエラーが起きました: ${message(e)}`;
      this.running = false;
      this.resultVersion++;
      return true;
    }
  }

  /** ソルバーログに 1 行足す（多くなりすぎたら間引く） */
  private record(st: SolverStatus): void {
    const last = this.log[this.log.length - 1];
    if (last && last.iteration === st.iteration) return;
    this.log.push({ iteration: st.iteration, residual: st.residual, progress: st.progress, message: st.message });
    if (this.log.length > LOG_LIMIT) this.log = this.log.filter((_, i) => i % 2 === 0 || i === this.log.length - 1);
  }

  /** いまの形状・条件で計算済みの結果すべて（現在のタブ + 退避済みのもの） */
  collectResults(): ResultSet[] {
    const out: ResultSet[] = [];
    for (const k of ANALYSIS_KINDS) {
      if (k === this.kind) {
        if (this.result) out.push(this.result);
      } else {
        const c = this.cache.get(k);
        if (c && c.rev === this.rev) out.push(c.result);
      }
    }
    return out;
  }

  /** Excel 数式ブック用に、格子を粗くした複製とその格子化結果を作る */
  formulaInput(): { project: Project; raster: Raster } {
    const project = projectForFormula(this.store.project);
    return { project, raster: rasterize(project) };
  }

  /** 選択中のフィールド（なければ先頭） */
  currentField(): Field | null {
    const r = this.result;
    if (!r || r.fields.length === 0) return null;
    const key = this.store.fieldKeys[this.kind] ?? getWorkbench(this.kind)?.defaultField;
    return r.fields.find((f) => f.key === key) ?? r.fields[0];
  }

  get analysis(): AnalysisKind {
    return this.kind;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
