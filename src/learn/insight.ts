// スライダーを動かしたときの一言（insight）を作る部品。DOM に触れない。
// 「L が 2 倍 → δ は 8 倍（3 乗だから）」のような、元の値との比べ方を決める。
import { formatSig, ratioText } from './format';

/** 結果が 変数^exp の積に比例する式（べき乗則）の 1 項 */
export interface PowerTerm {
  key: string;
  symbol: string;
  /** 指数。1 = 比例、-1 = 反比例、3 = 3 乗、0.5 = 平方根 */
  exp: number;
}

/** 助詞のあとに倍率を続ける。数字なら空けて（が 2 倍）、「半分」ならそのまま（が半分）つなぐ */
const after = (particle: string, text: string): string => `${particle}${/^[0-9]/.test(text) ? ' ' : ''}${text}`;

/** 変化なしとみなす倍率の幅 */
const SAME = 0.005;

/** 指数の言い方（「3 乗だから」など） */
export function exponentWords(exp: number): string {
  if (exp === 1) return '比例だから';
  if (exp === -1) return '反比例だから';
  if (exp === 0.5) return '平方根だから';
  if (exp === -0.5) return '平方根に反比例するから';
  if (exp > 0) return `${formatSig(exp)} 乗だから`;
  return `${formatSig(-exp)} 乗に反比例するから`;
}

/** 倍率を安全に求める（元が 0 や非有限なら null） */
function ratioOf(now: number, base: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(base) || base === 0) return null;
  return now / base;
}

/**
 * べき乗則の式用の insight。1 つだけ動かしたときは理由つき、複数のときは合計の倍率を言う。
 * 何も変わっていなければ null。
 */
export function powerInsight(resultSymbol: string, terms: PowerTerm[]): (vars: Record<string, number>, base: Record<string, number>) => string | null {
  return (vars, base) => {
    const changed: { term: PowerTerm; r: number }[] = [];
    for (const term of terms) {
      const r = ratioOf(vars[term.key], base[term.key]);
      if (r !== null && Math.abs(r - 1) > SAME) changed.push({ term, r });
    }
    if (changed.length === 0) return null;
    const total = changed.reduce((acc, c) => acc * c.r ** c.term.exp, 1);
    if (changed.length === 1) {
      const { term, r } = changed[0];
      return `${term.symbol} ${after('が', ratioText(r))} → ${resultSymbol} ${after('は', ratioText(total))}（${exponentWords(term.exp)}）`;
    }
    const parts = changed.map((c) => `${c.term.symbol} ${after('が', ratioText(c.r))}`).join('、');
    if (Math.abs(total - 1) <= SAME) return `${parts} → 打ち消し合って ${resultSymbol} は変わりません`;
    return `${parts} → ${resultSymbol} は全部で ${ratioText(total)}`;
  };
}

/**
 * べき乗則でない式用の insight。動かした変数の倍率と、結果の倍率だけを言う。
 * symbols は key → 記号。結果は evaluate で出す。
 */
export function ratioInsight(
  resultSymbol: string,
  symbols: Record<string, string>,
  evaluate: (vars: Record<string, number>) => number,
): (vars: Record<string, number>, base: Record<string, number>) => string | null {
  return (vars, base) => {
    const parts: string[] = [];
    for (const [key, symbol] of Object.entries(symbols)) {
      const r = ratioOf(vars[key], base[key]);
      if (r !== null && Math.abs(r - 1) > SAME) parts.push(`${symbol} ${after('が', ratioText(r))}`);
    }
    if (parts.length === 0) return null;
    const res = ratioOf(evaluate(vars), evaluate(base));
    if (res === null) return `${parts.join('、')} に変えました`;
    if (Math.abs(res - 1) <= SAME) return `${parts.join('、')} → ${resultSymbol} はほぼ変わりません`;
    return `${parts.join('、')} → ${resultSymbol} ${after('は', ratioText(res))}`;
  };
}

/** 2 つの insight をつなぐ（先の文 + 後の文）。どちらかが null なら残りを返す */
export function joinInsight(a: string | null, b: string | null): string | null {
  if (a && b) return `${a}。${b}`;
  return a ?? b;
}

/**
 * dB で答える式用の insight。dB は対数なので、倍率ではなく差（+3 dB など）で言う。
 */
export function dbInsight(
  resultSymbol: string,
  symbols: Record<string, string>,
  evaluate: (vars: Record<string, number>) => number,
): (vars: Record<string, number>, base: Record<string, number>) => string | null {
  return (vars, base) => {
    const parts: string[] = [];
    for (const [key, symbol] of Object.entries(symbols)) {
      const r = ratioOf(vars[key], base[key]);
      if (r !== null && Math.abs(r - 1) > SAME) parts.push(`${symbol} ${after('が', ratioText(r))}`);
    }
    if (parts.length === 0) return null;
    const diff = evaluate(vars) - evaluate(base);
    if (!Number.isFinite(diff)) return `${parts.join('、')} に変えました`;
    if (Math.abs(diff) < 0.005) return `${parts.join('、')} → ${resultSymbol} はほぼ変わりません`;
    const sign = diff > 0 ? '+' : '−';
    return `${parts.join('、')} → ${resultSymbol} は ${sign}${formatSig(Math.abs(diff), 3)} dB`;
  };
}
