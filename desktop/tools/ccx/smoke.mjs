// 製品版の ccx の動作確認（追加パッケージなし）。片持ち梁を解き、先端のたわみを理論値 PL^3/(3EI) と比べる。
//   node smoke.mjs <ccx の実行ファイル>
// 日本語と空白を含む一時フォルダーで解き、CCX_NPROC_EQUATION_SOLVER=1 で 5 回走らせて毎回同じ値になることも確かめる
// （実験 4 で、連立方程式を解く部分の並列実行が時々間違った答えを出したため。docs/EXPERIMENT-4.md）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BEAM = { L: 100, B: 10, H: 10, E: 210000, NU: 0.3, P: 100, N: 8 };
export const TOLERANCE = 0.02; // 理論値との差 2% 以内で合格
export const RUNS = 5;

/** 片持ち梁の先端のたわみの理論値（mm）。PL^3/(3EI) */
export function theoryDeflection(b = BEAM) {
  const I = (b.B * b.H ** 3) / 12;
  return (b.P * b.L ** 3) / (3 * b.E * I);
}

/** 片持ち梁の .inp（梁要素 B31 を N 個。左端を固定、右端に +y 方向の力 P） */
export function buildBeamInp(b = BEAM) {
  const nodes = [];
  for (let i = 0; i <= b.N; i++) nodes.push(`${i + 1}, ${((b.L * i) / b.N).toFixed(6)}, 0., 0.`);
  const elems = [];
  for (let i = 0; i < b.N; i++) elems.push(`${i + 1}, ${i + 1}, ${i + 2}`);
  return `*NODE
${nodes.join('\n')}
*ELEMENT, TYPE=B31, ELSET=EALL
${elems.join('\n')}
*NSET, NSET=NFIX
1
*NSET, NSET=NTIP
${b.N + 1}
*MATERIAL, NAME=STEEL
*ELASTIC
${b.E}., ${b.NU}
*BEAM SECTION, ELSET=EALL, MATERIAL=STEEL, SECTION=RECT
${b.B}., ${b.H}.
0., 0., 1.
*STEP
*STATIC
*BOUNDARY
NFIX, 1, 6, 0.
*CLOAD
NTIP, 2, ${b.P}.
*NODE PRINT, NSET=NTIP
U
*END STEP
`;
}

/** .dat の本文から、先端の y 方向の変位の絶対値（mm）を読む。読めなければ Error */
export function parseTipDeflection(dat) {
  const lines = dat.split('\n');
  const i = lines.findIndex((l) => l.includes('displacements (vx,vy,vz)'));
  if (i < 0) throw new Error('.dat に変位が出ていません。ccx が途中で止まった可能性があります（標準出力のログを確認してください）');
  const row = lines.slice(i + 1).find((l) => l.trim() !== '');
  const cols = row ? row.trim().split(/\s+/) : [];
  const uy = Math.abs(Number(cols[2]));
  if (!Number.isFinite(uy)) throw new Error(`.dat の変位の行を読めません: ${row}`);
  return uy;
}

/** 理論値との相対差 */
export function relError(value, theory) {
  return Math.abs(value - theory) / theory;
}

/** 全部の値が同じ（相対差 1e-9 以内）か */
export function allSame(values) {
  return values.length > 0 && values.every((v) => Math.abs(v - values[0]) <= 1e-9 * Math.max(1, Math.abs(values[0])));
}

function solveOnce(ccx, dir) {
  writeFileSync(join(dir, 'beam.inp'), buildBeamInp());
  const r = spawnSync(ccx, ['beam'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CCX_NPROC_EQUATION_SOLVER: '1' },
  });
  if (r.error) throw new Error(`ccx を起動できません（${ccx}）: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ccx が失敗しました（終了コード ${r.status}）:\n${(r.stdout ?? '') + (r.stderr ?? '')}`);
  return parseTipDeflection(readFileSync(join(dir, 'beam.dat'), 'utf8'));
}

function main() {
  const ccx = process.argv[2];
  if (!ccx) {
    console.error('使い方: node smoke.mjs <ccx の実行ファイル>');
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), 'Studio M 試験 '));
  try {
    const theory = theoryDeflection();
    const values = [];
    for (let i = 0; i < RUNS; i++) values.push(solveOnce(ccx, dir));
    const err = relError(values[0], theory);
    console.log(`たわみ ${values[0]} mm / 理論値 ${theory} mm / 差 ${(err * 100).toFixed(3)}%（${RUNS} 回の実行）`);
    if (err > TOLERANCE) {
      console.error(`失敗: 理論値との差が ${TOLERANCE * 100}% を超えています。ビルドの設定（SPOOLES・ARPACK・BLAS のリンク）を確認してください`);
      return 1;
    }
    if (!allSame(values)) {
      console.error(`失敗: ${RUNS} 回の結果が一致しません（${values.join(', ')}）。CCX_NPROC_EQUATION_SOLVER=1 が効いているか確認してください`);
      return 1;
    }
    console.log('合格');
    return 0;
  } catch (e) {
    console.error(`失敗: ${e.message}`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
