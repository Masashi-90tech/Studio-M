// S 式（KiCad のファイル形式）の小さなパーサー。DOM にも他のモジュールにも依存しない。
//
// 書き方の例: (kicad_pcb (version 20240108) (general (thickness 1.6)) (footprint "R_0603" (at 10 20 90)))
// 値は 3 種類にする。
//   リスト  : SExpr[]（先頭の要素が名前。例: ['at', 10, 20, 90]）
//   数値    : 引用符なしで数として読めるもの（-1.5、1e-3 など）
//   文字列  : 引用符つきの文字列と、数でない記号（引用符の有無は区別しない）
// 引用符つきの "1.6" は文字列のまま残る（部品番号の "1" と数値の 1 を取り違えないため）。

export type SExpr = SList | string | number;
export type SList = SExpr[];

export class SexprError extends Error {
  constructor(
    message: string,
    /** 問題の場所（先頭からの文字数） */
    readonly offset: number,
  ) {
    super(message);
    this.name = 'SexprError';
  }
}

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** 空白・括弧・引用符のどれでもない文字だけでできた塊（記号か数）を読み終える位置 */
function atomEnd(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    // 空白（スペース・タブ・改行）、( ) "
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 40 || c === 41 || c === 34) break;
    i++;
  }
  return i;
}

/**
 * 文字列全体を読み、最上位の 1 つのリストを返す。
 * 括弧の対応が取れないとき（ファイルが途中で切れているなど）は SexprError を投げる。
 * 再帰を使わないので、深く入れ子になったファイルでも落ちない。
 */
export function parseSexpr(src: string): SList {
  const stack: SList[] = [];
  let root: SList | null = null;
  const push = (v: SExpr, at: number): void => {
    const top = stack[stack.length - 1];
    if (!top) throw new SexprError('括弧の外に値があります', at);
    top.push(v);
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) {
      i++;
    } else if (c === 40) {
      // (
      stack.push([]);
      i++;
    } else if (c === 41) {
      // )
      const done = stack.pop();
      if (!done) throw new SexprError('閉じ括弧が多すぎます', i);
      if (stack.length === 0) {
        if (root !== null) throw new SexprError('最上位に複数の式があります', i);
        root = done;
      } else stack[stack.length - 1].push(done);
      i++;
    } else if (c === 34) {
      // "..." （\" \\ \n \t などのエスケープに対応）
      let out = '';
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\' && j + 1 < n) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else if (d === '"') {
          closed = true;
          j++;
          break;
        } else {
          out += d;
          j++;
        }
      }
      if (!closed) throw new SexprError('文字列の閉じ引用符がありません', i);
      push(out, i);
      i = j;
    } else {
      const end = atomEnd(src, i);
      const tok = src.slice(i, end);
      push(NUMBER_RE.test(tok) ? Number(tok) : tok, i);
      i = end;
    }
  }
  if (stack.length > 0) throw new SexprError('括弧が閉じていません（ファイルが途中で切れている可能性があります）', n);
  if (root === null) throw new SexprError('式が見つかりません', 0);
  return root;
}

// ---------- 問い合わせの道具 ----------

export function isList(v: SExpr | undefined): v is SList {
  return Array.isArray(v);
}

/** リストの名前（先頭の要素）。名前がなければ空文字 */
export function headOf(list: SList): string {
  const first = list[0];
  return typeof first === 'string' ? first : '';
}

/** 名前が head の子リストをすべて返す */
export function children(list: SList, head: string): SList[] {
  const out: SList[] = [];
  for (let i = 1; i < list.length; i++) {
    const c = list[i];
    if (isList(c) && c[0] === head) out.push(c);
  }
  return out;
}

/** 名前が head の最初の子リスト */
export function child(list: SList, head: string): SList | undefined {
  for (let i = 1; i < list.length; i++) {
    const c = list[i];
    if (isList(c) && c[0] === head) return c;
  }
  return undefined;
}

/** index 番目の引数を数値で（先頭の名前が 0 番）。数でなければ fallback */
export function numAt(list: SList | undefined, index: number, fallback = NaN): number {
  const v = list?.[index];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && NUMBER_RE.test(v)) return Number(v);
  return fallback;
}

/** index 番目の引数を文字列で。数値は文字列にして返す */
export function strAt(list: SList | undefined, index: number, fallback = ''): string {
  const v = list?.[index];
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return fallback;
}

/** 子リスト (head a b …) の a を数値で取る。(thickness 1.6) → 1.6 */
export function childNum(list: SList, head: string, fallback = NaN): number {
  return numAt(child(list, head), 1, fallback);
}

/** 子リスト (head "abc") の文字列を取る */
export function childStr(list: SList, head: string, fallback = ''): string {
  return strAt(child(list, head), 1, fallback);
}

/** 子リスト (head x y) の 2 つの数を取る。(at 10 20) → [10, 20] */
export function childXY(list: SList, head: string): [number, number] | undefined {
  const c = child(list, head);
  if (!c) return undefined;
  const x = numAt(c, 1);
  const y = numAt(c, 2);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : undefined;
}

/** (pts (xy x y) (xy x y) …) の点列を取る。arc 要素（pts の中の弧）は端点だけ使う */
export function pointsOf(list: SList): [number, number][] {
  const pts = child(list, 'pts');
  const out: [number, number][] = [];
  if (!pts) return out;
  for (const p of children(pts, 'xy')) {
    const x = numAt(p, 1);
    const y = numAt(p, 2);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

/** リストの引数のうち、文字列と数値だけを順に並べる（(layers "F.Cu" "B.Cu") → ['F.Cu', 'B.Cu']） */
export function atomArgs(list: SList): string[] {
  const out: string[] = [];
  for (let i = 1; i < list.length; i++) {
    const v = list[i];
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'number') out.push(String(v));
  }
  return out;
}
