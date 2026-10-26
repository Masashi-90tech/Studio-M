// 三角形メッシュの整理と検査。DOM に依存しない。
//
// - 外接箱、頂点の統合（許容差つき）、つぶれた三角形・重複した三角形の削除（ここまでは自動で直す）
// - 水密性の確認: 閉じた立体なら、どの辺もちょうど 2 つの三角形に共有される。
//   1 つしか共有しない辺は「穴の縁」、3 つ以上が共有する辺は「非多様体」。これは自動では直さず、注意として知らせる
// - 体積（水密のときだけ意味がある）
import type { Box3, TriMesh } from './types';

/** 使われている頂点の外接箱。頂点がなければ全部 0 */
export function meshBounds(mesh: TriMesh): Box3 {
  const { positions, indices } = mesh;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3;
    for (let k = 0; k < 3; k++) {
      const c = positions[v + k];
      if (c < min[k]) min[k] = c;
      if (c > max[k]) max[k] = c;
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/** 外接箱の対角線の長さ */
export function boxDiagonal(b: Box3): number {
  return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
}

/** 既定の統合の許容差（対角線の 1e-6 倍。float32 の STL の丸め誤差より大きく、細かい形より十分小さい） */
export function defaultTolerance(bounds: Box3): number {
  return Math.max(boxDiagonal(bounds) * 1e-6, 1e-12);
}

/**
 * 近い頂点を 1 つにまとめる。使われていない頂点は捨てる。
 * 格子（1 辺が許容差の 64 倍）に頂点を入れ、同じ格子・隣の格子の頂点だけを距離で比べる。
 */
export function weldVertices(mesh: TriMesh, tol: number): { mesh: TriMesh; merged: number } {
  const { positions, indices } = mesh;
  const bounds = meshBounds(mesh);
  const cell = Math.max(tol * 64, 1e-12);
  const tol2 = tol * tol;
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const outPos: number[] = [];
  const head = new Map<number, number>();
  const next: number[] = [];
  let referenced = 0;

  const hash = (ix: number, iy: number, iz: number): number => (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) | 0;
  const near = (f: number, i: number): number[] => {
    // f は格子の中での位置（0〜1）。端に近いときだけ隣の格子も調べる
    const out = [i];
    if (f * cell < tol) out.push(i - 1);
    if ((1 - f) * cell < tol) out.push(i + 1);
    return out;
  };

  const find = (x: number, y: number, z: number): number => {
    const gx = (x - bounds.min[0]) / cell;
    const gy = (y - bounds.min[1]) / cell;
    const gz = (z - bounds.min[2]) / cell;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const iz = Math.floor(gz);
    for (const a of near(gx - ix, ix)) {
      for (const b of near(gy - iy, iy)) {
        for (const c of near(gz - iz, iz)) {
          let r = head.get(hash(a, b, c)) ?? -1;
          while (r >= 0) {
            const dx = outPos[r * 3] - x;
            const dy = outPos[r * 3 + 1] - y;
            const dz = outPos[r * 3 + 2] - z;
            if (dx * dx + dy * dy + dz * dz <= tol2) return r;
            r = next[r];
          }
        }
      }
    }
    // 見つからなければ新しい頂点にする
    const id = outPos.length / 3;
    outPos.push(x, y, z);
    const h = hash(ix, iy, iz);
    next.push(head.get(h) ?? -1);
    head.set(h, id);
    return id;
  };

  const outIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    let r = remap[v];
    if (r < 0) {
      referenced++;
      r = find(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
      remap[v] = r;
    }
    outIdx[i] = r;
  }
  return { mesh: { positions: Float32Array.from(outPos), indices: outIdx }, merged: referenced - outPos.length / 3 };
}

export interface CleanReport {
  /** 整理前の三角形の数 */
  trianglesBefore: number;
  /** 統合した頂点の数 */
  mergedVertices: number;
  /** 削除したつぶれた三角形（面積がほぼ 0）の数 */
  removedDegenerate: number;
  /** 削除した重複した三角形（同じ 3 頂点）の数 */
  removedDuplicate: number;
}

/**
 * 重複した頂点を統合し、つぶれた三角形と重複した三角形を取り除く。
 * tol は統合の許容差（省略時は外接箱の対角線の 1e-6 倍）。
 */
export function cleanMesh(mesh: TriMesh, opts: { tol?: number } = {}): { mesh: TriMesh; report: CleanReport; tol: number } {
  const tol = opts.tol ?? defaultTolerance(meshBounds(mesh));
  const welded = weldVertices(mesh, tol);
  const { positions, indices } = welded.mesh;
  const diag = boxDiagonal(meshBounds(welded.mesh));
  const minArea = Math.max(diag * diag * 1e-12, 1e-24);
  const keep: number[] = [];
  const seen = new Set<string>();
  let removedDegenerate = 0;
  let removedDuplicate = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    if (a === b || b === c || a === c || triangleArea(positions, a, b, c) < minArea) {
      removedDegenerate++;
      continue;
    }
    const key = a < b ? (b < c ? `${a},${b},${c}` : a < c ? `${a},${c},${b}` : `${c},${a},${b}`) : a < c ? `${b},${a},${c}` : b < c ? `${b},${c},${a}` : `${c},${b},${a}`;
    if (seen.has(key)) {
      removedDuplicate++;
      continue;
    }
    seen.add(key);
    keep.push(a, b, c);
  }
  // 使われなくなった頂点を詰める
  const out = removedDegenerate + removedDuplicate > 0 ? compact({ positions, indices: Uint32Array.from(keep) }) : welded.mesh;
  return {
    mesh: out,
    tol,
    report: { trianglesBefore: mesh.indices.length / 3, mergedVertices: welded.merged, removedDegenerate, removedDuplicate },
  };
}

/** 使われていない頂点を捨てて、頂点番号を詰める */
function compact(mesh: TriMesh): TriMesh {
  const { positions, indices } = mesh;
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const out: number[] = [];
  const outIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (remap[v] < 0) {
      remap[v] = out.length / 3;
      out.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    }
    outIdx[i] = remap[v];
  }
  return { positions: Float32Array.from(out), indices: outIdx };
}

