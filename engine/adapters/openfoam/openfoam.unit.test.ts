import { describe, expect, it } from 'vitest';
import { defaultProject } from '../../../src/core/project';
import type { JobRequest } from '../../../src/core/engine-protocol';
import type { DetectContext } from '../../types';
import { type CaseSpec, blockMeshDict, controlDict, fvSchemes, fvSolution, num, topoSetDict, transportProperties, turbulenceProperties } from './dicts';
import { fieldCellId, fieldK, fieldNut, fieldOmega, fieldP, fieldU, makeObstacleWall } from './fields';
import { parseInternalField, parseSolverLog, parseTimeLine, scalarListLiteral, vectorListLiteral } from './foamio';
import { bodyForce, collectBodyFaces } from './forces';
import { openfoamAdapter, parseOpenFoamVersion } from './index';
import { initialVelocity, mapCellsFromIds, mapCellsSorted, prepareDomain } from './mesh';
import { pickModel, planJob, readOptions, scaleNx, snapshotCount } from './plan';
import { buildFlowResult, estimateStrouhal } from './results';

const spec = (over: Partial<CaseSpec> = {}): CaseSpec => ({
  model: 'laminar',
  uInf: 0.5,
  nu: 1.5e-5,
  rho: 1.2,
  walls: 'slip',
  length: 0.1,
  endTime: 40,
  deltaT: 0.001,
  maxDeltaT: 0.01,
  maxCo: 0.7,
  intensity: 0.01,
  snapshots: 100,
  residualControl: true,
  ...over,
});

/** 左右と中央に物体がある小さなラスター */
function smallRaster(rows: string[]): { nx: number; ny: number; h: number; solid: Uint8Array } {
  // rows[0] が一番上の行。# = 物体
  const ny = rows.length;
  const nx = rows[0].length;
  const solid = new Uint8Array(nx * ny);
  rows.forEach((row, k) => {
    const j = ny - 1 - k;
    for (let i = 0; i < nx; i++) solid[j * nx + i] = row[i] === '#' ? 1 : 0;
  });
  return { nx, ny, h: 0.1, solid };
}

