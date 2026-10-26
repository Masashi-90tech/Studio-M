// 3D の熱のかんたんな判定（DOM に依存しない）。2D の熱の判定（workbench/verdicts/heat.ts）と同じ考え方:
// 材料の耐熱温度（maxTempC）との余裕で OK / 注意 / NG を決める。耐熱温度がない材料（金属など）は、温度の上がり方だけを知らせる。
import { getMaterial } from '../core/materials';
import type { ResultSet3D, Study3D } from '../core/types';
import { formatNumber } from '../ui/format';

export type Verdict3DLevel = 'ok' | 'warn' | 'ng' | 'info';

export interface Verdict3D {
  level: Verdict3DLevel;
  title: string;
  lines: string[];
}

/** 余裕 [K] がこれ以上なら OK、0 以上なら注意、負なら NG（2D の熱と同じ） */
export const OK_MARGIN_K = 10;

const deg = (v: number): string => `${formatNumber(v, 3)}°C`;

/** 結果の最高温度。代表値 maxTemp がなければ温度の場の最大値。なければ undefined */
export function maxTempOf(result: ResultSet3D): number | undefined {
  const s = result.scalars.find((x) => x.key === 'maxTemp');
  if (s && Number.isFinite(s.value)) return s.value;
  const f = result.fields.find((x) => x.key === 'temp');
  if (!f) return undefined;
  let max = -Infinity;
  for (let i = 0; i < f.data.length; i++) if (f.mask[i] === 1 && Number.isFinite(f.data[i]) && f.data[i] > max) max = f.data[i];
  return Number.isFinite(max) ? max : undefined;
}

/** 熱を出す・入れるもの（面の発熱の合計 + 部品全体の発熱）[W] */
export function totalHeatW(study: Study3D): number {
  let w = study.heat.bodyHeatW ?? 0;
  for (const r of study.regions) if (r.role === 'heatFlux') w += r.heatW ?? 0;
  return w;
}

export function heatVerdict3D(opts: { result: ResultSet3D; study: Study3D }): Verdict3D {
  const { result, study } = opts;
  const max = maxTempOf(result);
  if (max === undefined) return { level: 'info', title: '温度が計算されませんでした', lines: ['計算の設定（面の条件・格子の細かさ）を見直して、もう一度計算してください。'] };
  const ambient = study.heat.ambientC;
  const rise = `室温 ${deg(ambient)} より ${formatNumber(Math.max(0, max - ambient), 2)} K 高くなります。`;
  const lines: string[] = [];
  const noHeat = totalHeatW(study) <= 0 && !study.regions.some((r) => r.role === 'fixedTemp');
  if (noHeat) lines.push('発熱がありません。面を選んで「発熱」を足すと、温度が上がります。');
  let mat;
  try {
    mat = getMaterial(study.materialId);
  } catch {
    mat = undefined;
  }
  const limit = mat?.maxTempC;
  if (limit === undefined) {
    return { level: 'info', title: `いちばん熱いところは ${deg(max)} です`, lines: [rise, ...(mat ? [`${mat.name}には耐熱温度の目安が入っていません。使う部品の上限と見比べてください。`] : []), ...lines] };
  }
  const name = mat!.name.replace(/（.*$/, '');
  const margin = limit - max;
  const detail = `${name}の耐熱の目安は ${deg(limit)}、最高は ${deg(max)} です。`;
  if (margin >= OK_MARGIN_K) return { level: 'ok', title: `${name}の耐熱温度に余裕があります（最高 ${deg(max)}）`, lines: [detail, rise, ...lines] };
  if (margin >= 0) return { level: 'warn', title: `${name}の耐熱温度ぎりぎりです（最高 ${deg(max)}）`, lines: [detail, 'ファンを当てる・発熱を減らす・熱の逃げる面を増やすなどで下げられます。', rise, ...lines] };
  return {
    level: 'ng',
    title: `${name}の耐熱温度を超えます（最高 ${deg(max)}）`,
    lines: [detail, `上限より ${formatNumber(-margin, 2)} K 高くなっています。冷やすか、発熱を減らしてください。`, rise, ...lines],
  };
}
