// 計算ループの管理。プロジェクトを格子化してソルバーを作り、requestAnimationFrame ごとに少しずつ進める。
import { ANALYSIS_KINDS } from '../core/analyses';
import { resolveProject, type AutoGrid } from '../core/auto';
import { rasterize } from '../core/raster';
import type { AnalysisKind, Field, Project, Raster, ResultSet, Solver, SolverFactory, SolverStatus } from '../core/types';
import { getWorkbench, loadSolverFactory, peekSolverFactory } from '../workbench';
import { withLoading } from './lazy';
import { projectForFormula } from './project-utils';
import { RemoteResults, type RemoteEntry } from './remote-results';
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

/** 本計算の結果を表示しているときの状態（判定カードなどが「計算済み」とみなせるように） */
const REMOTE_STATUS: SolverStatus = { done: true, progress: 1, iteration: 1, message: '本計算の結果' };

export class Runner {
  solver: Solver | null = null;
  raster: Raster | null = null;
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
  /** result が更新されるたび（Lite の計算が進む・本計算の結果を切り替える）に増える */
  resultVersion = 0;
  /** PC のエンジンで計算した結果（形や条件が変わると古い扱いになる） */
  readonly remote = new RemoteResults();
  /** ソルバーを作り直すたびに増える（流線などの描画状態のリセット用） */
  generation = 0;

  private rev = 0;
  /** Lite（ブラウザの中の計算）の結果と状態。result / status は、本計算を表示中はそちらに差し替わる */
  private lite: ResultSet | null = null;
  private liteStatus: SolverStatus | null = null;
  /** 利用者が「本計算」の表示を選んでいるか */
  private wantRemote = false;
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
      this.wantRemote = false;
      this.rebuild();
    });
    store.on('analysis', (src) => {
      if (src === 'load') return; // load で作り直し済み
      this.wantRemote = false;
      this.stash();
      this.rebuild();
    });
  }

  /** 表示する結果。本計算を選んでいて、それが古くなければ本計算、そうでなければ Lite */
  get result(): ResultSet | null {
    return this.shownRemote()?.result ?? this.lite;
  }

  /** 表示する結果の状態。本計算を表示中は「計算済み」 */
  get status(): SolverStatus | null {
    return this.shownRemote() ? REMOTE_STATUS : this.liteStatus;
  }

  /**
   * 表示中の結果と同じ格子の Raster。本計算の結果は Lite と格子の大きさが違うことがあるので、
   * 合わないときは null（判定などが、別の格子の配列を読み違えないように）
   */
  get shownRaster(): Raster | null {
    const r = this.result;
    return this.raster && r && this.raster.nx === r.nx && this.raster.ny === r.ny ? this.raster : null;
  }

  /** Lite（ブラウザの中の計算）の結果。本計算を表示中でも Lite の結果を返す（比較表に使う） */
  get liteResult(): ResultSet | null {
    return this.lite;
  }

  /** 形や条件が変わるたびに増える番号。本計算の結果が今のプロジェクトのものかを見分けるのに使う */
  get revision(): number {
    return this.rev;
  }

  /** いま本計算の結果を表示しているか */
  get viewingRemote(): boolean {
    return this.shownRemote() !== null;
  }

  /** 今の解析の、古くない本計算の結果 */
  currentRemote(): RemoteEntry | null {
    return this.remote.get(this.kind, this.rev);
  }

  private shownRemote(): RemoteEntry | null {
    return this.wantRemote ? this.currentRemote() : null;
  }

  /** 本計算の結果を受け取る。rev は計算を始めたときの revision（その後に変更があれば古い結果になる） */
  setRemote(opts: { kind: AnalysisKind; result: ResultSet; label: string; rev: number; show?: boolean }): void {
    this.remote.set(opts);
    if (opts.show && opts.kind === this.kind && opts.rev === this.rev) this.wantRemote = true;
    this.resultVersion++;
  }

  /** Lite ⇄ 本計算の表示を切り替える（本計算の結果がないときは Lite のまま） */
  showRemote(on: boolean): void {
    const next = on && this.currentRemote() !== null;
    if (next === this.wantRemote) return;
    this.wantRemote = next;
    this.resultVersion++;
  }

  /** 現在の結果を、解析を切り替える前に退避する（Excel 出力用） */
  private stash(): void {
    if (this.lite) this.cache.set(this.kind, { rev: this.rev, result: this.lite });
  }

  private onProjectChanged(labelOnly: boolean): void {
    if (labelOnly) return;
    this.rev++;
    this.wantRemote = false; // 古くなった本計算は表示しない（Lite に戻る）
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
    this.liteStatus = null;
    this.lite = null;
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
        this.lite = this.solver.result();
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
    if (this.viewingRemote) return false; // 本計算を見ているあいだ、Lite は止めておく
    if (this.liteStatus?.done) return false;
    try {
      this.liteStatus = this.solver.step(STEP_BUDGET_MS);
      this.lite = this.solver.result();
      this.record(this.liteStatus);
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

  /**
   * いまの形状・条件で計算済みの結果すべて（現在のタブ + 退避済みのもの）。
   * 本計算の結果があれば、Lite の結果のすぐ後に label つきで続ける（Excel で並べて見られる）
   */
  collectResults(): ResultSet[] {
    const out: ResultSet[] = [];
    for (const k of ANALYSIS_KINDS) {
      if (k === this.kind) {
        if (this.lite) out.push(this.lite);
      } else {
        const c = this.cache.get(k);
        if (c && c.rev === this.rev) out.push(c.result);
      }
      const r = this.remote.get(k, this.rev);
      if (r) out.push(r.result);
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