describe('辞書の書き出し', () => {
  it('num は指数表記を OpenFOAM が読める形にし、非有限値は拒否する', () => {
    expect(num(1.5e-5)).toBe('0.000015');
    expect(num(1e-7)).toBe('1e-7');
    expect(num(1.2e25)).toBe('1.2e25');
    expect(() => num(NaN)).toThrow();
  });

  it('blockMeshDict: scale・1 セル厚（奥行き = h）・上下の境界の種類', () => {
    const slip = blockMeshDict({ nx: 40, ny: 20, h: 0.05, walls: 'slip' });
    expect(slip).toContain('scale 1;');
    expect(slip).not.toContain('convertToMeters');
    expect(slip).toContain('(40 20 1)');
    expect(slip).toContain('(2 1 0.05)');
    expect(slip.match(/symmetryPlane/g)).toHaveLength(2);
    expect(slip).toContain('type empty;');
    const wall = blockMeshDict({ nx: 40, ny: 20, h: 0.05, walls: 'noslip' });
    expect(wall.match(/type wall;/g)).toHaveLength(2);
    expect(wall).not.toContain('symmetryPlane');
  });

  it('topoSetDict: 固体のセル番号を labelToCell で選び、反転して fluidCells にする', () => {
    const t = topoSetDict([3, 4, 5, 13]);
    expect(t).toContain('labelToCell');
    expect(t).toContain('3 4 5 13');
    expect(t).toContain('action  invert;');
    expect(t.match(/name {4}fluidCells;/g)).toHaveLength(2);
  });

  it('controlDict: functionObject を使わず、ascii・圧縮なしで、解法ごとに時間の進め方が違う', () => {
    const c = controlDict(spec());
    expect(c).toContain('application     pimpleFoam;');
    expect(c).toContain('adjustTimeStep  yes;');
    expect(c).toContain('maxCo           0.7;');
    expect(c).toContain('writeInterval   0.4;'); // 40 s / 100 回
    expect(c).toContain('writeFormat     ascii;');
    expect(c).toContain('writeCompression off;');
    expect(c).not.toContain('functions');
    const s = controlDict(spec({ model: 'rans', endTime: 800, snapshots: 100 }));
    expect(s).toContain('application     simpleFoam;');
    expect(s).toContain('deltaT          1;');
    expect(s).toContain('writeInterval   8;');
    expect(s).not.toContain('adjustTimeStep');
  });

  it('fvSchemes / fvSolution: モデルごとの離散化と解法', () => {
    expect(fvSchemes(spec())).toContain('backward');
    expect(fvSchemes(spec())).toContain('linearUpwind grad(U)');
    expect(fvSchemes(spec({ model: 'les' }))).toContain('LUST');
    const rans = fvSchemes(spec({ model: 'rans' }));
    expect(rans).toContain('steadyState');
    expect(rans).toContain('bounded Gauss linearUpwind');
    expect(rans).toContain('wallDist');
    expect(fvSolution(spec())).toContain('PIMPLE');
    expect(fvSolution(spec({ model: 'rans' }))).toContain('consistent      yes;');
    expect(fvSolution(spec({ model: 'rans' }))).toContain('residualControl');
    expect(fvSolution(spec({ model: 'rans', residualControl: false }))).not.toContain('residualControl');
  });

  it('transportProperties / turbulenceProperties', () => {
    expect(transportProperties(spec())).toContain('nu              0.000015;');
    expect(turbulenceProperties(spec())).toContain('simulationType  laminar;');
    expect(turbulenceProperties(spec({ model: 'les' }))).toContain('LESModel        Smagorinsky;');
    expect(turbulenceProperties(spec({ model: 'rans' }))).toContain('RASModel        kOmegaSST;');
    expect(turbulenceProperties(spec())).toContain('FoamFile');
  });

  it('0/ の境界条件: 入口・出口・上下・物体・奥行き', () => {
    const u = fieldU(spec(), 'uniform (0.5 0 0)');
    expect(u).toContain('internalField   uniform (0.5 0 0);');
    expect(u).toMatch(/inlet\s*\{[^}]*fixedValue[^}]*uniform \(0\.5 0 0\)/);
    expect(u).toMatch(/outlet\s*\{[^}]*inletOutlet/);
    expect(u).toMatch(/obstacle\s*\{[^}]*fixedValue[^}]*uniform \(0 0 0\)/);
    expect(u).toMatch(/frontAndBack\s*\{[^}]*empty/);
    expect(u).toMatch(/top\s*\{[^}]*symmetryPlane/);
    const uWall = fieldU(spec({ walls: 'noslip' }), 'uniform (0.5 0 0)');
    expect(uWall).toMatch(/top\s*\{[^}]*fixedValue/);
    expect(fieldP(spec())).toMatch(/outlet\s*\{[^}]*fixedValue/);
    expect(fieldP(spec({ walls: 'noslip' }))).toMatch(/top\s*\{[^}]*zeroGradient/);
    expect(fieldNut(spec({ model: 'les' }))).toContain('nutUSpaldingWallFunction');
    expect(fieldK(spec({ model: 'rans' }))).toContain('kqRWallFunction');
    expect(fieldOmega(spec({ model: 'rans' }))).toContain('omegaWallFunction');
    expect(fieldCellId(spec(), 'nonuniform List<scalar> 0()')).toContain('class       volScalarField;');
  });

  it('RANS の流入の乱れ: k = 1.5 (I U)²', () => {
    const k = fieldK(spec({ model: 'rans', intensity: 0.02, uInf: 10 }));
    expect(k).toContain('internalField   uniform 0.06;'); // 1.5 × (0.2)²
  });

  it('makeObstacleWall: subsetMesh の patch を wall にし、inGroups も直す', () => {
    const boundary = `5\n(\n    inlet\n    {\n        type            patch;\n        nFaces          10;\n        startFace       370;\n    }\n    obstacle\n    {\n        type            patch;\n        inGroups        1(empty);\n        nFaces          48;\n        startFace       28492;\n    }\n)\n`;
    const out = makeObstacleWall(boundary);
    expect(out).toMatch(/obstacle\s*\{\s*type\s+wall;\s*inGroups\s+1\(wall\);\s*nFaces\s+48;/);
    expect(out).toMatch(/inlet\s*\{\s*type\s+patch;/); // 他は変えない
    expect(() => makeObstacleWall('1(inlet{type patch;})')).toThrow('obstacle');
  });
});

