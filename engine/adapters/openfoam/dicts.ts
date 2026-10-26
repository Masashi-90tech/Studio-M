// OpenFOAM の辞書ファイル（case の system/・constant/・0/）を文字列で作る純粋な関数。
//
// 互換性: Debian/Ubuntu の openfoam（v1912）と Docker の opencfd/openfoam-default:2406 の
// どちらでも読める書き方だけを使う。
//   - blockMeshDict は `scale`（convertToMeters は v1912 で警告が出る）
//   - 乱流は constant/turbulenceProperties（ESI 版の名前）
//   - 関数オブジェクトは `libs ("libforces.so")`
//   - 離散化は linear / linearUpwind / LUST / upwind / limitedLinear など、どの版にもある名前だけ
// 版ごとの細かい差に頼らない（新しい書き方を足すときは両方で動くことを確かめる）。

export type FlowModel = 'laminar' | 'les' | 'rans';

/** 辞書を作るのに必要な値 */
export interface CaseSpec {
  model: FlowModel;
  /** 流入速度の大きさ [m/s] */
  uInf: number;
  /** 動粘性係数 [m²/s] */
  nu: number;
  /** 密度 [kg/m³]（力を N に直すのに使う） */
  rho: number;
  walls: 'slip' | 'noslip';
  /** 代表長さ L [m] */
  length: number;
  /** 終了時刻 [s]（RANS は反復回数） */
  endTime: number;
  /** 最初の時間刻み [s]（RANS は 1） */
  deltaT: number;
  /** 時間刻みの上限 [s] */
  maxDeltaT: number;
  /** 目標クーラン数 */
  maxCo: number;
  /** 流入の乱流強度（0.01 = 1%） */
  intensity: number;
  /** 途中経過として書き出す回数（力の時間変化をここから計算する） */
  snapshots: number;
  /** RANS の収束判定を使うか */
  residualControl: boolean;
}

/** 数値を OpenFOAM に渡す文字列にする（指数表記も可） */
export function num(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`辞書に書けない数値です: ${v}`);
  return Number(v.toPrecision(12)).toString().replace('e+', 'e');
}

/** FoamFile ヘッダ付きの辞書にする */
export function foamFile(cls: string, object: string, body: string, location?: string): string {
  const loc = location ? `    location    "${location}";\n` : '';
  return (
    `FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       ${cls};\n${loc}    object      ${object};\n}\n` +
    `// Studio M Engine が作った辞書（v1912 / v2406 の両方で読める書き方）\n\n${body.trim()}\n`
  );
}

// ---------- system/ ----------

export function blockMeshDict(opts: { nx: number; ny: number; h: number; walls: 'slip' | 'noslip' }): string {
  const { nx, ny, h } = opts;
  // 上下の境界: slip = symmetryPlane、noslip = wall
  const side = opts.walls === 'slip' ? 'symmetryPlane' : 'wall';
  const w = num(nx * h);
  const hh = num(ny * h);
  const t = num(h); // 奥行き（z）は 1 セル = h
  const body = `
scale 1;

vertices
(
    (0 0 0)
    (${w} 0 0)
    (${w} ${hh} 0)
    (0 ${hh} 0)
    (0 0 ${t})
    (${w} 0 ${t})
    (${w} ${hh} ${t})
    (0 ${hh} ${t})
);

blocks
(
    hex (0 1 2 3 4 5 6 7) (${nx} ${ny} 1) simpleGrading (1 1 1)
);

edges ();

boundary
(
    inlet
    {
        type patch;
        faces ((0 4 7 3));
    }
    outlet
    {
        type patch;
        faces ((1 2 6 5));
    }
    bottom
    {
        type ${side};
        faces ((0 1 5 4));
    }
    top
    {
        type ${side};
        faces ((3 7 6 2));
    }
    frontAndBack
    {
        type empty;
        faces ((0 3 2 1) (4 5 6 7));
    }
);

mergePatchPairs ();`;
  return foamFile('dictionary', 'blockMeshDict', body);
}

/**
 * topoSetDict: 物体のセル（ラスターの番号 = blockMesh のセル番号）から固体の cellSet を作り、
 * 反転して流体の cellSet `fluidCells` にする。
 */
export function topoSetDict(solidCells: ArrayLike<number>): string {
  const rows: string[] = [];
  for (let i = 0; i < solidCells.length; i += 20) {
    rows.push('            ' + Array.from({ length: Math.min(20, solidCells.length - i) }, (_, k) => solidCells[i + k]).join(' '));
  }
  const body = `
actions
(
    {
        name    fluidCells;
        type    cellSet;
        action  new;
        source  labelToCell;
        sourceInfo
        {
            value
            (
${rows.join('\n')}
            );
        }
    }
    {
        name    fluidCells;
        type    cellSet;
        action  invert;
    }
);`;
  return foamFile('dictionary', 'topoSetDict', body);
}