function triangleArea(p: Float32Array, a: number, b: number, c: number): number {
  const ux = p[b * 3] - p[a * 3];
  const uy = p[b * 3 + 1] - p[a * 3 + 1];
  const uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3];
  const vy = p[c * 3 + 1] - p[a * 3 + 1];
  const vz = p[c * 3 + 2] - p[a * 3 + 2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

export interface WatertightReport {
  /** 辺の数（重複なし） */
  edgeCount: number;
  /** 1 つの三角形にしか属さない辺（穴の縁）の数 */
  boundaryEdges: number;
  /** 3 つ以上の三角形が共有する辺（非多様体）の数 */
  nonManifoldEdges: number;
  /** 穴も非多様体もない（閉じた立体） */
  watertight: boolean;
}

/** 水密性を調べる。頂点が統合されていること（cleanMesh のあと）が前提 */
export function checkWatertight(mesh: TriMesh): WatertightReport {
  const { indices } = mesh;
  const vertexCount = mesh.positions.length / 3;
  const keys = new Float64Array(indices.length);
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k];
      const b = indices[t + ((k + 1) % 3)];
      keys[t + k] = a < b ? a * vertexCount + b : b * vertexCount + a;
    }
  }
  keys.sort();
  let edgeCount = 0;
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (let i = 0; i < keys.length; ) {
    let j = i + 1;
    while (j < keys.length && keys[j] === keys[i]) j++;
    const n = j - i;
    edgeCount++;
    if (n === 1) boundaryEdges++;
    else if (n > 2) nonManifoldEdges++;
    i = j;
  }
  return { edgeCount, boundaryEdges, nonManifoldEdges, watertight: indices.length > 0 && boundaryEdges === 0 && nonManifoldEdges === 0 };
}