describe('ラスター ↔ メッシュ', () => {
  it('prepareDomain: 物体のセル・空洞・代表長さ', () => {
    const r = smallRaster([
      '..........',
      '...###....',
      '...#.#....', // 真ん中の . は物体に囲まれた空洞
      '...###....',
      '..........',
    ]);
    const d = prepareDomain(r);
    expect(d.bodyCells).toBe(8);
    expect(d.pocketCells).toBe(1);
    expect(d.fluidCells).toBe(50 - 9);
    expect(d.solidLabels).toHaveLength(9);
    expect(d.length).toBeCloseTo(0.3);
    expect(d.bbox.x0).toBeCloseTo(0.3);
    expect(d.bbox.x1).toBeCloseTo(0.6);
    // 空洞（(4, 2) = 2 行目から数えて中央）は固体扱い
    expect(d.solid[2 * 10 + 4]).toBe(1);
  });

  it('prepareDomain: 物体がない・入口がふさがれている・出口に通じないときは日本語の例外', () => {
    expect(() => prepareDomain(smallRaster(['....', '....']))).toThrow('物体');
    expect(() => prepareDomain(smallRaster(['#...', '#...']))).toThrow('入口');
    expect(() => prepareDomain(smallRaster(['..#.', '..#.']))).toThrow('出口');
  });

  it('mapCellsFromIds: subsetMesh が運んだ元の番号から対応を作る（合成メッシュ）', () => {
    const d = prepareDomain(smallRaster(['....', '.##.', '....']));
    // OpenFOAM の部分メッシュ: 固体を飛ばして昇順に並ぶ → 元の番号がそのまま入る
    const ids = mapCellsSorted(d);
    expect(Array.from(ids)).toEqual([0, 1, 2, 3, 4, 7, 8, 9, 10, 11]);
    const map = mapCellsFromIds(Array.from(ids), d);
    expect(Array.from(map)).toEqual(Array.from(ids));
    // 順番が入れ替わっていても、運ばれた番号のとおりに対応する
    expect(Array.from(mapCellsFromIds([11, 0], d))).toEqual([11, 0]);
  });

  it('mapCellsFromIds: 範囲外・固体・重複・非整数は例外', () => {
    const d = prepareDomain(smallRaster(['....', '.##.', '....']));
    expect(() => mapCellsFromIds([99], d)).toThrow('範囲外');
    expect(() => mapCellsFromIds([5], d)).toThrow('固体');
    expect(() => mapCellsFromIds([0, 0], d)).toThrow('2 つ');
    expect(() => mapCellsFromIds([0.4], d)).toThrow('範囲外');
  });

  it('initialVelocity: 一様流 + 物体の後ろの小さな縦方向の山', () => {
    const cx = [0.1, 0.5, 0.9];
    const cy = [0.5, 0.5, 0.5];
    const { ux, uy } = initialVelocity(cx, cy, { uInf: 2, bbox: { x0: 0.3, x1: 0.4, y0: 0.4, y1: 0.5 }, length: 0.1 });
    expect(Array.from(ux)).toEqual([2, 2, 2]);
    expect(Math.max(...uy)).toBeGreaterThan(0);
    expect(Math.max(...uy)).toBeLessThanOrEqual(0.3 + 1e-12); // 15%
    expect(uy[2]).toBeLessThan(uy[1]); // 離れると弱い
    expect(Array.from(initialVelocity(cx, cy, { uInf: 2, bbox: { x0: 0, x1: 1, y0: 0, y1: 1 }, length: 1, amp: 0 }).uy)).toEqual([0, 0, 0]);
  });
});

