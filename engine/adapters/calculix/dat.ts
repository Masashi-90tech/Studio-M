// CalculiX の .dat（*NODE PRINT / *EL PRINT の出力）を読む。
//
// .dat は「見出し行 → 空行 → データ行（空白区切り）→ 空行」のブロックが並ぶ文字列で、
// 増分ごとに同じブロックが繰り返される。.frd より書式が単純で、版が変わっても崩れにくいので、
// 数値の読み取りにはこちらを使う（.frd は ParaView / CGX に渡す用）。
//
// 要素の値（応力・塑性ひずみ）は積分点ごとに並ぶ（平面応力要素は内部で 3D に広げられ、8 点になる）。
// 積分点の平均は、双線形要素ではセルの中心の値に等しいので、読むそばから要素ごとの平均にまとめる。

export type DatKind = 'displacement' | 'totalForce' | 'stress' | 'plasticStrain' | 'other';

export interface DatBlock {
  kind: DatKind;
  /** 見出しの for set の後ろ（NALL, NSUP, EALL など） */
  set: string;
  /** 増分の終わりの時刻（ステップ時間 = 荷重の割合） */
  time: number;
  /** 節点番号 or 要素番号（totalForce は空） */
  ids: Int32Array;
  /** ids 1 つにつき columns 個の値。要素の値は積分点の平均 */
  values: Float64Array;
  columns: number;
}

const HEADERS: { re: RegExp; kind: DatKind; columns: number; perPoint: boolean }[] = [
  { re: /^\s*displacements\s*\(/i, kind: 'displacement', columns: 3, perPoint: false },
  { re: /^\s*total force\s*\(/i, kind: 'totalForce', columns: 3, perPoint: false },
  { re: /^\s*stresses\s*\(/i, kind: 'stress', columns: 6, perPoint: true },
  { re: /^\s*equivalent plastic strain\s*\(/i, kind: 'plasticStrain', columns: 1, perPoint: true },
];

const SET_TIME = /for set\s+(\S+)\s+and time\s+(\S+)/i;

/** データ行（先頭が整数、残りが数値）か、totalForce のような数値だけの行 */
function numbers(line: string): number[] | null {
  const parts = line.trim().split(/\s+/);
  const out: number[] = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const v = Number(parts[i]);
    if (Number.isNaN(v)) return null;
    out[i] = v;
  }
  return out;
}

export function parseDat(text: string): DatBlock[] {
  const blocks: DatBlock[] = [];
  const lines = text.split(/\r?\n/);

  let cur: { kind: DatKind; set: string; time: number; columns: number; perPoint: boolean } | null = null;
  let ids: number[] = [];
  let values: number[] = [];
  // 要素の積分点の平均用
  let lastId = -1;
  let accum: number[] = [];
  let accumN = 0;

  const flushElement = (): void => {
    if (accumN > 0 && cur) {
      ids.push(lastId);
      for (let k = 0; k < cur.columns; k++) values.push(accum[k] / accumN);
    }
    accumN = 0;
    lastId = -1;
  };
  const finish = (): void => {
    if (!cur) return;
    if (cur.perPoint) flushElement();
    blocks.push({
      kind: cur.kind,
      set: cur.set,
      time: cur.time,
      ids: Int32Array.from(ids),
      values: Float64Array.from(values),
      columns: cur.columns,
    });
    cur = null;
    ids = [];
    values = [];
  };

  for (const line of lines) {
    const header = HEADERS.find((h) => h.re.test(line));
    if (header) {
      finish();
      const m = SET_TIME.exec(line);
      cur = { kind: header.kind, set: m?.[1] ?? '', time: m ? Number(m[2]) : NaN, columns: header.columns, perPoint: header.perPoint };
      accum = new Array<number>(header.columns).fill(0);
      continue;
    }
    if (!cur) continue;
    if (line.trim() === '') {
      // 見出しの直後の空行は読み飛ばし、データのあとの空行でブロックを閉じる
      if (ids.length > 0 || accumN > 0 || (cur.kind === 'totalForce' && values.length > 0)) finish();
      continue;
    }
    const nums = numbers(line);
    if (!nums) {
      finish();
      continue;
    }
    if (cur.kind === 'totalForce') {
      values.push(...nums.slice(0, 3));
      continue;
    }
    const id = nums[0];
    if (cur.perPoint) {
      // 要素番号, 積分点番号, 値...
      if (id !== lastId) {
        flushElement();
        lastId = id;
        accum.fill(0);
      }
      for (let k = 0; k < cur.columns; k++) accum[k] += nums[2 + k] ?? 0;
      accumN++;
    } else {
      ids.push(id);
      for (let k = 0; k < cur.columns; k++) values.push(nums[1 + k] ?? 0);
    }
  }
  finish();
  return blocks;
}

/** 条件に合う最後のブロック（最後の増分 = 最終の荷重） */
export function lastBlock(blocks: DatBlock[], kind: DatKind, set?: string): DatBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === kind && (set === undefined || blocks[i].set.toUpperCase() === set.toUpperCase())) return blocks[i];
  }
  return undefined;
}
