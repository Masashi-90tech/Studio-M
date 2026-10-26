// 3D メッシュのボクセル化（純粋関数。DOM に依存しない）。
//
// 1. voxelizeMesh: セルの中心が部品の中かどうか。x 方向の光線と三角形の交点の偶奇で判定する。
// 2. surfaceFaces: 外に出ている面（部品のセルと外のセルの境目）の一覧。
//    - 各面がどの三角形にいちばん近いか（Region3D.faces の条件を面に割り当てるのに使う）
//    - 面積の補正: 階段状の面の面積は本当の面積より大きい（球で約 1.5 倍）。
//      三角形の向き n から、面 1 枚の面積を h² / (|nx| + |ny| + |nz|) に直し（マンハッタンノルムの補正）、
//      さらに「同じ条件の三角形のまとまり」ごとに、面積の合計が三角形の本当の面積に一致するよう微調整する。
//
// 座標は m、格子は types.ts の Grid3D（セル (i, j, k) の番号は (k·ny + j)·nx + i）。

import type { Grid3D, Mesh3D } from './types';

/** 面の向き（外向き）。dir の番号 → 軸と符号 */
export const FACE_AXIS = [0, 0, 1, 1, 2, 2] as const;
export const FACE_SIGN = [-1, 1, -1, 1, -1, 1] as const;

/** 光線をセルの中心からずらす割合（辺・頂点にちょうど当たるのを避ける。中途半端な無理数にしてある） */
const RAY_SHIFT_Y = 1.7320508e-4;
const RAY_SHIFT_Z = 2.2360680e-4;

export interface VoxelizeResult {
  /** 1 = セルの中心が部品の中。長さ nx·ny·nz */
  inside: Uint8Array;
  /** 部品の中のセル数 */
  count: number;
  /** 薄くて消えた部分の数の目安: 光線が部品の中を通っているのに、セルの中心が 1 つも入らなかった区間の数（x 方向） */
  thinRays: number;
  /** 光線と三角形の交点が奇数個だった行の数（形が閉じていない・重なっているときに増える） */
  openRays: number;
  /** メッシュの体積 [m³]（向きを考えた符号つきの合計の絶対値） */
  meshVolume: number;
  /** メッシュの面の向きが内向きだったので反転して扱った */
  flipped: boolean;
}