describe('OpenFOAM の出力を読む', () => {
  it('parseInternalField: uniform / nonuniform のスカラーとベクトル', () => {
    expect(parseInternalField('internalField   uniform 0;', 3).data).toEqual(new Float64Array([0, 0, 0]));
    const uni = parseInternalField('internalField   uniform (1 2 3);', 2);
    expect(uni.size).toBe(3);
    expect(Array.from(uni.data)).toEqual([1, 2, 3, 1, 2, 3]);
    const sc = parseInternalField('x\ninternalField   nonuniform List<scalar> \n3\n(\n1.5\n-2e-3\n4\n)\n;\nboundaryField{}', 3);
    expect(Array.from(sc.data)).toEqual([1.5, -0.002, 4]);
    const vec = parseInternalField('internalField   nonuniform List<vector> \n2\n(\n(1 2 0)\n(-3.5e-1 4 0)\n)\n;', 2);
    expect(vec.size).toBe(3);
    expect(Array.from(vec.data)).toEqual([1, 2, 0, -0.35, 4, 0]);
    expect(parseInternalField('internalField nonuniform List<scalar> 0();', 0).n).toBe(0);
    expect(() => parseInternalField('nothing', 1)).toThrow('internalField');
    expect(() => parseInternalField('internalField nonuniform List<scalar> 3(1 2);', 3)).toThrow('足りません');
  });

  it('書いたリストを読み戻せる', () => {
    const v = parseInternalField(`internalField ${vectorListLiteral([1, 2.5], [-1, 0.125])};`, 2);
    expect(Array.from(v.data)).toEqual([1, -1, 0, 2.5, 0.125, 0]);
    const s = parseInternalField(`internalField ${scalarListLiteral([0, 7, 12345])};`, 3);
    expect(Array.from(s.data)).toEqual([0, 7, 12345]);
  });

  it('parseTimeLine: Time = の行だけ。単位 s 付きも読む', () => {
    expect(parseTimeLine('Time = 0.0123')).toBeCloseTo(0.0123);
    expect(parseTimeLine('Time = 15')).toBe(15);
    expect(parseTimeLine('Time = 0.5s')).toBe(0.5);
    expect(parseTimeLine('ExecutionTime = 3 s  ClockTime = 3 s')).toBeNull();
    expect(parseTimeLine('Courant Number mean: 0.2 max: 0.3')).toBeNull();
  });

  it('parseSolverLog: 最後の時刻・クーラン数・収束・致命的エラー', () => {
    const ok = parseSolverLog(
      'trapFpe: Floating point exception trapping enabled (FOAM_SIGFPE).\nTime = 1\nCourant Number mean: 0.1 max: 0.4\nTime = 2\nCourant Number mean: 0.1 max: 0.6\nSIMPLE solution converged in 812 iterations\n',
    );
    expect(ok.lastTime).toBe(2);
    expect(ok.courantMax).toBeCloseTo(0.6);
    expect(ok.convergedAt).toBe(812);
    expect(ok.diverged).toBe(false); // 起動時のヘッダは発散ではない
    expect(ok.fatal).toBeNull();
    const bad = parseSolverLog('Time = 3\n#0  Foam::sigFpe::sigHandler(int)\n--> FOAM FATAL ERROR: \ncannot find file "x/fvSchemes"\n');
    expect(bad.diverged).toBe(true);
    expect(bad.fatal).toContain('cannot find file');
  });
});

