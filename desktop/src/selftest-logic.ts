// --selftest の純粋な部分（electron は import しない）: 引数の読み取り、片持ち梁の組み立て、理論値との比較、結果の整形。
// 梁の形は Lite のテストと同じ（L = 1 m, H = 0.1 m, 厚さ 0.01 m の SS400。左端を固定、右端に下向き P）。
import type { EngineStatus, JobRequest, JobState } from '../../src/core/engine-protocol';
import { defaultProject } from '../../src/core/project';
import type { Project, ResultSet } from '../../src/core/types';

export const SELFTEST_BEAM = { L: 1.0, H: 0.1, T: 0.01, E: 206e9, P: 100, nx: 100 };
/** たわみの理論値との差の許容（片持ち梁は 2D の格子で解くので、梁理論とは少しずれる） */
export const TIP_TOLERANCE = 0.05;
/** 反力と荷重の相対的な差の許容 */
export const REACTION_TOLERANCE = 1e-3;

export interface SelftestArgs {
  enabled: boolean;
  /** 結果の JSON を書くファイル */
  out?: string;
  /** 引数の誤り（日本語） */
  error?: string;
}

/** `--selftest [--out <ファイル>]` を読む。argv は process.argv の全体でよい */
export function parseSelftestArgs(argv: readonly string[]): SelftestArgs {
  if (!argv.includes('--selftest')) return { enabled: false };
  const i = argv.indexOf('--out');
  if (i < 0) return { enabled: true };
  const out = argv[i + 1];
  if (!out || out.startsWith('--')) return { enabled: true, error: '--out の後ろに、結果を書くファイルの名前を指定してください（例: --out selftest.json）' };
  return { enabled: true, out };
}

/** 自己診断用の片持ち梁。格子は 1 cm（nx = 100）に固定 */
export function buildSelftestProject(): Project {
  const { L, H, T, P, nx } = SELFTEST_BEAM;
  const cell = L / nx;
  const p = defaultProject();
  p.name = 'Studio M Pro 自己診断（片持ち梁）';
  p.domain = { width: L, height: H, nx, autoGrid: false };
  p.thickness = T;
  p.stress = { selfWeight: false };
  p.shapes = [
    { id: 'beam', name: '梁', role: 'solid', materialId: 'ss400', geom: { kind: 'rect', x: 0, y: 0, w: L, h: H } },
    { id: 'fix', name: '固定', role: 'support', materialId: 'ss400', geom: { kind: 'rect', x: 0, y: 0, w: cell, h: H } },
    { id: 'load', name: '荷重', role: 'load', materialId: 'ss400', geom: { kind: 'rect', x: L - cell, y: 0, w: cell, h: H }, force: { fx: 0, fy: -P } },
  ];
  return p;
}

export function buildSelftestJob(): JobRequest {
  return { analysis: 'stress', engine: 'calculix', project: buildSelftestProject(), quality: 'draft' };
}

/** 先端のたわみの理論値 PL³/3EI [m]。固定の 1 セル列の右端から、荷重の 1 セル列の中心までを長さにする */
export function theoryTipDeflection(): number {
  const { L, H, T, E, P, nx } = SELFTEST_BEAM;
  const cell = L / nx;
  const I = (T * H ** 3) / 12;
  const len = L - cell / 2 - cell;
  return (P * len ** 3) / (3 * E * I);
}

export interface SelftestCheck {
  id: string;
  label: string;
  ok: boolean;
  /** 測った値（あれば） */
  value?: number;
  /** 期待した値（あれば） */
  expected?: number;
  /** 日本語の説明（失敗なら、何が起きてどうすれば直るか） */
  detail: string;
}

const scalarOf = (r: ResultSet | undefined, key: string): number | undefined => r?.scalars.find((s) => s.key === key)?.value;

export interface EvaluateOptions {
  status: EngineStatus | null;
  job: JobState | null;
  /** ジョブを投げる・待つ途中で起きた失敗（日本語） */
  jobError?: string;
}

/** /status とジョブの結果から、検査ごとの合否を作る */
export function evaluateSelftest(o: EvaluateOptions): SelftestCheck[] {
  const checks: SelftestCheck[] = [];
  const ccx = o.status?.engines.find((e) => e.id === 'calculix');
  checks.push({
    id: 'calculix-available',
    label: 'CalculiX が使える',
    ok: !!ccx?.available,
    detail: ccx?.available ? `CalculiX ${ccx.version ?? ''}（${ccx.via}）を検出しました` : `CalculiX を検出できませんでした。${ccx?.note ?? 'アプリを入れ直してください'}`,
  });
  const done = o.job?.status === 'done' && !!o.job.result;
  checks.push({
    id: 'job-done',
    label: '片持ち梁の本計算が終わる',
    ok: done,
    detail: done
      ? '本計算が終わりました'
      : o.jobError ?? `ジョブが ${o.job?.status ?? '未実行'} で終わりました。${o.job?.error ?? ''}${o.job ? `\nログの末尾:\n${o.job.log.slice(-8).join('\n')}` : ''}`.trim(),
  });
  const tip = scalarOf(o.job?.result, 'maxDisplacement');
  const theory = theoryTipDeflection();
  const err = tip === undefined ? undefined : Math.abs(tip - theory) / theory;
  checks.push({
    id: 'tip-deflection',
    label: `先端のたわみが梁理論（PL³/3EI）と ${TIP_TOLERANCE * 100}% 以内`,
    ok: err !== undefined && err <= TIP_TOLERANCE,
    value: tip,
    expected: theory,
    detail: err === undefined ? '結果にたわみ（maxDisplacement）がありません' : `たわみ ${tip} m、理論値 ${theory} m、差 ${(err * 100).toFixed(2)}%`,
  });
  const reaction = scalarOf(o.job?.result, 'reaction');
  const P = SELFTEST_BEAM.P;
  const rerr = reaction === undefined ? undefined : Math.abs(reaction - P) / P;
  checks.push({
    id: 'reaction-balance',
    label: '反力が荷重と釣り合う',
    ok: rerr !== undefined && rerr <= REACTION_TOLERANCE,
    value: reaction,
    expected: P,
    detail: rerr === undefined ? '結果に反力（reaction）がありません' : `反力 ${reaction} N、荷重 ${P} N、差 ${(rerr * 100).toFixed(3)}%`,
  });
  return checks;
}

export interface SelftestReport {
  ok: boolean;
  /** 見つかった同梱の ccx の場所（なければ null） */
  ccxPath: string | null;
  engineVersion: string | null;
  os: string;
  appVersion: string;
  checks: SelftestCheck[];
  finishedAt: string;
}

export interface BuildReportOptions {
  checks: SelftestCheck[];
  ccxPath: string | null;
  status: EngineStatus | null;
  os: string;
  appVersion: string;
  now?: Date;
}

export function buildReport(o: BuildReportOptions): SelftestReport {
  return {
    ok: o.checks.length > 0 && o.checks.every((c) => c.ok),
    ccxPath: o.ccxPath,
    engineVersion: o.status?.version ?? null,
    os: o.os,
    appVersion: o.appVersion,
    checks: o.checks,
    finishedAt: (o.now ?? new Date()).toISOString(),
  };
}

/** 終了コード: 合格 0、失敗 1 */
export const exitCodeOf = (r: SelftestReport): number => (r.ok ? 0 : 1);

export const NO_CCX_MESSAGE =
  '同梱の ccx が見つかりません。アプリの resources/ccx に ccx の実行ファイルが入っていません。インストーラーを作り直すか、アプリを入れ直してください';
