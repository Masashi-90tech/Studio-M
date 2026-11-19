// 同梱物（payload）だけで動く一連の処理: 形状ワーカー → メッシュワーカー → CalculiX → 応力集中係数。
// ワーカーは別プロセス。Electron の main.js からも `import()` して使えるよう、関数として export している。
//
// コマンドラインから:
//   node run-pipeline.mjs --payload <payload のフォルダー> --work <作業フォルダー> [--mesh-size 10] [--runs 2] [--json 出力.json]
//   --shape-site-packages <パス>   形状ワーカーの site-packages を差し替える（vtk なしの変種を試すとき）
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** payload の中のパス（すべてここから導く） */
export function payloadPaths(payloadDir, shapeSitePackages) {
  const p = resolve(payloadDir);
  return {
    python: join(p, 'runtime', 'python', 'bin', 'python3'),
    shapeScript: join(p, 'workers', 'shape', 'shape_worker.py'),
    shapeSite: shapeSitePackages ? resolve(shapeSitePackages) : join(p, 'workers', 'shape', 'site-packages'),
    meshScript: join(p, 'workers', 'mesh', 'mesh_worker.py'),
    meshSite: join(p, 'workers', 'mesh', 'site-packages'),
    ccxTool: join(p, 'workers', 'common', 'ccx_tool.py'),
    ccx: join(p, 'engines', 'calculix', 'bin', 'ccx'),
    ccxLib: join(p, 'engines', 'calculix', 'lib'),
  };
}

function exec(file, args, { cwd, env }) {
  return new Promise((done) => {
    const t0 = performance.now();
    const child = spawn(file, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => done({ code: -1, out, err: String(e.message), ms: performance.now() - t0 }));
    child.on('close', (code) => done({ code: code ?? -1, out, err, ms: performance.now() - t0 }));
  });
}

/** 標準出力の最後の JSON 行を読む（OCCT が途中に統計を出すため、最後の { で始まる行だけ見る） */
function lastJson(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  if (lines.length === 0) return null;
  try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
}

function stageError(name, r) {
  const tail = (r.err || r.out).trim().split('\n').slice(-4).join(' / ');
  return new Error(`${name}の段で失敗しました（終了コード ${r.code}）: ${tail}`);
}

/**
 * 1 回分を流す。
 * @param {{ payloadDir: string, workDir: string, meshSize?: number, shapeSitePackages?: string, onLog?: (s: string) => void }} o
 */