describe('物体にかかる力', () => {
  // 3 × 3 の中央が物体。流体は 8 セル（OpenFOAM の順 = ラスターの昇順）
  const dom = prepareDomain(smallRaster(['...', '.#.', '...']));
  const cellToRaster = mapCellsSorted(dom);
  const faces = collectBodyFaces({ cellToRaster, solid: dom.solid, nx: 3, ny: 3 });
  const idx = (r: number): number => Array.from(cellToRaster).indexOf(r); // ラスター番号 → OpenFOAM のセル
  const left = idx(3), right = idx(5), bottom = idx(1), top = idx(7);
  const scalar = (set: Record<number, number>) => {
    const data = new Float64Array(8);
    for (const [c, v] of Object.entries(set)) data[Number(c)] = v;
    return { size: 1 as const, n: 8, data };
  };
  const vector = (set: Record<number, [number, number]>) => {
    const data = new Float64Array(24);
    for (const [c, [x, y]] of Object.entries(set)) {
      data[3 * Number(c)] = x;
      data[3 * Number(c) + 1] = y;
    }
    return { size: 3 as const, n: 8, data };
  };

  it('collectBodyFaces: 物体の 4 面を拾う（法線は物体から流体へ）', () => {
    expect(faces.cell).toHaveLength(4);
    const byCell = new Map(Array.from(faces.cell).map((c, k) => [c, [faces.nx[k], faces.ny[k]]]));
    expect(byCell.get(left)).toEqual([-1, 0]);
    expect(byCell.get(right)).toEqual([1, 0]);
    expect(byCell.get(bottom)).toEqual([0, -1]);
    expect(byCell.get(top)).toEqual([0, 1]);
  });

  it('圧力: 前面 2・背面 1 なら (2 − 1) ρ h² の抗力、上下が釣り合えば揚力 0、一様圧力では 0', () => {
    const f = bodyForce({ faces, h: 0.1, rho: 1.2, nu: 0, U: vector({}), p: scalar({ [left]: 2, [right]: 1, [top]: 3, [bottom]: 3 }) });
    expect(f.fx).toBeCloseTo(1.2 * 0.01, 12);
    expect(f.fy).toBeCloseTo(0, 12);
    const up = bodyForce({ faces, h: 0.1, rho: 1, nu: 0, U: vector({}), p: scalar({ [top]: 0.5, [bottom]: 2 }) });
    expect(up.fy).toBeCloseTo(-0.5 * 0.01 + 2 * 0.01, 12); // 下面の高い圧力が押し上げる
    const flat = bodyForce({ faces, h: 0.1, rho: 1.2, nu: 0, U: vector({}), p: scalar({ [left]: 5, [right]: 5, [top]: 5, [bottom]: 5 }) });
    expect(flat.fx).toBeCloseTo(0, 12);
    expect(flat.fy).toBeCloseTo(0, 12);
  });

  it('摩擦: 壁に沿った速度に引きずられる（接線成分だけ）', () => {
    // 上の面の流体が +x に 1 m/s、左の面の流体が (1, 0.5)。接線は上面で x、左面で y
    const f = bodyForce({ faces, h: 0.1, rho: 1, nu: 0.01, U: vector({ [top]: [1, 0.2], [left]: [1, 0.5] }), p: scalar({}) });
    const shear = (0.01 * 0.01) / 0.05; // μ A / (h/2)
    expect(f.fx).toBeCloseTo(shear * 1, 12);
    expect(f.fy).toBeCloseTo(shear * 0.5, 12);
  });

  it('渦粘性を足すと摩擦が増える', () => {
    const base = { faces, h: 0.1, rho: 1, nu: 0.01, U: vector({ [top]: [1, 0] }), p: scalar({}) };
    const nut = scalar({ [top]: 0.01 });
    expect(bodyForce({ ...base, nut }).fx).toBeCloseTo(2 * bodyForce(base).fx, 12);
  });
});

