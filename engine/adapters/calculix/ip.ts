// .dat の「要素の積分点ごとの応力」と「積分点の座標（COORD）」を読み、要素ごとの 1 次式（x, y の一次関数）に当てはめる。
//
// 6 節点の三角形（CPS6）は、CalculiX の中で厚さ方向にも広げられ、1 要素に積分点が 9 つ（面内 3 点 × 厚さ方向 3 層）並ぶ。
// 平面応力なので厚さ方向の 3 層は同じ値で、面内の 3 点があれば応力の 1 次式が決まる。
// この 1 次式を要素の節点の位置に当てはめて、「要素ごとの節点の応力」（積分点の値の外挿）を作る。
// 積分点の並び順に頼らないよう、座標（COORD）と組にして、最小二乗で当てはめる。

export interface StressFits {
  /** 要素数（要素番号は 1 から nElem） */
  elementCount: number;
  /** 当てはめの基準の点。要素 e（0 から）は ref[2e], ref[2e + 1] */
  ref: Float64Array;
  /** 要素 e の成分 k（0 = σx, 1 = σy, 2 = τxy）の係数 [a, b, c] が coef[9e + 3k .. 9e + 3k + 2]。値 = a + b (x − x0) + c (y − y0) */
  coef: Float64Array;
}

/** 当てはめた 1 次式の、点 (x, y) での値 */
export function evalFit(fits: StressFits, e: number, k: number, x: number, y: number): number {
  const o = 9 * e + 3 * k;
  return fits.coef[o] + fits.coef[o + 1] * (x - fits.ref[2 * e]) + fits.coef[o + 2] * (y - fits.ref[2 * e + 1]);
}

const NUM = /^[-+0-9.]/;

/** 見出しのあとのデータ行を、数値の配列として集める（見出しの直後の空行は読み飛ばし、データのあとの空行で閉じる） */
function collect(lines: string[], from: number): { rows: number[][]; next: number } {
  const rows: number[][] = [];
  let i = from;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '') {
      if (rows.length > 0) break;
      continue;
    }
    if (!NUM.test(t)) break;
    const parts = t.split(/\s+/);
    const row = new Array<number>(parts.length);
    let ok = true;
    for (let k = 0; k < parts.length; k++) {
      row[k] = Number(parts[k]);
      if (Number.isNaN(row[k])) ok = false;
    }
    if (!ok) break;
    rows.push(row);
  }
  return { rows, next: i };
}

/**
 * .dat から、最後の増分の応力と積分点の座標を読み、要素ごとの当てはめを返す。
 * 見つからない（COORD を出していない・計算が途中で止まった）ときは null
 */
export function readStressFits(datText: string, elementCount: number): StressFits | null {
  const lines = datText.split(/\r?\n/);
  let stress: number[][] | null = null;
  let coords: number[][] | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*stresses\s*\(/i.test(lines[i])) {
      const r = collect(lines, i + 1);
      stress = r.rows;
      i = r.next - 1;
    } else if (/^\s*global coordinates\s*\(/i.test(lines[i])) {
      const r = collect(lines, i + 1);
      coords = r.rows;
      i = r.next - 1;
    }
  }
  if (!stress || !coords || stress.length === 0 || stress.length !== coords.length) return null;

  // 要素ごとに積分点を集める（行は 要素番号, 積分点番号, 値...）
  const ref = new Float64Array(2 * elementCount);
  const coef = new Float64Array(9 * elementCount);
  const seen = new Uint8Array(elementCount);
  let start = 0;
  while (start < stress.length) {
    const id = stress[start][0];
    let end = start;
    while (end < stress.length && stress[end][0] === id) end++;
    const e = id - 1;
    if (e >= 0 && e < elementCount) {
      fitElement(stress, coords, start, end, e, ref, coef);
      seen[e] = 1;
    }
    start = end;
  }
  for (let e = 0; e < elementCount; e++) if (!seen[e]) return null;
  return { elementCount, ref, coef };
}

/** 積分点 [start, end) の (x, y) と応力（σx, σy, τxy）に、a + b dx + c dy を最小二乗で当てはめる */
function fitElement(stress: number[][], coords: number[][], start: number, end: number, e: number, ref: Float64Array, coef: Float64Array): void {
  const n = end - start;
  let mx = 0;
  let my = 0;
  for (let p = start; p < end; p++) {
    mx += coords[p][2];
    my += coords[p][3];
  }
  mx /= n;
  my /= n;
  ref[2 * e] = mx;
  ref[2 * e + 1] = my;
  // 正規方程式 [n Σdx Σdy; Σdx Σdx² ΣdxΣdy; Σdy ΣdxΣdy Σdy²]（Σdx = Σdy = 0 なので簡単になる）
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let p = start; p < end; p++) {
    const dx = coords[p][2] - mx;
    const dy = coords[p][3] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const det = sxx * syy - sxy * sxy;
  const regular = det > 1e-12 * (sxx + syy) * (sxx + syy) && det > 0;
  for (let k = 0; k < 3; k++) {
    let sv = 0;
    let svx = 0;
    let svy = 0;
    for (let p = start; p < end; p++) {
      // 応力の列は 要素番号, 積分点番号, σxx, σyy, σzz, σxy, ...
      const v = stress[p][k === 0 ? 2 : k === 1 ? 3 : 5];
      const dx = coords[p][2] - mx;
      const dy = coords[p][3] - my;
      sv += v;
      svx += v * dx;
      svy += v * dy;
    }
    const o = 9 * e + 3 * k;
    coef[o] = sv / n;
    if (regular) {
      coef[o + 1] = (svx * syy - svy * sxy) / det;
      coef[o + 2] = (svy * sxx - svx * sxy) / det;
    } else {
      coef[o + 1] = 0;
      coef[o + 2] = 0;
    }
  }
}
