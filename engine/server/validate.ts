// 画面から届いた JSON の検査。足りない・形が違うものは、利用者向けの日本語で断る。
// 検査を通ったものだけをジョブにする。ファイルのパスや命令は、画面からは一切受け取らない。
import { isAnalysisKind } from '../../src/core/analyses';
import type { EngineCapability, EngineId, JobQuality, JobRequest } from '../../src/core/engine-protocol';
import type { Project } from '../../src/core/types';

export const ENGINE_IDS: readonly EngineId[] = ['calculix', 'openfoam', 'gmsh', 'elmer', 'openems'];
const QUALITIES: readonly JobQuality[] = ['draft', 'standard', 'fine'];
const ROLES = ['solid', 'heatSource', 'hole', 'fixedTemp', 'support', 'load'];
const MAX_NX = 4000;
const MAX_SHAPES = 5000;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkGeom(g: unknown): string | null {
  if (!isObj(g)) return '形状の形が違います';
  switch (g.kind) {
    case 'rect':
      return isNum(g.x) && isNum(g.y) && isNum(g.w) && isNum(g.h) ? null : '長方形の数値が正しくありません';
    case 'circle':
      return isNum(g.cx) && isNum(g.cy) && isNum(g.r) ? null : '円の数値が正しくありません';
    case 'polygon':
      return Array.isArray(g.points) && g.points.length <= 100_000 && g.points.every((p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1])) ? null : '多角形の点が正しくありません';
    default:
      return '知らない形状の種類です';
  }
}

/** プロジェクトの構造を検査する（値の意味までは見ない。意味の検査はアダプター側） */
export function checkProject(p: unknown): Checked<Project> {
  if (!isObj(p)) return fail('project がありません');
  if (p.version !== 1) return fail('project.version が 1 ではありません（Studio M の版が合っていません）');
  const d = p.domain;
  if (!isObj(d) || !isNum(d.width) || !isNum(d.height) || !isNum(d.nx) || d.width <= 0 || d.height <= 0) return fail('project.domain（幅・高さ・格子数）が正しくありません');
  if (!Number.isInteger(d.nx) || d.nx < 4 || d.nx > MAX_NX) return fail(`格子数 nx は 4〜${MAX_NX} の整数にしてください`);
  if (!isNum(p.thickness) || p.thickness <= 0) return fail('project.thickness が正しくありません');
  if (!Array.isArray(p.shapes) || p.shapes.length > MAX_SHAPES) return fail(`project.shapes は ${MAX_SHAPES} 個までの配列にしてください`);
  for (const s of p.shapes) {
    if (!isObj(s) || typeof s.id !== 'string' || typeof s.materialId !== 'string') return fail('形状に id と materialId が必要です');
    if (typeof s.role !== 'string' || !ROLES.includes(s.role)) return fail('形状の役割が正しくありません');
    const g = checkGeom(s.geom);
    if (g) return fail(g);
  }
  for (const key of ['flow', 'heat', 'stress', 'scalar', 'em'] as const) {
    if (!isObj(p[key])) return fail(`project.${key} がありません`);
  }
  if (p.pcb !== undefined && (!isObj(p.pcb) || !Array.isArray(p.pcb.layers))) return fail('project.pcb の形が正しくありません');
  return { ok: true, value: p as unknown as Project };
}

/** capability の options の仕様に沿って、受け取った options を検査し、省略分は既定値で埋める */
export function checkOptions(cap: EngineCapability, raw: unknown): Checked<Record<string, number | string | boolean>> {
  const specs = cap.options ?? [];
  const given = raw === undefined ? {} : raw;
  if (!isObj(given)) return fail('options はオブジェクトにしてください');
  const out: Record<string, number | string | boolean> = {};
  for (const key of Object.keys(given)) {
    if (!specs.some((s) => s.key === key)) return fail(`options に知らない項目「${key}」があります`);
  }
  for (const s of specs) {
    const v = Object.prototype.hasOwnProperty.call(given, s.key) ? given[s.key] : s.default;
    if (s.kind === 'number') {
      if (!isNum(v)) return fail(`options「${s.label}」は数値にしてください`);
    } else if (s.kind === 'boolean') {
      if (typeof v !== 'boolean') return fail(`options「${s.label}」は true / false にしてください`);
    } else {
      if (typeof v !== 'string' || (s.choices && !s.choices.some((c) => c.value === v))) return fail(`options「${s.label}」の値が選択肢にありません`);
    }
    out[s.key] = v;
  }
  return { ok: true, value: out };
}

/** POST /jobs の本文を検査して JobRequest にする。capabilities はエンジンが対応している組み合わせ */
export function checkJobRequest(body: unknown, capabilities: EngineCapability[]): Checked<JobRequest> {
  if (!isObj(body)) return fail('本文が JSON のオブジェクトではありません');
  if (!isAnalysisKind(body.analysis)) return fail('analysis（解析の種類）が正しくありません');
  if (typeof body.engine !== 'string' || !ENGINE_IDS.includes(body.engine as EngineId)) return fail('engine（エンジン）が正しくありません');
  const engine = body.engine as EngineId;
  const cap = capabilities.find((c) => c.analysis === body.analysis && c.engine === engine);
  if (!cap) return fail(`このエンジン（${engine}）は「${body.analysis}」の解析に対応していません`);
  let quality: JobQuality | undefined;
  if (body.quality !== undefined) {
    if (typeof body.quality !== 'string' || !QUALITIES.includes(body.quality as JobQuality)) return fail('quality は draft / standard / fine のどれかにしてください');
    quality = body.quality as JobQuality;
  }
  const project = checkProject(body.project);
  if (!project.ok) return project;
  const options = checkOptions(cap, body.options);
  if (!options.ok) return options;
  const req: JobRequest = { analysis: body.analysis, engine, project: project.value, options: options.value };
  if (quality) req.quality = quality;
  return { ok: true, value: req };
}
