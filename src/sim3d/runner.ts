// 3D の計算を少しずつ進める。ソルバーは使うときに遅延 import で読み込む（重いので起動時には入れない）。
// 2D の src/ui/runner.ts と同じ進め方: step(budgetMs) を繰り返し、そのあいだに画面が固まらないよう合間を空ける。
// 計算を始めた時点の形・条件のコピーで解く。計算中に画面で条件を変えても、結果は「古い結果」として届く。
//
// 2 種類の進み方がある:
// - 熱（定常）: 収束（done）したら止まり、そのとき結果を 1 回だけ届ける
// - 流れ（非定常）: done にならず、止めるまで進み続ける。0.5 秒に 1 回ほど結果を届ける。一時停止・再開・最初から
import type { Analysis3DKind, Solver3D, Solver3DFactory, Study3D } from '../core/types';
import { withLoading } from '../ui/lazy';
import type { Sim3DModel } from './model';

/** 1 回に計算に使う時間 [ms] */
const STEP_BUDGET_MS = 14;
/** 流れの結果を画面に届ける間隔 [ms]（結果の取り出し・色の付け直しは重いので、毎ステップはしない） */
export const FLOW_PUBLISH_MS = 500;

/** 既定のソルバー（Lite の 3D の熱）。画面から使うときの遅延 import */
export const loadHeat3DSolver = (): Promise<Solver3DFactory | null> =>
  withLoading({ label: '3D の熱の解析エンジン', task: import('../solvers/heat3d').then((m) => m.createHeat3DSolver) });

/** Lite の 3D の流れ。画面から使うときの遅延 import */
export const loadFlow3DSolver = (): Promise<Solver3DFactory | null> =>
  withLoading({ label: '3D の流れの解析エンジン', task: import('../solvers/flow3d').then((m) => m.createFlow3DSolver) });

/** 解析の種類に合う Lite のソルバー（まだない解析は null） */
export const loadSolver3D = (analysis: Analysis3DKind): Promise<Solver3DFactory | null> => {
  if (analysis === 'heat') return loadHeat3DSolver();
  if (analysis === 'flow') return loadFlow3DSolver();
  return Promise.resolve(null);
};

/** 止めるまで進み続ける解析か（流れ） */
export const isContinuous = (analysis: Analysis3DKind): boolean => analysis === 'flow';

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 計算を始めた時点の Study3D のコピー（形は共有し、条件・設定は複製する） */
export function snapshotStudy(study: Study3D): Study3D {
  return {
    ...study,
    regions: study.regions.map((r) => ({ ...r, faces: [...r.faces], force: r.force ? { ...r.force } : undefined })),
    heat: { ...study.heat },
    stress: { ...study.stress },
    flow: study.flow ? { ...study.flow, domain: study.flow.domain ? { ...study.flow.domain } : undefined, thermal: study.flow.thermal ? { ...study.flow.thermal } : undefined, advanced: study.flow.advanced ? { ...study.flow.advanced } : undefined } : undefined,
    grid: study.grid ? { ...study.grid } : undefined,
  };
}

/** 進行中の計算 1 つ分 */
interface Session {
  token: number;
  solver: Solver3D;
  study: Study3D;
  signature: string;
  startedAt: number;
  continuous: boolean;
  paused: boolean;
  /** 結果を最後に届けた時刻と、そのときのステップ数（1 秒あたりのステップ数を出す） */
  lastPublishAt: number;
  lastPublishIter: number;
  stepsPerSec?: number;
  physTime?: number;
  iteration: number;
  progress: number;
}

export class Sim3DRunner {
  private token = 0;
  private timer = 0;
  private session: Session | null = null;

  constructor(
    private model: Sim3DModel,
    private loadSolver: (analysis: Analysis3DKind) => Promise<Solver3DFactory | null> = loadSolver3D,
  ) {}

  /** 読み込み中か、計算が進んでいる最中か */
  get busy(): boolean {
    return this.model.run.kind === 'loading' || this.model.run.kind === 'running';
  }

  /** 一時停止中の計算があるか（再開・最初からができる） */
  get paused(): boolean {
    return this.session?.paused === true;
  }

  /** 流れのように止めるまで続く計算の途中か（動いているか一時停止中） */
  get live(): boolean {
    return this.session !== null && this.session.continuous;
  }

  /** 計算を始める（計算中は何もしない。一時停止中なら再開する） */
  start(): void {
    if (this.paused) {
      this.resume();
      return;
    }
    if (this.busy) return;
    this.begin();
  }

