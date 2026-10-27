// 3D 解析の画面の状態（DOM に依存しない）。画面の各部品はこの 1 か所を見て、変わったら描き直す。
//
// - study:      いま編集している Study3D（変えるたびに新しいオブジェクトに置き換える）
// - selection:  3D の図で選んでいる面（まだ条件になっていない）
// - result:     最後に計算した結果と、そのときの印（studySignature）。今の印と違えば古い結果
// - run:        計算の進み具合
import { mesh3DBounds, type Box3D } from '../core/grid3d';
import type { Analysis3DKind, Flow3DSettings, Region3DRole, ResultSet3D, Study3D } from '../core/types';
import type { Axis } from '../mesh3d/types';
import { flowQualityGrid, switchAnalysis, tunnelBox, withFlow, type FlowQualityId } from './flow-settings';
import { addRegion, removeRegion, studySignature, updateRegion, type AddRegionResult } from './regions';
import { qualityGrid, type QualityId } from './settings';

/** 'analysis' は解析の種類（熱 / 流れ）を切り替えたとき（同時に study・section・result・selection も変わる） */
export type ModelEvent = 'study' | 'selection' | 'result' | 'run' | 'section' | 'view' | 'analysis';

export type RunState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'running';
      iteration: number;
      progress: number;
      residual?: number;
      message?: string;
      startedAt: number;
      /** 流れ（止めるまで進み続ける計算）のとき: 物理の経過時間 [s]・1 秒あたりのステップ数 */
      physTime?: number;
      stepsPerSec?: number;
    }
  /** 流れを一時停止中（再開すると続きから進む） */
  | { kind: 'paused'; iteration: number; progress: number; physTime?: number; stepsPerSec?: number }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

export interface SectionState {
  on: boolean;
  axis: Axis;
  /** 切る位置 [m]（形の外接箱の中） */
  position: number;
  /** true で軸の負の側を隠す（既定は正の側を隠す） */
  flip: boolean;
}

/** 流れの結果で色にする量 */
export type FlowFieldKey = 'pressure' | 'speed';

export interface ViewOptions {
  /** 条件を置いた面を色で見せる */
  showRegions: boolean;
  /** 結果の色を表面に出す */
  showResult: boolean;
  /** 流れ: 表面・断面の色にする量（既定は圧力） */
  flowField: FlowFieldKey;
  /** 流れ: 流線を描く */
  streamlines: boolean;
  /** 流れ: 風洞の枠と風の向きの矢印を描く */
  showTunnel: boolean;
}

/** 解析ごとの結果。flow は、計算を始めた時点の流れの設定（結果の流線は、そのときの風の向きで描く） */
export interface ModelResult {
  data: ResultSet3D;
  signature: string;
  flow?: Flow3DSettings;
}

export class Sim3DModel {
  study: Study3D;
  selection: ReadonlySet<number> = new Set();
  /** 一覧で選んでいる条件（その面を強調する） */
  activeRegionId: string | null = null;
  /** 解析ごとの結果（切り替えても、前の解析の結果は残る） */
  private results: Partial<Record<Analysis3DKind, ModelResult>> = {};
  /** 解析ごとの計算の細かさ（熱と流れで選択肢が違うので、別々に覚える） */
  private gridMemo: Partial<Record<Analysis3DKind, Study3D['grid']>> = {};
  run: RunState = { kind: 'idle' };
  section: SectionState;
  view: ViewOptions = { showRegions: true, showResult: true, flowField: 'pressure', streamlines: true, showTunnel: true };
  /** 取り込みで気づいたこと（穴のあるモデルなど） */
  readonly warnings: string[];
  readonly bounds: Box3D | null;
  private listeners = new Set<(e: ModelEvent) => void>();

  constructor(study: Study3D, opts: { warnings?: string[] } = {}) {
    this.study = study;
    this.gridMemo[study.analysis] = study.grid;
    this.warnings = opts.warnings ?? [];
    this.bounds = mesh3DBounds(study.mesh);
    const axis: Axis = 2;
    this.section = { on: false, axis, position: this.bounds ? (this.bounds.min[axis] + this.bounds.max[axis]) / 2 : 0, flip: false };
  }

