// 数式表示用の数値整形。SI 接頭辞（mm・MPa・GHz）と ×10ⁿ の上付き表記。DOM に触れない。

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '-': '⁻',
  '−': '⁻',
  '+': '⁺',
};

/** 整数 n を上付き文字にする（-9 → ⁻⁹） */
export function superscript(n: number): string {
  return String(Math.trunc(n))
    .split('')
    .map((c) => SUPERSCRIPT[c] ?? c)
    .join('');
}

const MINUS = '−';

/** 末尾の 0 を落とした小数（有効数字 sig 桁）。指数表記にはしない前提の範囲で使う */
function trimmed(v: number, sig: number): string {
  return String(Number(v.toPrecision(sig)));
}

/**
 * 有効数字 sig 桁の数。0.001 以上 10000 未満はそのまま、それ以外は 3 の倍数の指数で
 * 「68.9×10⁹」「1.67×10⁻⁹」のように書く。
 */
export function formatSig(v: number, sig = 3): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const sign = v < 0 ? MINUS : '';
  const a = Math.abs(v);
  if (a >= 1e-3 && a < 1e4) return sign + trimmed(a, sig);
  // 指数表記: 丸めて桁が繰り上がる場合（9.999e5 → 1e6）も toExponential が面倒を見る
  const [mant, exp] = a.toExponential(sig - 1).split('e');
  let e = Number(exp);
  let m = Number(mant);
  const shift = ((e % 3) + 3) % 3; // 3 の倍数に揃える
  e -= shift;
  m *= 10 ** shift;
  const mText = trimmed(m, sig);
  return e === 0 ? sign + mText : `${sign}${mText}×10${superscript(e)}`;
}

/** 式に数字を入れる場面用。負の数はカッコで包む（× (−0.46) のように） */
export function formatSub(v: number, sig = 3): string {
  const s = formatSig(v, sig);
  return v < 0 ? `(${s})` : s;
}

interface Prefix {
  scale: number;
  unit: string;
}

// 大きい順。ここにない単位は接頭辞を付けず、×10ⁿ で表す
const PREFIXES: Record<string, Prefix[]> = {
  m: [
    { scale: 1, unit: 'm' },
    { scale: 1e-3, unit: 'mm' },
    { scale: 1e-6, unit: 'µm' },
  ],
  Pa: [
    { scale: 1e9, unit: 'GPa' },
    { scale: 1e6, unit: 'MPa' },
    { scale: 1e3, unit: 'kPa' },
    { scale: 1, unit: 'Pa' },
  ],
  N: [
    { scale: 1e3, unit: 'kN' },
    { scale: 1, unit: 'N' },
    { scale: 1e-3, unit: 'mN' },
  ],
  W: [
    { scale: 1e3, unit: 'kW' },
    { scale: 1, unit: 'W' },
    { scale: 1e-3, unit: 'mW' },
  ],
  Hz: [
    { scale: 1e9, unit: 'GHz' },
    { scale: 1e6, unit: 'MHz' },
    { scale: 1e3, unit: 'kHz' },
    { scale: 1, unit: 'Hz' },
  ],
  s: [
    { scale: 1, unit: 's' },
    { scale: 1e-3, unit: 'ms' },
    { scale: 1e-6, unit: 'µs' },
    { scale: 1e-9, unit: 'ns' },
  ],
};

/** 値 v を接頭辞つきの単位に直す。{ value: 4.7, unit: 'mm' } のように返す */
export function toPrefixed(v: number, unit: string): { value: number; unit: string } {
  const table = PREFIXES[unit];
  if (!table || !Number.isFinite(v) || v === 0) return { value: v, unit };
  const a = Math.abs(v);
  const pick = table.find((p) => a >= p.scale * (1 - 1e-9)) ?? table[table.length - 1];
  return { value: v / pick.scale, unit: pick.unit };
}

/** 接頭辞つきの値の文字列。例: formatValue(0.0047, 'm') → '4.7 mm' */
export function formatValue(v: number, unit: string, sig = 3): string {
  if (!Number.isFinite(v)) return '—';
  const p = toPrefixed(v, unit);
  const num = formatSig(p.value, sig);
  if (!p.unit) return num;
  if (p.unit === '%' || p.unit === '°') return num + p.unit;
  return `${num} ${p.unit}`;
}

/** 倍率の言い方。2 → '2 倍'、0.5 → '半分'、0.125 → '0.125 倍（1/8）' */
export function ratioText(r: number): string {
  if (!Number.isFinite(r)) return '—';
  if (Math.abs(r - 0.5) < 0.005) return '半分';
  const base = `${formatSig(r, 3)} 倍`;
  if (r > 0 && r < 0.9) {
    const inv = 1 / r;
    const k = Math.round(inv);
    if (k >= 2 && k <= 1000 && Math.abs(inv - k) / k < 0.01) return `${base}（1/${k}）`;
  }
  return base;
}

/** 差の割合 [%] の表示。+3.2% / −1.0% */
export function formatPercentDiff(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  const p = (ratio - 1) * 100;
  const s = Math.abs(p) < 0.05 ? '0' : String(Number(Math.abs(p).toPrecision(2)));
  return p > 0.05 ? `+${s}%` : p < -0.05 ? `${MINUS}${s}%` : '±0%';
}

/** 累乗の表示。formatPow(0.2, 3) → '0.2³'、指数表記の数はカッコで包む */
export function formatPow(v: number, n: number, sig = 3): string {
  const s = formatSig(v, sig);
  return /[×−]/.test(s) ? `(${s})${superscript(n)}` : `${s}${superscript(n)}`;
}