describe('結果の組み立て', () => {
  it('estimateStrouhal: 正弦波の揚力から St = f L / U', () => {
    const t = Array.from({ length: 400 }, (_, k) => k * 0.05);
    const f = 0.4; // Hz
    const lift = t.map((x) => 0.3 * Math.sin(2 * Math.PI * f * x + 0.3));
    const st = estimateStrouhal({ t, lift, qa: 1, length: 0.1, uInf: 0.2 });
    expect(st).toBeCloseTo((f * 0.1) / 0.2, 2);
    // 振れが小さい・定常なら null
    expect(estimateStrouhal({ t, lift: t.map(() => 0.001), qa: 1, length: 0.1, uInf: 0.2 })).toBeNull();
    expect(estimateStrouhal({ t: t.slice(0, 10), lift: lift.slice(0, 10), qa: 1, length: 0.1, uInf: 0.2 })).toBeNull();
  });

  it('buildFlowResult: Lite と同じキー・マスク・単位換算・渦度・履歴の間引き', () => {
    // 3 × 2 のラスター。右下(2,0)が物体
    const nx = 3, ny = 2, h = 0.1;
    const cellToRaster = Int32Array.from([0, 1, 3, 4, 5]);
    const U = { size: 3 as const, n: 5, data: Float64Array.from([1, 0, 0, 1, 0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0]) };
    const p = { size: 1 as const, n: 5, data: Float64Array.from([0.5, 0, 0, 0, -1]) };
    const t = Array.from({ length: 5000 }, (_, k) => k);
    const res = buildFlowResult({
      nx, ny, h, cellToRaster, U, p, rho: 2, nu: 1e-5, uInf: 1, length: 0.1, thickness: 0.02, meshDepth: 0.1,
      forces: { t, fx: t.map(() => 0.5), fy: t.map(() => -0.25) },
      model: 'laminar', endTime: 4999, solver: 'pimpleFoam', warnings: ['確認用の注意'],
    });
    expect(res.analysis).toBe('flow');
    expect(res.fields.map((f) => f.key)).toEqual(['speed', 'ux', 'uy', 'pressure', 'vorticity']);
    expect(res.fields.find((f) => f.key === 'pressure')!.diverging).toBe(true);
    expect(res.fields.find((f) => f.key === 'vorticity')!.diverging).toBe(true);
    const mask = res.fields[0].mask!;
    expect(Array.from(mask)).toEqual([1, 1, 0, 1, 1, 1]);
    expect(res.fields[3].data[0]).toBeCloseTo(1); // 0.5 × ρ(2)
    expect(res.fields[3].data[5]).toBeCloseTo(-2);
    // 渦度: セル (1,1)=index 4 は dux/dy = (ux[上]=無し→自分, 下=ux[1]=1) 片側差分 …符号が負（下の流れが遅い）
    expect(res.fields[4].data[4]).toBeLessThan(0);
    // 力は厚さ 0.02 / 0.1 = 0.2 倍
    const sc = (k: string) => res.scalars.find((s) => s.key === k)!.value;
    expect(sc('drag')).toBeCloseTo(0.1);
    expect(sc('lift')).toBeCloseTo(-0.05);
    expect(sc('Re')).toBeCloseTo(1e4);
    expect(sc('Cd')).toBeCloseTo(0.1 / (0.5 * 2 * 1 * 0.1 * 0.02)); // 50
    for (const k of ['Re', 'drag', 'lift', 'Cd', 'Cl', 'time']) expect(sc(k)).toBeDefined();
    expect(res.history.map((x) => x.key)).toEqual(['drag', 'lift']);
    expect(res.history[0].t.length).toBeLessThanOrEqual(2000);
    expect(res.history[0].t[res.history[0].t.length - 1]).toBe(4999);
    expect(res.warnings[0]).toBe('OpenFOAM（pimpleFoam、層流）で解きました（格子 3 × 2）。');
    expect(res.warnings).toContain('確認用の注意');
    expect(res.warnings.some((w) => w.includes('2D'))).toBe(true);
  });

  it('buildFlowResult: 結果のセル数が合わなければ例外', () => {
    const f = { size: 1 as const, n: 1, data: new Float64Array(1) };
    expect(() =>
      buildFlowResult({
        nx: 2, ny: 1, h: 1, cellToRaster: Int32Array.from([0, 1]), U: { size: 3, n: 1, data: new Float64Array(3) }, p: f,
        rho: 1, nu: 1, uInf: 1, length: 1, thickness: 1, meshDepth: 1, forces: { t: [], fx: [], fy: [] }, model: 'rans', endTime: 1, solver: 'simpleFoam',
      }),
    ).toThrow('セル数');
  });

  it('LES / RANS では注意書きを足す', () => {
    const base = { nx: 1, ny: 1, h: 1, cellToRaster: Int32Array.from([0]), U: { size: 3 as const, n: 1, data: new Float64Array(3) }, p: { size: 1 as const, n: 1, data: new Float64Array(1) }, rho: 1, nu: 1, uInf: 1, length: 1, thickness: 1, meshDepth: 1, forces: { t: [1], fx: [0], fy: [0] }, endTime: 1 };
    expect(buildFlowResult({ ...base, model: 'les', solver: 'pimpleFoam' }).warnings.join()).toContain('定性的');
    const r = buildFlowResult({ ...base, model: 'rans', solver: 'simpleFoam' });
    expect(r.warnings.join()).toContain('定常の RANS');
    expect(r.scalars.find((s) => s.key === 'strouhal')).toBeUndefined();
  });
});

