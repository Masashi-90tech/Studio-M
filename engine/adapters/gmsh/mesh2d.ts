// 形（Project の shapes）から gmsh で 2D のメッシュを作る。実行は必ず ctx.run を通す。
// 他のアダプター（CalculiX の強度など）が「形に沿ったメッシュ」を使うときの入口（generateShapedMesh）。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AdapterContext } from '../../types';
import { parseMsh2, type GmshMesh } from './msh';
import { buildGeo, type GeoOptions, type GeoPlan } from './shapes';

/** 作業フォルダの中の固定のファイル名（プロジェクトの文字列は使わない） */
export const GEO_FILE = 'mesh.geo';
export const MSH_FILE = 'mesh.msh';

const GMSH_TIMEOUT_MS = 5 * 60 * 1000;

export const GMSH_INSTALL_NOTE =
  'gmsh が見つかりません。`pip install gmsh` で入ります（Ubuntu / Debian では `sudo apt install gmsh` でも入ります）。' +
  '公式サイト（gmsh.info）からダウンロードして入れてもかまいません。どの場合も `gmsh` というコマンド名で呼べるようにしてください。' +
  'すぐに用意できないときは、オプションの「メッシュ」を「格子」に戻すと、gmsh なしで解けます。';

/** ctx.run が投げたエラーが「コマンドが見つからない」か */
export function isCommandNotFound(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { reason?: unknown; code?: unknown; message?: unknown };
  return err.reason === 'not-found' || err.code === 'ENOENT' || (typeof err.message === 'string' && /ENOENT/.test(err.message));
}

/** gmsh の出力から、最初のエラーの行（あれば）を取り出す */
export function firstGmshError(output: string): string | undefined {
  const line = output.split(/\r?\n/).find((l) => /^\s*Error\s*:/i.test(l));
  return line?.replace(/^\s*Error\s*:\s*/i, '').trim();
}

const FAILURE_ADVICE =
  '形が重なりすぎている、極端に細い部分がある、多角形が自分自身と交差している、などが考えられます。' +
  '形を単純にする（細すぎる部分や、ほとんど重なっている形を整える）か、計算の細かさを「速く」にしてもう一度試してください。' +
  'ログに gmsh のメッセージが残っています。オプションの「メッシュ」を「格子」に戻せば、形が複雑でも解けます。';

/**
 * .geo を書いて gmsh を走らせ、msh 2.2 を読む。
 * 失敗は日本語の Error（見つからない・メッシュが作れない・時間切れ）。中止は ctx.run の中止のエラーをそのまま投げる。
 */
export async function runGmsh(ctx: AdapterContext, geo: string): Promise<GmshMesh> {
  await fs.writeFile(path.join(ctx.workDir, GEO_FILE), geo);
  let res: { code: number; stdout: string; stderr: string };
  try {
    // -v 3: エラー・警告・直接の出力だけをログに残す（進み具合の細かい行は要らない）
    res = await ctx.run('gmsh', [GEO_FILE, '-2', '-format', 'msh2', '-o', MSH_FILE, '-v', '3'], { timeoutMs: GMSH_TIMEOUT_MS });
  } catch (e) {
    if (isCommandNotFound(e)) throw new Error(GMSH_INSTALL_NOTE);
    throw e;
  }
  if (ctx.signal.aborted) throw new Error('中止しました');
  const output = `${res.stdout}\n${res.stderr}`;
  let text: string | null = null;
  try {
    text = await fs.readFile(path.join(ctx.workDir, MSH_FILE), 'utf8');
  } catch {
    text = null;
  }
  if (res.code !== 0 || text === null) {
    const detail = firstGmshError(output);
    throw new Error(`gmsh でメッシュを作れませんでした${detail ? `（${detail}）` : ''}。${FAILURE_ADVICE}`);
  }
  const mesh = parseMsh2(text);
  if (mesh.triangleCount === 0) throw new Error(`gmsh のメッシュに三角形がありませんでした。${FAILURE_ADVICE}`);
  return mesh;
}

/** 三角形 1 つの面積は、辺の長さ L の正三角形で約 0.433 L²（要素数の見積もり用） */
const TRIANGLE_AREA_FACTOR = Math.sqrt(3) / 4;

export interface ShapedMeshOptions extends GeoOptions {
  /** 要素数の上限の目安。見積もりがこれを超えるときは、寸法を大きくして減らす（省略時は制限なし） */
  maxElements?: number;
}

export interface ShapedMeshResult {
  plan: GeoPlan;
  mesh: GmshMesh;
  /** 実際に使った要素の寸法 [m] */
  size: number;
  /** 要素数の上限のために、寸法を大きくしたか */
  coarsened: boolean;
}

/** 形から .geo を組み立て、gmsh でメッシュにする */
export async function generateShapedMesh(ctx: AdapterContext, opts: ShapedMeshOptions): Promise<ShapedMeshResult> {
  let size = opts.size;
  let plan = buildGeo({ ...opts, size });
  if (plan.shapeIndexes.length === 0) throw new Error('物体がありません。形状（固体）を追加してください。');
  let coarsened = false;
  const cap = opts.maxElements;
  if (cap !== undefined && cap > 0 && plan.bodyAreaUpper / (TRIANGLE_AREA_FACTOR * size * size) > cap) {
    size = Math.sqrt(plan.bodyAreaUpper / (TRIANGLE_AREA_FACTOR * cap));
    plan = buildGeo({ ...opts, size, minSize: opts.minSize === undefined ? undefined : Math.min(opts.minSize, size) });
    coarsened = true;
  }
  ctx.log(`gmsh で形に沿ったメッシュを作ります（要素の寸法 ${(size * 1000).toPrecision(3)} mm）`);
  const mesh = await runGmsh(ctx, plan.geo);
  if (cap !== undefined && cap > 0 && mesh.triangleCount > cap * 2) {
    throw new Error(
      `メッシュの要素が多くなりすぎました（${mesh.triangleCount.toLocaleString('ja-JP')} 個）。` +
        '細かい曲線や狭い部分が多いと、要素が増えます。計算の細かさを「速く」にするか、形を単純にしてもう一度試してください。',
    );
  }
  return { plan, mesh, size, coarsened };
}