  subscribe(fn: (e: ModelEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ModelEvent): void {
    for (const fn of [...this.listeners]) fn(e);
  }

  // ---------- 設定 ----------
  /** 設定を変える（形は変えない）。印が変われば、今の結果は古くなる */
  private setStudy(next: Study3D): void {
    this.study = next;
    this.emit('study');
  }

  setMaterial(id: string): void {
    this.setStudy({ ...this.study, materialId: id });
  }
  setAmbient(c: number): void {
    this.setStudy({ ...this.study, heat: { ...this.study.heat, ambientC: c } });
  }
  setSurfaceH(h: number): void {
    this.setStudy({ ...this.study, heat: { ...this.study.heat, surfaceH: h } });
  }
  /** 部品全体の発熱 [W]。0 以下なら「なし」 */
  setBodyHeat(w: number): void {
    const heat = { ...this.study.heat };
    if (w > 0) heat.bodyHeatW = w;
    else delete heat.bodyHeatW;
    this.setStudy({ ...this.study, heat });
  }
  setQuality(id: QualityId): void {
    this.setStudy({ ...this.study, grid: qualityGrid(id, this.bounds) });
  }
  setName(name: string): void {
    this.setStudy({ ...this.study, name });
  }

  // ---------- 解析の切り替えと流れの設定 ----------
  /** いま表示している解析の結果（なければ null） */
  get result(): ModelResult | null {
    return this.results[this.study.analysis] ?? null;
  }

  /**
   * 熱 / 流れを切り替える。熱の面の条件・設定はそのまま残す。計算の細かさは解析ごとに別に覚える。
   * 流れでは面の選択は使わないので外す。切り替えた解析の前の結果があれば、それを表示する
   */
  setAnalysis(analysis: Analysis3DKind): void {
    if (this.study.analysis === analysis) return;
    this.gridMemo[this.study.analysis] = this.study.grid;
    this.study = switchAnalysis(this.study, analysis, this.gridMemo[analysis]);
    if (analysis === 'flow') {
      this.selection = new Set();
      this.activeRegionId = null;
    }
    this.run = { kind: 'idle' };
    this.setSection({});
    this.emit('analysis');
    this.emit('study');
    this.emit('selection');
    this.emit('result');
    this.emit('run');
  }

  /** 流れの設定を一部だけ変える（風の向き・速さ・まわり・流体など）。印が変われば、今の結果は古くなる */
  setFlow(patch: Partial<Flow3DSettings>): void {
    this.setStudy(withFlow(this.study, patch));
    // 風洞の大きさが変わるので、断面の位置を新しい範囲に収める
    this.setSection({});
  }

  setFlowQuality(id: FlowQualityId): void {
    this.setStudy({ ...this.study, grid: flowQualityGrid(id) });
  }

  /** 断面を切れる範囲。熱は部品の外接箱、流れは風洞 */
  get sectionBounds(): Box3D | null {
    if (this.study.analysis === 'flow') return tunnelBox(this.study) ?? this.bounds;
    return this.bounds;
  }

  // ---------- 面の選択と条件 ----------
  setSelection(sel: ReadonlySet<number>): void {
    this.selection = sel;
    if (sel.size > 0) this.activeRegionId = null;
    this.emit('selection');
  }

  clearSelection(): void {
    if (this.selection.size === 0) return;
    this.setSelection(new Set());
  }

  setActiveRegion(id: string | null): void {
    if (this.activeRegionId === id) return;
    this.activeRegionId = id;
    if (id !== null) this.selection = new Set();
    this.emit('selection');
  }

  /** 選んでいる面に条件を足す。面を取られて消えた条件があればその名前を返す。面が選ばれていなければ Error */
  addRegionFromSelection(role: Region3DRole, value?: number): AddRegionResult {
    const r = addRegion(this.study, { role, faces: [...this.selection], value });
    this.selection = new Set();
    this.activeRegionId = r.region.id;
    this.study = r.study;
    this.emit('selection');
    this.emit('study');
    return r;
  }

  deleteRegion(id: string): void {
    if (this.activeRegionId === id) this.activeRegionId = null;
    this.setStudy(removeRegion(this.study, id));
    this.emit('selection');
  }

  editRegion(id: string, patch: { name?: string; value?: number }): void {
    this.setStudy(updateRegion(this.study, id, patch));
  }

  // ---------- 断面・表示 ----------
  setSection(patch: Partial<SectionState>): void {
    const next = { ...this.section, ...patch };
    // 軸を変えたら、部品の真ん中で切る
    if (patch.axis !== undefined && patch.axis !== this.section.axis && this.bounds && patch.position === undefined) {
      next.position = (this.bounds.min[next.axis] + this.bounds.max[next.axis]) / 2;
    }
    const range = this.sectionBounds;
    if (range) next.position = Math.min(range.max[next.axis], Math.max(range.min[next.axis], next.position));
    this.section = next;
    this.emit('section');
  }

  setView(patch: Partial<ViewOptions>): void {
    this.view = { ...this.view, ...patch };
    this.emit('view');
  }

  // ---------- 計算と結果 ----------
  setRun(run: RunState): void {
    this.run = run;
    this.emit('run');
  }

  /**
   * 結果が届いた（熱は計算が終わったとき、流れは進むたびに）。signature は計算を始めたときの印
   * （そのあとに設定が変わっていれば、すぐ古い結果になる）。flow は計算を始めたときの流れの設定
   */
  setResult(data: ResultSet3D, signature: string, flow?: Flow3DSettings): void {
    this.results[data.analysis] = { data, signature, flow };
    // 結果の色を読み取りやすいよう、一覧で選んでいた条件の強調は外す
    if (this.activeRegionId !== null && data.analysis === this.study.analysis) {
      this.activeRegionId = null;
      this.emit('selection');
    }
    this.emit('result');
  }

  clearResult(): void {
    if (!this.result) return;
    delete this.results[this.study.analysis];
    this.emit('result');
  }

  private sigCache: { study: Study3D; sig: string } | null = null;

  /** いまの形・条件・設定の印（同じ study のあいだは計算し直さない） */
  get signature(): string {
    if (!this.sigCache || this.sigCache.study !== this.study) this.sigCache = { study: this.study, sig: studySignature(this.study) };
    return this.sigCache.sig;
  }

  /** 結果が、いまの形・条件・設定で計算したものでなければ true（結果がないときは false） */
  get stale(): boolean {
    return this.result !== null && this.result.signature !== this.signature;
  }
}
