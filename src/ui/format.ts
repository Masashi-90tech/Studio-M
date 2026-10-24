// 数値と単位の表示整形。MPa・mm・mN のように読みやすい接頭辞を選ぶ。

/** 有効数字 sig 桁で、末尾の 0 を落として表示する */
export function formatNumber(v: number, sig = 3): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a < 1e-4 || a >= 1e7) {
    const [m, e] = v.toExponential(sig - 1).split('e');
    return `${Number(m)}e${Number(e)}`;
  }
  return String(Number(v.toPrecision(sig)));
}

interface UnitStep {
  scale: number;
  unit: string;
}

// 大きい順。基準単位（1）の前後にだけ接頭辞を付ける
const UNIT_TABLE: Record<string, UnitStep[]> = {
  Pa: [
    { scale: 1e9, unit: 'GPa' },
    { scale: 1e6, unit: 'MPa' },
    { scale: 1e3, unit: 'kPa' },
    { scale: 1, unit: 'Pa' },
  ],
  m: [
    { scale: 1, unit: 'm' },
    { scale: 1e-3, unit: 'mm' },
    { scale: 1e-6, unit: 'µm' },
  ],
  N: [
    { scale: 1e3, unit: 'kN' },
    { scale: 1, unit: 'N' },
    { scale: 1e-3, unit: 'mN' },
    { scale: 1e-6, unit: 'µN' },
  ],
  W: [
    { scale: 1e3, unit: 'kW' },
    { scale: 1, unit: 'W' },
    { scale: 1e-3, unit: 'mW' },
  ],
  'm/s': [
    { scale: 1, unit: 'm/s' },
    { scale: 1e-3, unit: 'mm/s' },
  ],
};

/** 絶対値の最大が absMax のとき、単位 unit をどの接頭辞で表すか */
export function pickUnit(absMax: number, unit: string): UnitStep {
  const table = UNIT_TABLE[unit];
  if (!table) return { scale: 1, unit };
  if (!(absMax > 0) || !Number.isFinite(absMax)) return table.find((s) => s.scale === 1) ?? table[0];
  for (const s of table) {
    if (absMax >= s.scale * (1 - 1e-9)) return s;
  }
  return table[table.length - 1];
}

/** 例: formatQuantity(2.5e6, 'Pa') → "2.5 MPa" */
export function formatQuantity(value: number, unit: string, sig = 3): string {
  if (!Number.isFinite(value)) return `— ${unit}`.trim();
  const u = pickUnit(Math.abs(value), unit);
  return `${formatNumber(value / u.scale, sig)} ${u.unit}`.trim();
}

/** 凡例用: 最小・最大を同じ接頭辞でそろえて返す */
export function formatRange(min: number, max: number, unit: string, sig = 3): { min: string; max: string; unit: string } {
  const u = pickUnit(Math.max(Math.abs(min), Math.abs(max)), unit);
  return { min: formatNumber(min / u.scale, sig), max: formatNumber(max / u.scale, sig), unit: u.unit };
}

/** 入力欄に出す数値（小数 digits 桁までで余分な 0 を落とす） */
export function inputNumber(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '';
  return String(Number(v.toFixed(digits)));
}
