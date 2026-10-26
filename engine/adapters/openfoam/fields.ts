// 初期条件・境界条件（0/ の各ファイル）を文字列で作る純粋な関数。書き方の互換性は dicts.ts の冒頭を参照。

import { type CaseSpec, foamFile, num } from './dicts';

// ---------- 0/（境界条件）。internalField は呼び出し側が渡す ----------

/** RANS の流入の乱れ: k = 1.5 (I U)²、ω = √k / (Cμ^0.25 · l)、l = 0.07 L */
export function turbulenceInlet(spec: CaseSpec): { k: number; omega: number } {
  const k = 1.5 * (spec.intensity * spec.uInf) ** 2;
  const l = 0.07 * spec.length;
  const omega = Math.sqrt(k) / (Math.pow(0.09, 0.25) * l);
  return { k: Math.max(k, 1e-12), omega: Math.max(omega, 1e-9) };
}

function patchList(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([name, body]) => `    ${name}\n    {\n${body
      .split('\n')
      .map((l) => '        ' + l)
      .join('\n')}\n    }`)
    .join('\n');
}

const SYMMETRY = 'type            symmetryPlane;';
const EMPTY = 'type            empty;';

/** U の境界。internal は `uniform (…)` か `nonuniform List<vector> N (…)` の文字列 */
export function fieldU(spec: CaseSpec, internal: string): string {
  const side = spec.walls === 'slip' ? SYMMETRY : 'type            fixedValue;\nvalue           uniform (0 0 0);';
  return foamFile(
    'volVectorField',
    'U',
    `
dimensions      [0 1 -1 0 0 0 0];

internalField   ${internal};

boundaryField
{
${patchList({
  inlet: `type            fixedValue;\nvalue           uniform (${num(spec.uInf)} 0 0);`,
  outlet: `type            inletOutlet;\ninletValue      uniform (0 0 0);\nvalue           uniform (${num(spec.uInf)} 0 0);`,
  top: side,
  bottom: side,
  obstacle: 'type            fixedValue;\nvalue           uniform (0 0 0);',
  frontAndBack: EMPTY,
})}
}`,
  );
}

export function fieldP(spec: CaseSpec): string {
  const side = spec.walls === 'slip' ? SYMMETRY : 'type            zeroGradient;';
  return foamFile(
    'volScalarField',
    'p',
    `
dimensions      [0 2 -2 0 0 0 0];

internalField   uniform 0;

boundaryField
{
${patchList({
  inlet: 'type            zeroGradient;',
  outlet: 'type            fixedValue;\nvalue           uniform 0;',
  top: side,
  bottom: side,
  obstacle: 'type            zeroGradient;',
  frontAndBack: EMPTY,
})}
}`,
  );
}

/** 渦粘性 nut（LES・RANS）。壁は Spalding の壁関数（y+ がどんな値でも使える） */
export function fieldNut(spec: CaseSpec): string {
  const wall = 'type            nutUSpaldingWallFunction;\nvalue           uniform 0;';
  const side = spec.walls === 'slip' ? SYMMETRY : wall;
  const calc = 'type            calculated;\nvalue           uniform 0;';
  return foamFile(
    'volScalarField',
    'nut',
    `
dimensions      [0 2 -1 0 0 0 0];

internalField   uniform 0;

boundaryField
{
${patchList({ inlet: calc, outlet: calc, top: side, bottom: side, obstacle: wall, frontAndBack: EMPTY })}
}`,
  );
}

export function fieldK(spec: CaseSpec): string {
  const { k } = turbulenceInlet(spec);
  const wall = `type            kqRWallFunction;\nvalue           uniform ${num(k)};`;
  const side = spec.walls === 'slip' ? SYMMETRY : wall;
  return foamFile(
    'volScalarField',
    'k',
    `
dimensions      [0 2 -2 0 0 0 0];

internalField   uniform ${num(k)};

boundaryField
{
${patchList({
  inlet: `type            fixedValue;\nvalue           uniform ${num(k)};`,
  outlet: `type            inletOutlet;\ninletValue      uniform ${num(k)};\nvalue           uniform ${num(k)};`,
  top: side,
  bottom: side,
  obstacle: wall,
  frontAndBack: EMPTY,
})}
}`,
  );
}

export function fieldOmega(spec: CaseSpec): string {
  const { omega } = turbulenceInlet(spec);
  const wall = `type            omegaWallFunction;\nvalue           uniform ${num(omega)};`;
  const side = spec.walls === 'slip' ? SYMMETRY : wall;
  return foamFile(
    'volScalarField',
    'omega',
    `
dimensions      [0 0 -1 0 0 0 0];

internalField   uniform ${num(omega)};

boundaryField
{
${patchList({
  inlet: `type            fixedValue;\nvalue           uniform ${num(omega)};`,
  outlet: `type            inletOutlet;\ninletValue      uniform ${num(omega)};\nvalue           uniform ${num(omega)};`,
  top: side,
  bottom: side,
  obstacle: wall,
  frontAndBack: EMPTY,
})}
}`,
  );
}

/**
 * subsetMesh が作った obstacle パッチ（type patch。inGroups も別の値になっている）を wall に直す。
 * boundary ファイルの文字列を受け取り、直したものを返す。
 */
export function makeObstacleWall(boundary: string): string {
  const re = /(\bobstacle\s*\{)([^}]*)(\})/;
  const m = re.exec(boundary);
  if (!m) throw new Error('boundary に obstacle パッチがありません（物体のセルが 1 つもないか、メッシュ作成に失敗しています）');
  let inner = m[2].replace(/\n?[ \t]*(type|inGroups)\s[^;]*;/g, '');
  inner = `\n        type            wall;\n        inGroups        1(wall);${inner}`;
  return boundary.replace(re, `${m[1]}${inner}${m[3]}`);
}

/**
 * セル番号の場。subsetMesh が場も一緒に部分メッシュへ移すことを使い、「部分メッシュの i 番目のセルが
 * 元の何番か」を OpenFOAM 自身に教えてもらう（v1912 の subsetMesh は cellMap を書かないため）。
 * 値は元のセル番号 = ラスターの番号。internal は `nonuniform List<scalar> N (…)`
 */
export function fieldCellId(spec: CaseSpec, internal: string): string {
  const side = spec.walls === 'slip' ? SYMMETRY : 'type            zeroGradient;';
  const zg = 'type            zeroGradient;';
  return foamFile(
    'volScalarField',
    'cellId',
    `
dimensions      [0 0 0 0 0 0 0];

internalField   ${internal};

boundaryField
{
${patchList({ inlet: zg, outlet: zg, top: side, bottom: side, frontAndBack: EMPTY })}
}`,
  );
}