/** 符号つきの体積（面の向きが外向きなら正）。水密でないと意味のある値にならない */
export function signedVolume(mesh: TriMesh): number {
  const { positions, indices } = mesh;
  const o = meshBounds(mesh).min; // 原点を近くに置いて桁落ちを減らす
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ax = positions[a] - o[0];
    const ay = positions[a + 1] - o[1];
    const az = positions[a + 2] - o[2];
    const bx = positions[b] - o[0];
    const by = positions[b + 1] - o[1];
    const bz = positions[b + 2] - o[2];
    const cx = positions[c] - o[0];
    const cy = positions[c + 1] - o[1];
    const cz = positions[c + 2] - o[2];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/** 体積（絶対値） */
export function meshVolume(mesh: TriMesh): number {
  return Math.abs(signedVolume(mesh));
}

export interface MeshInfo {
  /** 整理したあとのメッシュ（以降の処理はこれを使う） */
  mesh: TriMesh;
  bounds: Box3;
  triangleCount: number;
  vertexCount: number;
  /** 体積（モデルの単位の 3 乗）。水密でなければ目安 */
  volume: number;
  clean: CleanReport;
  watertight: WatertightReport;
  /** 自動で直したこと（知らせるだけ） */
  fixes: string[];
  /** 直せなかったこと（何が起きていて、どうすれば直るかを書く） */
  warnings: string[];
}

/** 読み込んだメッシュを整理して検査し、利用者に知らせる文を作る */
export function analyzeMesh(raw: TriMesh, opts: { tol?: number } = {}): MeshInfo {
  const cleaned = cleanMesh(raw, opts);
  const mesh = cleaned.mesh;
  const watertight = checkWatertight(mesh);
  const fixes: string[] = [];
  const warnings: string[] = [];
  const { mergedVertices, removedDegenerate, removedDuplicate } = cleaned.report;
  if (mergedVertices > 0) fixes.push(`重なっていた頂点を ${mergedVertices.toLocaleString('ja-JP')} 個まとめました。`);
  if (removedDegenerate > 0) fixes.push(`面積のないつぶれた三角形を ${removedDegenerate.toLocaleString('ja-JP')} 個取り除きました。`);
  if (removedDuplicate > 0) fixes.push(`同じ位置に重なっていた三角形を ${removedDuplicate.toLocaleString('ja-JP')} 個取り除きました。`);
  if (mesh.indices.length === 0) {
    warnings.push('使える三角形がありません（すべて面積のないつぶれた三角形でした）。モデルが空でないか確かめてください。');
  }
  if (watertight.boundaryEdges > 0) {
    warnings.push(
      `モデルに穴があいています（開いた辺が ${watertight.boundaryEdges.toLocaleString('ja-JP')} 本）。穴を通る断面は輪が閉じず、形が欠けたり消えたりすることがあります。` +
        'Blender なら「3D プリント」ツールボックスの「チェック」で場所を探し、「Make Manifold」や編集モードの「面を作る（F）」で穴を埋めてから書き出し直してください。',
    );
  }
  if (watertight.nonManifoldEdges > 0) {
    warnings.push(
      `3 枚以上の面が 1 つの辺を共有している所があります（${watertight.nonManifoldEdges.toLocaleString('ja-JP')} 本）。内側に残った面や、重なった別々の部品が原因のことが多く、断面の形が乱れることがあります。` +
        'Blender なら「3D プリント」ツールボックスの「非多様体」で場所を探し、余分な面を消すか部品を 1 つに結合（ブーリアン）してから書き出し直してください。',
    );
  }
  return {
    mesh,
    bounds: meshBounds(mesh),
    triangleCount: mesh.indices.length / 3,
    vertexCount: mesh.positions.length / 3,
    volume: meshVolume(mesh),
    clean: cleaned.report,
    watertight,
    fixes,
    warnings,
  };
}