  private begin(): void {
    const token = ++this.token;
    const study = snapshotStudy(this.model.study);
    const signature = this.model.signature;
    this.session = null;
    this.model.setRun({ kind: 'loading' });
    void this.loadSolver(study.analysis).then((factory) => {
      if (token !== this.token) return; // 読み込み中に中止された
      if (!factory) {
        this.model.setRun({ kind: 'error', message: '3D の解析エンジンを読み込めませんでした。ページを開き直してみてください。' });
        return;
      }
      let solver: Solver3D;
      try {
        solver = factory(study);
      } catch (e) {
        this.model.setRun({ kind: 'error', message: `計算を始められませんでした: ${message(e)}` });
        return;
      }
      const now = performance.now();
      this.session = {
        token,
        solver,
        study,
        signature,
        startedAt: now,
        continuous: isContinuous(study.analysis),
        paused: false,
        lastPublishAt: now,
        lastPublishIter: 0,
        iteration: 0,
        progress: 0,
      };
      this.loop(this.session);
    });
  }

  private loop(s: Session): void {
    if (s.token !== this.token || s.paused) return;
    try {
      const st = s.solver.step(STEP_BUDGET_MS);
      s.iteration = st.iteration;
      s.progress = st.progress;
      if (st.done) {
        this.model.setResult(s.solver.result(), s.signature, s.study.flow);
        this.session = null;
        this.model.setRun({ kind: 'idle' });
        return;
      }
      if (s.continuous) {
        const now = performance.now();
        if (now - s.lastPublishAt >= FLOW_PUBLISH_MS) {
          this.publish(s, now);
          this.model.setRun({ kind: 'running', iteration: st.iteration, progress: st.progress, residual: st.residual, message: st.message, startedAt: s.startedAt, physTime: s.physTime, stepsPerSec: s.stepsPerSec });
        } else if (this.model.run.kind !== 'running') {
          // 始めてから最初の結果が届くまで（または再開の直後）も、動いていることを表示する
          this.model.setRun({ kind: 'running', iteration: st.iteration, progress: st.progress, residual: st.residual, message: st.message, startedAt: s.startedAt, physTime: s.physTime, stepsPerSec: s.stepsPerSec });
        }
      } else {
        this.model.setRun({ kind: 'running', iteration: st.iteration, progress: st.progress, residual: st.residual, message: st.message, startedAt: s.startedAt });
      }
    } catch (e) {
      this.session = null;
      this.model.setRun({ kind: 'error', message: `計算中にエラーが起きました: ${message(e)}` });
      return;
    }
    // 画面を描く時間を空けるため、setTimeout で次へ（タブが裏に回っても進む）
    this.timer = window.setTimeout(() => this.loop(s), 0);
  }

  /** いまの結果を画面に届け、1 秒あたりのステップ数と経過時間（物理）を更新する */
  private publish(s: Session, now: number): void {
    const res = s.solver.result();
    const dt = (now - s.lastPublishAt) / 1000;
    if (dt > 0 && s.iteration > s.lastPublishIter) s.stepsPerSec = (s.iteration - s.lastPublishIter) / dt;
    s.lastPublishAt = now;
    s.lastPublishIter = s.iteration;
    const t = res.scalars.find((x) => x.key === 'time');
    s.physTime = t && Number.isFinite(t.value) ? t.value : undefined;
    this.model.setResult(res, s.signature, s.study.flow);
  }

  /** 流れを一時停止する（その時点の結果を届ける）。続きは resume() */
  pause(): void {
    const s = this.session;
    if (!s || !s.continuous || s.paused || !this.busy) return;
    s.paused = true;
    window.clearTimeout(this.timer);
    this.publish(s, performance.now());
    this.model.setRun({ kind: 'paused', iteration: s.iteration, progress: s.progress, physTime: s.physTime, stepsPerSec: s.stepsPerSec });
  }

  /** 一時停止した流れを、続きから再開する */
  resume(): void {
    const s = this.session;
    if (!s || !s.paused) return;
    s.paused = false;
    const now = performance.now();
    s.lastPublishAt = now;
    s.lastPublishIter = s.iteration;
    this.model.setRun({ kind: 'running', iteration: s.iteration, progress: s.progress, startedAt: s.startedAt, physTime: s.physTime, stepsPerSec: s.stepsPerSec });
    this.loop(s);
  }

  /** 最初からやり直す（いまの条件で、新しく計算を始める。前の結果は新しい結果が届くまで残る） */
  restart(): void {
    this.token++;
    window.clearTimeout(this.timer);
    this.session = null;
    this.begin();
  }

  /** 中止する。前の結果はそのまま残る */
  cancel(): void {
    if (!this.busy && !this.paused) return;
    this.token++;
    window.clearTimeout(this.timer);
    this.session = null;
    this.model.setRun({ kind: 'cancelled' });
  }

  /** 画面に何も出さずに、進行中の計算を捨てる（解析の種類を切り替えるとき） */
  reset(): void {
    this.token++;
    window.clearTimeout(this.timer);
    this.session = null;
  }

  dispose(): void {
    this.reset();
  }
}
