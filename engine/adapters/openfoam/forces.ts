// 物体にかかる力を、書き出した場（U・p）から求める。
//
// OpenFOAM の forces 関数オブジェクトと同じ考え方を、階段状の物体表面に直したもの:
//   圧力: 面に隣り合う流体セルの p をそのまま面の値とする（zeroGradient の壁と同じ）
//   摩擦: 壁（速度 0）からセル中心まで h/2 なので、せん断応力 = ρ (ν + νt) U_接線 / (h/2)
// 力はメッシュの奥行き（= h）分の値。project.thickness 分への換算は results.ts で行う。

import type { FoamField } from './foamio';

export interface ForceSeries {
  /** 時刻 [s]（定常解法では反復回数） */
  t: number[];
  /** 合力 x・y [N]（メッシュの奥行き分） */
  fx: number[];
  fy: number[];
}

export interface BodyFaces {
  /** 面の隣の流体セル（OpenFOAM のセル番号） */
  cell: Int32Array;
  /** 面の法線（物体から流体へ向かう向き）の x・y 成分（±1 か 0） */
  nx: Int8Array;
  ny: Int8Array;
}

/** 物体（固体セル）に接する流体セルの面を集める */
export function collectBodyFaces(opts: { cellToRaster: Int32Array; solid: Uint8Array; nx: number; ny: number }): BodyFaces {
  const { cellToRaster, solid, nx, ny } = opts;
  const cell: number[] = [];
  const fx: number[] = [];
  const fy: number[] = [];
  const add = (c: number, dx: number, dy: number): void => {
    cell.push(c);
    fx.push(dx);
    fy.push(dy);
  };
  for (let c = 0; c < cellToRaster.length; c++) {
    const r = cellToRaster[c];
    const i = r % nx;
    const j = (r - i) / nx;
    if (i > 0 && solid[r - 1]) add(c, 1, 0); // 左隣が物体 → 物体の右面（法線 +x）
    if (i < nx - 1 && solid[r + 1]) add(c, -1, 0);
    if (j > 0 && solid[r - nx]) add(c, 0, 1);
    if (j < ny - 1 && solid[r + nx]) add(c, 0, -1);
  }
  return { cell: Int32Array.from(cell), nx: Int8Array.from(fx), ny: Int8Array.from(fy) };
}

/**
 * 物体にかかる力 [N]（メッシュの奥行き h 分）。
 * p は p/ρ [m²/s²]、nut は渦粘性 [m²/s]（層流なら省略）
 */
export function bodyForce(opts: {
  faces: BodyFaces;
  h: number;
  rho: number;
  nu: number;
  U: FoamField;
  p: FoamField;
  nut?: FoamField;
}): { fx: number; fy: number } {
  const { faces, h, rho, nu, U, p, nut } = opts;
  const area = h * h;
  let fx = 0;
  let fy = 0;
  for (let k = 0; k < faces.cell.length; k++) {
    const c = faces.cell[k];
    const nxk = faces.nx[k];
    const nyk = faces.ny[k];
    // 圧力: 物体の面は流体から押される（法線と逆向き）
    const pr = p.data[c] * rho * area;
    fx -= pr * nxk;
    fy -= pr * nyk;
    // 摩擦: 接線方向の速度に引きずられる
    const ux = U.data[3 * c];
    const uy = U.data[3 * c + 1];
    const un = ux * nxk + uy * nyk;
    const tx = ux - un * nxk;
    const ty = uy - un * nyk;
    const mu = rho * (nu + (nut ? nut.data[c] : 0));
    const shear = (mu * area) / (0.5 * h);
    fx += shear * tx;
    fy += shear * ty;
  }
  return { fx, fy };
}
