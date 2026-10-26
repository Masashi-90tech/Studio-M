// 3D の計算を少しずつ進める。ソルバーは使うときに遅延 import で読み込む（重いので起動時には入れない）。
// 2D の src/ui/runner.ts と同じ進め方: step(budgetMs) を繰り返し、そのあいだに画面が固まらないよう合間を空ける。
// 計算を始めた時点の形・条件のコピーで解く。計算中に画面で条件を変えても、結果は「古い結果」として届く。
import type { Solver3D, Solver3DFactory, Study3D } from '../core/types';
import { withLoading } from '../ui/lazy';
import type { Sim3DModel } from './model';

/** 1 回に計算に使う時間 [ms] */
const STEP_BUDGET_MS = 14;

/** 既定のソルバー（Lite の 3D の熱）。画面から使うときの遅延 import */
export const loadHeat3DSolver = (): Promise<Solver3DFactory | null> =>
  withLoading({ label: '3D の熱の解析エンジン', task: import('../solvers/heat3d').then((m) => m.createHeat3DSolver) });

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
    grid: study.grid ? { ...study.grid } : undefined,
  };
}

export class Sim3DRunner {
  private token = 0;
  private timer = 0;

  constructor(
    private model: Sim3DModel,
    private loadSolver: () => Promise<Solver3DFactory | null> = loadHeat3DSolver,
  ) {}

  get busy(): boolean {
    return this.model.run.kind === 'loading' || this.model.run.kind === 'running';
  }

  /** 計算を始める（計算中は何もしない） */
  start(): void {
    if (this.busy) return;
    const token = ++this.token;
    const study = snapshotStudy(this.model.study);
    const signature = this.model.signature;
    this.model.setRun({ kind: 'loading' });
    void this.loadSolver().then((factory) => {
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
      this.loop(token, solver, signature, performance.now());
    });
  }

  private loop(token: number, solver: Solver3D, signature: string, startedAt: number): void {
    if (token !== this.token) return;
    try {
      const st = solver.step(STEP_BUDGET_MS);
      if (st.done) {
        this.model.setResult(solver.result(), signature);
        this.model.setRun({ kind: 'idle' });
        return;
      }
      this.model.setRun({ kind: 'running', iteration: st.iteration, progress: st.progress, residual: st.residual, message: st.message, startedAt });
    } catch (e) {
      this.model.setRun({ kind: 'error', message: `計算中にエラーが起きました: ${message(e)}` });
      return;
    }
    // 画面を描く時間を空けるため、setTimeout で次へ（タブが裏に回っても進む）
    this.timer = window.setTimeout(() => this.loop(token, solver, signature, startedAt), 0);
  }

  /** 中止する。前の結果はそのまま残る */
  cancel(): void {
    if (!this.busy) return;
    this.token++;
    window.clearTimeout(this.timer);
    this.model.setRun({ kind: 'cancelled' });
  }

  dispose(): void {
    this.token++;
    window.clearTimeout(this.timer);
  }
}