/**
 * controlDict。functionObject（forces など）は使わない: Debian/Ubuntu の v1912 では、functions を
 * 含む辞書の読み込みが「sha1」の入出力エラーで落ちるため。力は書き出した場（U・p）から Studio M 側で求める。
 */
export function controlDict(spec: CaseSpec): string {
  const rans = spec.model === 'rans';
  const solver = rans ? 'simpleFoam' : 'pimpleFoam';
  const interval = rans ? Math.max(1, Math.round(spec.endTime / spec.snapshots)) : spec.endTime / spec.snapshots;
  const time = rans
    ? `deltaT          1;\nwriteControl    timeStep;\nwriteInterval   ${interval};`
    : `deltaT          ${num(spec.deltaT)};\nadjustTimeStep  yes;\nmaxCo           ${num(spec.maxCo)};\nmaxDeltaT       ${num(spec.maxDeltaT)};\nwriteControl    adjustableRunTime;\nwriteInterval   ${num(interval)};`;
  const body = `
application     ${solver};
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         ${num(spec.endTime)};
${time}
purgeWrite      0;
writeFormat     ascii;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   8;
runTimeModifiable no;`;
  return foamFile('dictionary', 'controlDict', body);
}

export function fvSchemes(spec: CaseSpec): string {
  const steady = spec.model === 'rans';
  const ddt = steady ? 'steadyState' : 'backward';
  // 層流は線形風上（2 次精度で振動しにくい）、LES は低散逸の LUST、RANS は有界化した線形風上
  const convU = steady ? 'bounded Gauss linearUpwind grad(U)' : spec.model === 'les' ? 'Gauss LUST grad(U)' : 'Gauss linearUpwind grad(U)';
  const convT = steady ? 'bounded Gauss limitedLinear 1' : 'Gauss limitedLinear 1';
  const body = `
ddtSchemes
{
    default         ${ddt};
}

gradSchemes
{
    default         Gauss linear;
}

divSchemes
{
    default         none;
    div(phi,U)      ${convU};
    div(phi,k)      ${convT};
    div(phi,omega)  ${convT};
    div((nuEff*dev2(T(grad(U)))))   Gauss linear;
    div((nu*dev2(T(grad(U)))))      Gauss linear;
}

laplacianSchemes
{
    default         Gauss linear corrected;
}

interpolationSchemes
{
    default         linear;
}

snGradSchemes
{
    default         corrected;
}

wallDist
{
    method          meshWave;
}`;
  return foamFile('dictionary', 'fvSchemes', body);
}

export function fvSolution(spec: CaseSpec): string {
  if (spec.model === 'rans') {
    const res = spec.residualControl
      ? `    residualControl\n    {\n        p               1e-4;\n        U               1e-4;\n        "(k|omega)"     1e-4;\n    }\n`
      : '';
    return foamFile(
      'dictionary',
      'fvSolution',
      `
solvers
{
    p
    {
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-8;
        relTol          0.1;
    }
    "(U|k|omega)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-9;
        relTol          0.1;
    }
}

SIMPLE
{
    nNonOrthogonalCorrectors 0;
    consistent      yes;
${res}}

relaxationFactors
{
    equations
    {
        U               0.9;
        ".*"            0.9;
    }
}`,
    );
  }
  return foamFile(
    'dictionary',
    'fvSolution',
    `
solvers
{
    p
    {
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-7;
        relTol          0.02;
    }
    pFinal
    {
        $p;
        relTol          0;
    }
    "(U|k|omega)"
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-9;
        relTol          0;
    }
    "(U|k|omega)Final"
    {
        $U;
        relTol          0;
    }
}

PIMPLE
{
    nOuterCorrectors 1;
    nCorrectors     2;
    nNonOrthogonalCorrectors 0;
}`,
  );
}

export function transportProperties(spec: CaseSpec): string {
  return foamFile('dictionary', 'transportProperties', `transportModel  Newtonian;\nnu              ${num(spec.nu)};`);
}

export function turbulenceProperties(spec: CaseSpec): string {
  if (spec.model === 'laminar') return foamFile('dictionary', 'turbulenceProperties', 'simulationType  laminar;');
  if (spec.model === 'les') {
    return foamFile(
      'dictionary',
      'turbulenceProperties',
      `
simulationType  LES;

LES
{
    LESModel        Smagorinsky;
    turbulence      on;
    printCoeffs     on;
    delta           cubeRootVol;
    cubeRootVolCoeffs
    {
        deltaCoeff      1;
    }
}`,
    );
  }
  return foamFile(
    'dictionary',
    'turbulenceProperties',
    `
simulationType  RAS;

RAS
{
    RASModel        kOmegaSST;
    turbulence      on;
    printCoeffs     on;
}`,
  );
}