describe('計画（plan）', () => {
  const cylinder = (over: Partial<ReturnType<typeof defaultProject>['flow']> = {}) => {
    const p = defaultProject();
    p.domain = { width: 1, height: 0.5, nx: 100, autoGrid: false };
    p.flow = { fluidId: 'air', inletVelocity: 0.1, walls: 'slip', ...over };
    p.shapes = [{ id: 'c', name: '円柱', role: 'solid', materialId: 'abs', geom: { kind: 'circle', cx: 0.25, cy: 0.25, r: 0.05 } }];
    return p;
  };
  const req = (project: ReturnType<typeof defaultProject>, extra: Partial<JobRequest> = {}): JobRequest => ({ analysis: 'flow', engine: 'openfoam', project, ...extra });

  it('pickModel: Re で層流 / LES / RANS を選ぶ', () => {
    expect(pickModel(100)).toBe('laminar');
    expect(pickModel(999)).toBe('laminar');
    expect(pickModel(1000)).toBe('les');
    expect(pickModel(19_999)).toBe('les');
    expect(pickModel(20_000)).toBe('rans');
  });

  it('readOptions: 既定値と範囲', () => {
    expect(readOptions(undefined)).toEqual({ model: 'auto', flowThroughs: 4, turbulenceIntensity: 1 });
    expect(readOptions({ model: 'rans', flowThroughs: 1000, turbulenceIntensity: 0 })).toEqual({ model: 'rans', flowThroughs: 100, turbulenceIntensity: 0.05 });
    expect(readOptions({ model: 'nonsense' }).model).toBe('auto');
  });

  it('scaleNx: 品質で細かくし、セル数の上限で止める', () => {
    const p = cylinder();
    expect(scaleNx(p, 100, 'draft')).toEqual({ nx: 100, capped: false });
    expect(scaleNx(p, 100, 'standard').nx).toBe(150);
    expect(scaleNx(p, 100, 'fine').nx).toBe(200);
    const big = scaleNx(p, 600, 'fine');
    expect(big.capped).toBe(true);
    expect(big.nx * Math.round(0.5 / (1 / big.nx))).toBeLessThanOrEqual(300_000);
  });

  it('snapshotCount: 回数に比例し、セルが多いと減る', () => {
    expect(snapshotCount(4, 10_000)).toBe(160);
    expect(snapshotCount(100, 10_000)).toBe(400);
    expect(snapshotCount(4, 300_000)).toBe(20);
  });

  it('planJob: 層流（Re = 100）の時間・刻み・メッシュ', () => {
    // L = 直径 10 セル = 0.1 m、Re = 100 → U = 100 ν / L
    const nu = 1.516e-5;
    const plan = planJob(req(cylinder({ inletVelocity: (100 * nu) / 0.1 })));
    expect(plan.spec.model).toBe('laminar');
    expect(plan.solver).toBe('pimpleFoam');
    expect(plan.raster.nx).toBe(100);
    expect(plan.domain.length).toBeCloseTo(0.1, 2);
    const U = plan.spec.uInf;
    expect(plan.spec.endTime).toBeCloseTo((4 * 1) / U, 6); // 4 回 × 幅 / U
    expect(plan.spec.deltaT).toBeCloseTo((0.2 * 0.01) / U, 9);
    expect(plan.spec.maxCo).toBeGreaterThanOrEqual(0.5);
    expect(plan.spec.maxCo).toBeLessThanOrEqual(0.8);
    expect(plan.rho).toBeCloseTo(1.204);
  });

  it('planJob: 高 Re は自動で RANS（反復回数 = 回数 × nx）、指定が優先される', () => {
    const fast = cylinder({ inletVelocity: 5 }); // Re ≈ 3 万
    const auto = planJob(req(fast));
    expect(auto.spec.model).toBe('rans');
    expect(auto.solver).toBe('simpleFoam');
    expect(auto.spec.endTime).toBe(400);
    expect(planJob(req(fast, { options: { model: 'laminar' } })).spec.model).toBe('laminar');
    expect(planJob(req(fast, { options: { model: 'les' } })).solver).toBe('pimpleFoam');
    expect(planJob(req(fast, { options: { turbulenceIntensity: 5 } })).spec.intensity).toBeCloseTo(0.05);
  });

  it('planJob: 品質 fine は格子が 2 倍で、その旨の注意が付く', () => {
    const plan = planJob(req(cylinder(), { quality: 'fine' }));
    expect(plan.raster.nx).toBe(200);
    expect(plan.notes.join()).toContain('200 × 100');
  });

  it('planJob: 流入速度 0・物体なしは日本語の例外', () => {
    expect(() => planJob(req(cylinder({ inletVelocity: 0 })))).toThrow('流入速度');
    const empty = cylinder();
    empty.shapes = [];
    expect(() => planJob(req(empty))).toThrow('物体');
  });

  it('planJob: 負の流入速度は大きさを使い、注意を出す', () => {
    const plan = planJob(req(cylinder({ inletVelocity: -0.1 })));
    expect(plan.spec.uInf).toBeCloseTo(0.1);
    expect(plan.notes.join()).toContain('負');
  });
});