export async function runOnce(o) {
  const log = o.onLog ?? (() => {});
  const P = payloadPaths(o.payloadDir, o.shapeSitePackages);
  for (const [k, v] of Object.entries(P)) {
    if (k !== 'ccxLib' && !existsSync(v)) {
      throw new Error(`同梱物が見つかりません: ${v}（${k}）。build-bundle.sh を実行したか、--payload のパスが合っているか確認してください`);
    }
  }
  mkdirSync(o.workDir, { recursive: true });
  const baseEnv = { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  // 親のプロセスの PYTHON 系の設定が混ざらないようにする
  delete baseEnv.PYTHONHOME;
  const pyEnv = (site) => ({ ...baseEnv, PYTHONPATH: site });
  const stages = {};
  const t0 = performance.now();

  const stepPath = join(o.workDir, 'plate.step');
  log('形状ワーカー（OCP）で平板を作ります');
  let r = await exec(P.python, [P.shapeScript, '--out', stepPath], { cwd: o.workDir, env: pyEnv(P.shapeSite) });
  stages.shape_ms = r.ms;
  const shape = lastJson(r.out);
  if (r.code !== 0 || !shape) throw stageError('形状ワーカー', r);

  const meshInp = join(o.workDir, 'mesh.inp');
  log('メッシュワーカー（Gmsh）でメッシュを作ります');
  r = await exec(P.python, [P.meshScript, '--step', stepPath, '--out', meshInp, '--size', String(o.meshSize ?? 10)], { cwd: o.workDir, env: pyEnv(P.meshSite) });
  stages.mesh_ms = r.ms;
  const mesh = lastJson(r.out);
  if (r.code !== 0 || !mesh) throw stageError('メッシュワーカー', r);

  r = await exec(P.python, [P.ccxTool, 'prepare', '--mesh', meshInp, '--job', join(o.workDir, 'job.inp')], { cwd: o.workDir, env: pyEnv(P.shapeSite) });
  stages.prepare_ms = r.ms;
  if (r.code !== 0) throw stageError('計算の入力づくり', r);

  log('CalculiX で解きます');
  // 2026-11-19: Mac（M1）で ccx を 4 スレッドで動かすと、約 7% の確率で間違った答えが出た
  // （30 回中 2 回、反力が 52061 N・69821 N。正しくは 51434 N）。1 スレッドでは 30 回とも正しい。
  // 既定は 1 スレッド。変えて試すときは環境変数 STUDIO_M_CCX_THREADS を指定する（docs/EXPERIMENT-4.md）
  const ccxThreads = process.env.STUDIO_M_CCX_THREADS ?? '1';
  const ccxEnv = { ...baseEnv, OMP_NUM_THREADS: ccxThreads, CCX_NPROC_EQUATION_SOLVER: ccxThreads, CCX_NPROC_RESULTS: '1' };
  if (process.platform === 'linux') ccxEnv.LD_LIBRARY_PATH = P.ccxLib + (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : '');
  if (process.platform === 'darwin') ccxEnv.DYLD_FALLBACK_LIBRARY_PATH = P.ccxLib;
  r = await exec(P.ccx, ['-i', 'job'], { cwd: o.workDir, env: ccxEnv });
  stages.ccx_ms = r.ms;
  writeFileSync(join(o.workDir, 'job.log'), r.out + r.err);
  if (r.code !== 0) throw stageError('CalculiX', r);

  r = await exec(P.python, [P.ccxTool, 'post', '--dir', o.workDir, '--job', 'job'], { cwd: o.workDir, env: pyEnv(P.shapeSite) });
  stages.post_ms = r.ms;
  const kt = lastJson(r.out);
  if (r.code !== 0 || !kt) throw stageError('後処理', r);

  stages.total_ms = performance.now() - t0;
  return {
    ok: kt.rel_error_integration_point <= 0.03,
    stages,
    shape,
    mesh,
    kt,
    workDir: o.workDir,
  };
}

/** 同じ処理を runs 回流す。1 回目がコールド、2 回目以降がウォーム */
export async function runPipeline(o) {
  const runs = o.runs ?? 2;
  const results = [];
  for (let i = 1; i <= runs; i++) {
    const r = await runOnce({ ...o, workDir: join(o.workDir, `run${i}`) });
    r.label = i === 1 ? 'cold' : 'warm';
    results.push(r);
  }
  return results;
}

function parseArgs(argv) {
  const o = { runs: 2, meshSize: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--payload') o.payloadDir = next();
    else if (a === '--work') o.workDir = resolve(next());
    else if (a === '--mesh-size') o.meshSize = Number(next());
    else if (a === '--runs') o.runs = Number(next());
    else if (a === '--json') o.json = resolve(next());
    else if (a === '--shape-site-packages') o.shapeSitePackages = next();
    else throw new Error(`知らない引数です: ${a}`);
  }
  if (!o.payloadDir || !o.workDir) throw new Error('--payload と --work は必須です');
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const results = await runPipeline({ ...o, onLog: (s) => console.error(`  ${s}`) });
    const text = JSON.stringify({ runs: results }, null, 2);
    if (o.json) writeFileSync(o.json, text + '\n');
    else console.log(text);
    const bad = results.find((r) => !r.ok);
    if (bad) {
      console.error(`応力集中係数が文献の近似式から 3% 以上ずれました（${(bad.kt.rel_error_integration_point * 100).toFixed(2)}%）`);
      process.exit(3);
    }
  } catch (e) {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
  }
}