/** 三角形ごとの面積 [m²] と、メッシュの符号つき体積 [m³] */
export function meshMetrics(mesh: Mesh3D): { triArea: Float64Array; area: number; signedVolume: number } {
  const { positions: p, indices: idx } = mesh;
  const nt = Math.floor(idx.length / 3);
  const triArea = new Float64Array(nt);
  let area = 0;
  let vol = 0;
  for (let t = 0; t < nt; t++) {
    const a = idx[3 * t] * 3;
    const b = idx[3 * t + 1] * 3;
    const c = idx[3 * t + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const ar = 0.5 * Math.hypot(nx, ny, nz);
    triArea[t] = ar;
    area += ar;
    // 原点からの四面体の体積（a · (b × c) / 6）
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return { triArea, area, signedVolume: vol };
}

/**
 * セルの中心が部品の中か。x 方向の光線（セルの中心の行ごと）と三角形の交点を並べ、2 つずつ組にして塗る。
 * 光線は行の中心からごくわずかにずらしてあるので、辺・頂点にちょうど当たる三角形の取りこぼし・二重数えは起きない。
 */
export function voxelizeMesh(mesh: Mesh3D, grid: Grid3D): VoxelizeResult {
  const { nx, ny, nz, h, origin } = grid;
  const n = nx * ny * nz;
  const inside = new Uint8Array(n);
  const { positions: p, indices: idx } = mesh;
  const nt = Math.floor(idx.length / 3);
  const rows = ny * nz;
  const shiftY = RAY_SHIFT_Y * h;
  const shiftZ = RAY_SHIFT_Z * h;
  const { signedVolume } = meshMetrics(mesh);

  // 1 回目: 行ごとの交点の数を数える。2 回目: 数えた場所に x を書く
  const start = new Int32Array(rows + 1);
  let xs = new Float64Array(0);
  const fillPos = new Int32Array(rows);

  const scan = (pass: 1 | 2): void => {
    for (let t = 0; t < nt; t++) {
      const a = idx[3 * t] * 3;
      const b = idx[3 * t + 1] * 3;
      const c = idx[3 * t + 2] * 3;
      const y0 = p[a + 1];
      const z0 = p[a + 2];
      const y1 = p[b + 1];
      const z1 = p[b + 2];
      const y2 = p[c + 1];
      const z2 = p[c + 2];
      const det = (y1 - y0) * (z2 - z0) - (z1 - z0) * (y2 - y0);
      if (det === 0 || !Number.isFinite(det)) continue; // x 軸に平行な三角形は交わらない
      const ymin = Math.min(y0, y1, y2);
      const ymax = Math.max(y0, y1, y2);
      const zmin = Math.min(z0, z1, z2);
      const zmax = Math.max(z0, z1, z2);
      const jLo = Math.max(0, Math.ceil((ymin - origin[1] - shiftY) / h - 0.5));
      const jHi = Math.min(ny - 1, Math.floor((ymax - origin[1] - shiftY) / h - 0.5));
      const kLo = Math.max(0, Math.ceil((zmin - origin[2] - shiftZ) / h - 0.5));
      const kHi = Math.min(nz - 1, Math.floor((zmax - origin[2] - shiftZ) / h - 0.5));
      if (jLo > jHi || kLo > kHi) continue;
      const x0 = p[a];
      const x1 = p[b];
      const x2 = p[c];
      for (let k = kLo; k <= kHi; k++) {
        const pz = origin[2] + (k + 0.5) * h + shiftZ;
        for (let j = jLo; j <= jHi; j++) {
          const py = origin[1] + (j + 0.5) * h + shiftY;
          const w0 = ((y1 - py) * (z2 - pz) - (z1 - pz) * (y2 - py)) / det;
          const w1 = ((y2 - py) * (z0 - pz) - (z2 - pz) * (y0 - py)) / det;
          const w2 = ((y0 - py) * (z1 - pz) - (z0 - pz) * (y1 - py)) / det;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const row = k * ny + j;
          if (pass === 1) start[row + 1]++;
          else xs[fillPos[row]++] = w0 * x0 + w1 * x1 + w2 * x2;
        }
      }
    }
  };

  scan(1);
  for (let r = 0; r < rows; r++) start[r + 1] += start[r];
  xs = new Float64Array(start[rows]);
  for (let r = 0; r < rows; r++) fillPos[r] = start[r];
  scan(2);

  let thinRays = 0;
  let openRays = 0;
  for (let row = 0; row < rows; row++) {
    const s = start[row];
    const e = start[row + 1];
    const m = e - s;
    if (m === 0) continue;
    if (m > 1) {
      if (m <= 24) {
        for (let a = s + 1; a < e; a++) {
          const v = xs[a];
          let b = a - 1;
          while (b >= s && xs[b] > v) {
            xs[b + 1] = xs[b];
            b--;
          }
          xs[b + 1] = v;
        }
      } else {
        xs.subarray(s, e).sort();
      }
    }
    if (m & 1) openRays++;
    const base = row * nx;
    for (let a = s; a + 1 < e; a += 2) {
      const i0 = Math.max(0, Math.ceil((xs[a] - origin[0]) / h - 0.5));
      const i1 = Math.min(nx, Math.ceil((xs[a + 1] - origin[0]) / h - 0.5));
      if (i0 >= i1) {
        if (xs[a + 1] > xs[a]) thinRays++;
        continue;
      }
      inside.fill(1, base + i0, base + i1);
    }
  }

  let count = 0;
  for (let c = 0; c < n; c++) count += inside[c];
  return { inside, count, thinRays, openRays, meshVolume: Math.abs(signedVolume), flipped: signedVolume < 0 };
}

export interface SurfaceFaces {
  /** 面の数 */
  count: number;
  /** 面を持つ部品側のセルの番号 */
  cell: Int32Array;
  /** 面の向き（外向き）: 0 = -x、1 = +x、2 = -y、3 = +y、4 = -z、5 = +z */
  dir: Uint8Array;
  /** いちばん近い三角形の番号（見つからなければ -1） */
  tri: Int32Array;
  /** 補正後の面積 [m²]（補正前は h²） */
  area: Float32Array;
  /** 補正前の面積の合計 h²·count [m²] */
  rawArea: number;
  /** 補正後の面積の合計 [m²] */
  correctedArea: number;
  /** 三角形の本当の面積の合計 [m²] */
  trueArea: number;
  /** グループごとの本当の面積・補正後の面積・最後にかけた倍率（groups を渡したとき。渡さなければ 1 グループ） */
  groupTrue: Float64Array;
  groupArea: Float64Array;
  groupScale: Float64Array;
  /** 重心のまわり（隣のセルまで）に外に出ている面が 1 つもない、面積が h² 以上の三角形の数（薄い部分が消えた目安） */
  lostTriangles: number;
}

export interface SurfaceFacesOptions {
  mesh: Mesh3D;
  grid: Grid3D;
  inside: Uint8Array;
  /** 三角形ごとのグループ番号（0 以上の整数）。グループごとに面積の合計を本当の面積にそろえる。省略時は全部 1 グループ */
  groups?: Int32Array;
  /** グループ数（groups の最大値 + 1）。groups を渡すときは必須 */
  groupCount?: number;
  /** メッシュの向きが内向き（voxelizeMesh の flipped） */
  flipped?: boolean;
}

/** 点 (px, py, pz) から三角形 (a, b, c) までの距離の 2 乗（Ericson, Real-Time Collision Detection） */
function pointTriDist2(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number;
  let qy: number;
  let qz: number;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax;
    qy = ay;
    qz = az;
  } else {
    const bpx = px - bx;
    const bpy = py - by;
    const bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
      qx = bx;
      qy = by;
      qz = bz;
    } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx;
        qy = ay + v * aby;
        qz = az + v * abz;
      } else {
        const cpx = px - cx;
        const cpy = py - cy;
        const cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) {
          qx = cx;
          qy = cy;
          qz = cz;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + w * acx;
            qy = ay + w * acy;
            qz = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              qx = bx + w * (cx - bx);
              qy = by + w * (cy - by);
              qz = bz + w * (cz - bz);
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom;
              const w = vc * denom;
              qx = ax + abx * v + acx * w;
              qy = ay + aby * v + acy * w;
              qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx;
  const dy = py - qy;
  const dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/** 補正の倍率として認める範囲（これを外れるときは、解析的な補正のままにする） */
const SCALE_MIN = 0.8;
const SCALE_MAX = 1.25;
/** 面の向きと三角形の向きが違うときの距離の罰則（セルの一辺の何倍まで）。薄い板の表と裏、辺をはさむ面の取り違えを減らす */
const NORMAL_PENALTY = 0.75;

/** 外に出ている面の一覧。最も近い三角形・補正後の面積つき */
export function surfaceFaces(opts: SurfaceFacesOptions): SurfaceFaces {
  const { mesh, grid, inside } = opts;
  const { nx, ny, nz, h, origin } = grid;
  const nxy = nx * ny;
  const { positions: p, indices: idx } = mesh;
  const nt = Math.floor(idx.length / 3);
  const groups = opts.groups;
  const gCount = groups ? Math.max(1, opts.groupCount ?? 1) : 1;

  // --- 面の一覧 ---
  let count = 0;
  const n = nx * ny * nz;
  for (let c = 0; c < n; c++) {
    if (!inside[c]) continue;
    const i = c % nx;
    const j = Math.floor(c / nx) % ny;
    const k = Math.floor(c / nxy);
    if (i === 0 || !inside[c - 1]) count++;
    if (i === nx - 1 || !inside[c + 1]) count++;
    if (j === 0 || !inside[c - nx]) count++;
    if (j === ny - 1 || !inside[c + nx]) count++;
    if (k === 0 || !inside[c - nxy]) count++;
    if (k === nz - 1 || !inside[c + nxy]) count++;
  }
  const cell = new Int32Array(count);
  const dir = new Uint8Array(count);
  const tri = new Int32Array(count).fill(-1);
  const area = new Float32Array(count);
  let f = 0;
  for (let c = 0; c < n; c++) {
    if (!inside[c]) continue;
    const i = c % nx;
    const j = Math.floor(c / nx) % ny;
    const k = Math.floor(c / nxy);
    if (i === 0 || !inside[c - 1]) (cell[f] = c), (dir[f++] = 0);
    if (i === nx - 1 || !inside[c + 1]) (cell[f] = c), (dir[f++] = 1);
    if (j === 0 || !inside[c - nx]) (cell[f] = c), (dir[f++] = 2);
    if (j === ny - 1 || !inside[c + nx]) (cell[f] = c), (dir[f++] = 3);
    if (k === 0 || !inside[c - nxy]) (cell[f] = c), (dir[f++] = 4);
    if (k === nz - 1 || !inside[c + nxy]) (cell[f] = c), (dir[f++] = 5);
  }

  // --- 三角形の準備（頂点・外接箱・単位法線・面積）---
  const tv = new Float64Array(nt * 9);
  const tn = new Float64Array(nt * 3);
  const tb = new Float64Array(nt * 6); // minx, miny, minz, maxx, maxy, maxz
  const triArea = new Float64Array(nt);
  const valid = new Uint8Array(nt);
  const sgn = opts.flipped ? -1 : 1;
  for (let t = 0; t < nt; t++) {
    for (let v = 0; v < 3; v++) {
      const q = idx[3 * t + v] * 3;
      tv[t * 9 + v * 3] = p[q];
      tv[t * 9 + v * 3 + 1] = p[q + 1];
      tv[t * 9 + v * 3 + 2] = p[q + 2];
    }
    const o = t * 9;
    const ux = tv[o + 3] - tv[o];
    const uy = tv[o + 4] - tv[o + 1];
    const uz = tv[o + 5] - tv[o + 2];
    const vx = tv[o + 6] - tv[o];
    const vy = tv[o + 7] - tv[o + 1];
    const vz = tv[o + 8] - tv[o + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const len = Math.hypot(cx, cy, cz);
    if (!(len > 0) || !Number.isFinite(len)) continue;
    valid[t] = 1;
    triArea[t] = 0.5 * len;
    tn[t * 3] = (sgn * cx) / len;
    tn[t * 3 + 1] = (sgn * cy) / len;
    tn[t * 3 + 2] = (sgn * cz) / len;
    for (let a = 0; a < 3; a++) {
      tb[t * 6 + a] = Math.min(tv[o + a], tv[o + 3 + a], tv[o + 6 + a]);
      tb[t * 6 + 3 + a] = Math.max(tv[o + a], tv[o + 3 + a], tv[o + 6 + a]);
    }
  }

  // --- 三角形の空間分割（セル 1 つ = 1 つの箱。三角形は外接箱が重なる箱すべてに入れる）---
  const binStart = new Int32Array(n + 1);
  const range = (t: number, out: number[]): boolean => {
    const i0 = Math.max(0, Math.floor((tb[t * 6] - origin[0]) / h));
    const j0 = Math.max(0, Math.floor((tb[t * 6 + 1] - origin[1]) / h));
    const k0 = Math.max(0, Math.floor((tb[t * 6 + 2] - origin[2]) / h));
    const i1 = Math.min(nx - 1, Math.floor((tb[t * 6 + 3] - origin[0]) / h));
    const j1 = Math.min(ny - 1, Math.floor((tb[t * 6 + 4] - origin[1]) / h));
    const k1 = Math.min(nz - 1, Math.floor((tb[t * 6 + 5] - origin[2]) / h));
    out[0] = i0;
    out[1] = j0;
    out[2] = k0;
    out[3] = i1;
    out[4] = j1;
    out[5] = k1;
    return i0 <= i1 && j0 <= j1 && k0 <= k1;
  };
  const r6 = [0, 0, 0, 0, 0, 0];
  for (let t = 0; t < nt; t++) {
    if (!valid[t] || !range(t, r6)) continue;
    for (let k = r6[2]; k <= r6[5]; k++)
      for (let j = r6[1]; j <= r6[4]; j++) for (let i = r6[0]; i <= r6[3]; i++) binStart[(k * ny + j) * nx + i + 1]++;
  }
  for (let c = 0; c < n; c++) binStart[c + 1] += binStart[c];
  const binItems = new Int32Array(binStart[n]);
  const binFill = binStart.slice(0, n);
  for (let t = 0; t < nt; t++) {
    if (!valid[t] || !range(t, r6)) continue;
    for (let k = r6[2]; k <= r6[5]; k++)
      for (let j = r6[1]; j <= r6[4]; j++) for (let i = r6[0]; i <= r6[3]; i++) binItems[binFill[(k * ny + j) * nx + i]++] = t;
  }

  // --- 面ごとに、いちばん近い三角形を探す（距離 + 向きの違いの罰則が最小のもの）---
  const maxRing = Math.max(nx, ny, nz);
  const hasFaces = binItems.length > 0;
  for (let fi = 0; fi < count && hasFaces; fi++) {
    const c = cell[fi];
    const d = dir[fi];
    const axis = FACE_AXIS[d];
    const sign = FACE_SIGN[d];
    const ci = c % nx;
    const cj = Math.floor(c / nx) % ny;
    const ck = Math.floor(c / nxy);
    // 面の中心
    let px = origin[0] + (ci + 0.5) * h;
    let py = origin[1] + (cj + 0.5) * h;
    let pz = origin[2] + (ck + 0.5) * h;
    if (axis === 0) px += sign * 0.5 * h;
    else if (axis === 1) py += sign * 0.5 * h;
    else pz += sign * 0.5 * h;
    // 面の中心が入っている箱（面の中心は箱の境目にあることが多いので、部品側のセルの箱からたどる）
    const bi = Math.min(nx - 1, Math.max(0, Math.floor((px - origin[0]) / h)));
    const bj = Math.min(ny - 1, Math.max(0, Math.floor((py - origin[1]) / h)));
    const bk = Math.min(nz - 1, Math.max(0, Math.floor((pz - origin[2]) / h)));
    let best = Infinity;
    let bestT = -1;
    for (let ring = 1; ring <= maxRing; ring++) {
      for (let dk = -ring; dk <= ring; dk++) {
        const kk = bk + dk;
        if (kk < 0 || kk >= nz) continue;
        for (let dj = -ring; dj <= ring; dj++) {
          const jj = bj + dj;
          if (jj < 0 || jj >= ny) continue;
          for (let di = -ring; di <= ring; di++) {
            const ii = bi + di;
            if (ii < 0 || ii >= nx) continue;
            // ring 1 は全部、ring 2 以上は外側の殻だけ
            if (ring > 1 && Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) < ring) continue;
            const b = (kk * ny + jj) * nx + ii;
            for (let s = binStart[b]; s < binStart[b + 1]; s++) {
              const t = binItems[s];
              const o6 = t * 6;
              const ex = Math.max(tb[o6] - px, 0, px - tb[o6 + 3]);
              const ey = Math.max(tb[o6 + 1] - py, 0, py - tb[o6 + 4]);
              const ez = Math.max(tb[o6 + 2] - pz, 0, pz - tb[o6 + 5]);
              const lower = Math.sqrt(ex * ex + ey * ey + ez * ez);
              if (lower >= best) continue;
              const o = t * 9;
              const dist = Math.sqrt(
                pointTriDist2(px, py, pz, tv[o], tv[o + 1], tv[o + 2], tv[o + 3], tv[o + 4], tv[o + 5], tv[o + 6], tv[o + 7], tv[o + 8]),
              );
              const dot = sign * tn[t * 3 + axis];
              const score = dist + NORMAL_PENALTY * h * (1 - dot);
              if (score < best) {
                best = score;
                bestT = t;
              }
            }
          }
        }
      }
      // この範囲の外にある三角形は、距離が ring·h より遠い。見つかった score がそれ以下なら確定
      if (bestT >= 0 && best <= ring * h) break;
    }
    tri[fi] = bestT;
  }

  // --- 面積の補正 ---
  const h2 = h * h;
  const groupTrue = new Float64Array(gCount);
  const groupArea = new Float64Array(gCount);
  const groupScale = new Float64Array(gCount).fill(1);
  let trueArea = 0;
  let lostTriangles = 0;
  const exposed = new Uint8Array(n);
  for (let fi = 0; fi < count; fi++) exposed[cell[fi]] = 1;
  for (let t = 0; t < nt; t++) {
    if (!valid[t]) continue;
    trueArea += triArea[t];
    const g = groups ? Math.min(gCount - 1, Math.max(0, groups[t])) : 0;
    groupTrue[g] += triArea[t];
    if (triArea[t] < h2) continue;
    // 重心のまわり 3×3×3 のセルに、外に出ている面を持つセルがなければ、その三角形の部分は格子から消えている
    const o = t * 9;
    const gi = Math.floor(((tv[o] + tv[o + 3] + tv[o + 6]) / 3 - origin[0]) / h);
    const gj = Math.floor(((tv[o + 1] + tv[o + 4] + tv[o + 7]) / 3 - origin[1]) / h);
    const gk = Math.floor(((tv[o + 2] + tv[o + 5] + tv[o + 8]) / 3 - origin[2]) / h);
    let near = false;
    for (let dk = -1; dk <= 1 && !near; dk++)
      for (let dj = -1; dj <= 1 && !near; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = gi + di;
          const jj = gj + dj;
          const kk = gk + dk;
          if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
          if (exposed[(kk * ny + jj) * nx + ii]) {
            near = true;
            break;
          }
        }
    if (!near) lostTriangles++;
  }
  for (let fi = 0; fi < count; fi++) {
    const t = tri[fi];
    if (t < 0) {
      area[fi] = h2;
      continue;
    }
    const l1 = Math.abs(tn[t * 3]) + Math.abs(tn[t * 3 + 1]) + Math.abs(tn[t * 3 + 2]);
    area[fi] = h2 / Math.max(1, l1);
    const g = groups ? Math.min(gCount - 1, Math.max(0, groups[t])) : 0;
    groupArea[g] += area[fi];
  }
  for (let g = 0; g < gCount; g++) {
    const r = groupArea[g] > 0 ? groupTrue[g] / groupArea[g] : 1;
    if (r >= SCALE_MIN && r <= SCALE_MAX) groupScale[g] = r;
  }
  let corrected = 0;
  for (let fi = 0; fi < count; fi++) {
    const t = tri[fi];
    if (t >= 0) {
      const g = groups ? Math.min(gCount - 1, Math.max(0, groups[t])) : 0;
      area[fi] *= groupScale[g];
    }
    corrected += area[fi];
  }
  // 倍率をかけたあとの面積の合計をグループごとに入れ直す
  groupArea.fill(0);
  for (let fi = 0; fi < count; fi++) {
    const t = tri[fi];
    const g = t >= 0 && groups ? Math.min(gCount - 1, Math.max(0, groups[t])) : 0;
    groupArea[g] += area[fi];
  }

  return { count, cell, dir, tri, area, rawArea: h2 * count, correctedArea: corrected, trueArea, groupTrue, groupArea, groupScale, lostTriangles };
}