describe('アダプターの宣言と detect', () => {
  it('id・Docker イメージ・能力', () => {
    expect(openfoamAdapter.id).toBe('openfoam');
    expect(openfoamAdapter.dockerImage).toBe('opencfd/openfoam-default:2406');
    expect(openfoamAdapter.capabilities).toHaveLength(1);
    const cap = openfoamAdapter.capabilities[0];
    expect(cap).toMatchObject({ analysis: 'flow', engine: 'openfoam', label: 'OpenFOAM で本計算' });
    expect(cap.options!.map((o) => o.key)).toEqual(['model', 'flowThroughs', 'turbulenceIntensity']);
    const model = cap.options![0];
    expect(model.choices!.map((c) => c.value)).toEqual(['auto', 'laminar', 'les', 'rans']);
    expect(model.default).toBe('auto');
  });

  it('parseOpenFoamVersion', () => {
    expect(parseOpenFoamVersion('Using: OpenFOAM- (1912) - visit www.openfoam.com')).toBe('v1912');
    expect(parseOpenFoamVersion('Using: OpenFOAM-v2406 (2406) - visit www.openfoam.com')).toBe('v2406');
    expect(parseOpenFoamVersion('Build  : OPENFOAM=1912 patch=200626')).toBe('v1912');
    expect(parseOpenFoamVersion('command not found')).toBeUndefined();
  });

  const ctxOf = (out: { ok: boolean; output: string }, docker = false): DetectContext => ({ dockerAvailable: docker, probe: async () => out });

  it('detect: 直接入っている・環境が未設定・Docker のみ・どちらもなし', async () => {
    const ok = await openfoamAdapter.detect(ctxOf({ ok: true, output: 'Using: OpenFOAM- (1912) - visit www.openfoam.com' }));
    expect(ok).toMatchObject({ id: 'openfoam', available: true, via: 'native', version: 'v1912', license: 'GPL-3.0' });
    const env = await openfoamAdapter.detect(ctxOf({ ok: false, output: "Could not find mandatory etc entry (mode=ugo) 'controlDict'" }));
    expect(env.available).toBe(false);
    expect(env.note).toContain('WM_PROJECT_DIR');
    const docker = await openfoamAdapter.detect(ctxOf({ ok: false, output: 'not found' }, true));
    expect(docker).toMatchObject({ available: true, via: 'docker' });
    expect(docker.note).toContain('opencfd/openfoam-default');
    const none = await openfoamAdapter.detect(ctxOf({ ok: false, output: 'not found' }));
    expect(none).toMatchObject({ available: false, via: 'none' });
    expect(none.note).toContain('Docker');
    expect(none.note).toContain('WSL');
  });

  it('solve: flow 以外は日本語の例外', async () => {
    const project = defaultProject();
    await expect(openfoamAdapter.solve({ analysis: 'heat', engine: 'openfoam', project }, {} as never)).rejects.toThrow('flow');
  });
});
