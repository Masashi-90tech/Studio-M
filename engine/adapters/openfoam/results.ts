// OpenFOAM の結果 → Studio M の ResultSet（Lite の流れ解析と同じ場・数値・履歴のキー）。

import type { Field, History, ResultSet, ScalarValue } from '../../../src/core/types';
import type { FlowModel } from './dicts';
import type { FoamField } from './foamio';
import type { ForceSeries } from './forces';

/** 履歴に残すサンプルの最大数（Lite と同じ） */
export const HISTORY_MAX = 2000;

export interface FlowResultInput {
  nx: number;
  ny: number;
  h: number;
  /** OpenFOAM のセル → ラスターのセル番号 */
  cellToRaster: Int32Array;
  /** 速度 [m/s]（3 成分） */
  U: FoamField;
  /** 動圧を密度で割った圧力 p/ρ [m²/s²] */
  p: FoamField;
  rho: number;
  nu: number;
  uInf: number;
  /** 代表長さ L [m] */
  length: number;
  /** project.thickness [m] */
  thickness: number;
  /** OpenFOAM のメッシュの奥行き [m]（力はこの厚さ分で出る） */
  meshDepth: number;
  forces: ForceSeries;
  model: FlowModel;
  /** 最後に書き出した時刻（RANS は反復回数） */
  endTime: number;
  /** 追加の注意（メッシュ作成で分かったことなど） */
  warnings?: string[];
  /** solver の名前（pimpleFoam / simpleFoam） */
  solver: string;
}

const MODEL_LABEL: Record<FlowModel, string> = {
  laminar: '層流',
  les: 'LES（Smagorinsky）',
  rans: 'RANS（k-ω SST）',
};

/** 等間隔に間引く（最初と最後は残す） */
function thin<T>(a: T[], max: number): T[] {
  if (a.length <= max) return a.slice();
  const out: T[] = [];
  for (let k = 0; k < max; k++) out.push(a[Math.round((k * (a.length - 1)) / (max - 1))]);
  return out;
}

/**
 * 揚力履歴の後半のゼロ交差から、渦放出の周波数と St = f L / U を求める。
 * 振れが小さい・交差が少ない・間隔がばらつくときは null（まだ渦が出ていない、または定常）。
 * qa は動圧 × 代表面積 [N]（揚力係数 0.05 未満の振れは渦とみなさない）
 */
export function estimateStrouhal(opts: { t: number[]; lift: number[]; qa: number; length: number; uInf: number }): number | null {
  const { t, lift: v, qa, length, uInf } = opts;
  const total = v.length;
  if (total < 30 || !(qa > 0) || !(uInf > 0)) return null;
  // 時間の後半を使う
  const tStart = t[0] + 0.5 * (t[total - 1] - t[0]);
  let s = 0;
  while (s < total - 1 && t[s] < tStart) s++;
  if (total - s < 15) return null;
  let mean = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = s; k < total; k++) {
    mean += v[k];
    lo = Math.min(lo, v[k]);
    hi = Math.max(hi, v[k]);
  }
  mean /= total - s;
  const amp = hi - lo;
  if (amp / qa < 0.05) return null;

  const band = 0.15 * amp;
  const cross: number[] = [];
  let armed = false;
  for (let k = s + 1; k < total; k++) {
    const a = v[k - 1] - mean;
    const b = v[k] - mean;
    if (b < -band) armed = true;
    if (armed && a <= 0 && b > 0) {
      cross.push(t[k - 1] + ((t[k] - t[k - 1]) * -a) / (b - a));
      armed = false;
    }
  }
  if (cross.length < 3) return null;
  const periods: number[] = [];
  for (let k = 1; k < cross.length; k++) periods.push(cross[k] - cross[k - 1]);
  const med = [...periods].sort((x, y) => x - y)[Math.floor(periods.length / 2)];
  if (periods.some((p) => Math.abs(p - med) > 0.3 * med)) return null;
  const period = (cross[cross.length - 1] - cross[0]) / (cross.length - 1);
  return length / (uInf * period);
}

/** 後半の平均（t が最後の frac の部分） */
function tailMean(t: number[], v: number[], frac: number): number {
  if (v.length === 0) return 0;
  const t0 = t[v.length - 1] - frac * (t[v.length - 1] - t[0]);
  let sum = 0;
  let count = 0;
  for (let k = 0; k < v.length; k++) {
    if (t[k] >= t0) {
      sum += v[k];
      count++;
    }
  }
  return count ? sum / count : v[v.length - 1];
}

export function buildFlowResult(inp: FlowResultInput): ResultSet {
  const { nx, ny, h, cellToRaster, U, p, rho, uInf, length, thickness } = inp;
  const n = nx * ny;
  const speed = new Float32Array(n);
  const ux = new Float32Array(n);
  const uy = new Float32Array(n);
  const press = new Float32Array(n);
  const vort = new Float32Array(n);
  const mask = new Uint8Array(n);
  if (U.size !== 3 || p.size !== 1 || U.n !== cellToRaster.length || p.n !== cellToRaster.length) {
    throw new Error(`結果のセル数が合いません（U: ${U.n}、p: ${p.n}、メッシュ: ${cellToRaster.length}）`);
  }
  for (let c = 0; c < cellToRaster.length; c++) {
    const r = cellToRaster[c];
    const vx = U.data[3 * c];
    const vy = U.data[3 * c + 1];
    ux[r] = vx;
    uy[r] = vy;
    speed[r] = Math.hypot(vx, vy);
    press[r] = p.data[c] * rho; // 動圧基準の圧力 [Pa]（出口を 0 とした相対値）
    mask[r] = 1;
  }
  // 渦度 ω = ∂uy/∂x - ∂ux/∂y（中心差分、端は片側差分。物体内部の速度は 0 = Lite と同じ）
  for (let j = 0; j < ny; j++) {
    const jm = j > 0 ? j - 1 : j;
    const jp = j < ny - 1 ? j + 1 : j;
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      if (!mask[idx]) continue;
      const im = i > 0 ? i - 1 : i;
      const ip = i < nx - 1 ? i + 1 : i;
      const dvdx = (uy[j * nx + ip] - uy[j * nx + im]) / ((ip - im) * h);
      const dudy = (ux[jp * nx + i] - ux[jm * nx + i]) / ((jp - jm) * h);
      vort[idx] = dvdx - dudy;
    }
  }
  const fields: Field[] = [
    { key: 'speed', label: '流速', unit: 'm/s', data: speed, mask },
    { key: 'ux', label: '流速 x', unit: 'm/s', data: ux, mask },
    { key: 'uy', label: '流速 y', unit: 'm/s', data: uy, mask },
    { key: 'pressure', label: '圧力', unit: 'Pa', data: press, mask, diverging: true },
    { key: 'vorticity', label: '渦度', unit: '1/s', data: vort, mask, diverging: true },
  ];

  // 力: OpenFOAM はメッシュの奥行き分 → project.thickness 分に直す（Lite と同じ「厚さ込みの N」）
  const k = thickness / inp.meshDepth;
  const f = inp.forces;
  const dragH = f.fx.map((v) => v * k);
  const liftH = f.fy.map((v) => v * k);
  const last = f.t.length - 1;
  const drag = last >= 0 ? dragH[last] : 0;
  const lift = last >= 0 ? liftH[last] : 0;
  const qa = 0.5 * rho * uInf * uInf * length * thickness; // 動圧 × 代表面積
  const steady = inp.model === 'rans';
  const tailFrac = steady ? 0.1 : 0.5;
  const dragMean = tailMean(f.t, dragH, tailFrac);
  const liftRms = (() => {
    if (last < 0 || steady) return 0;
    const m = tailMean(f.t, liftH, tailFrac);
    const t0 = f.t[last] - tailFrac * (f.t[last] - f.t[0]);
    let s = 0;
    let c = 0;
    for (let q = 0; q <= last; q++) {
      if (f.t[q] >= t0) {
        s += (liftH[q] - m) ** 2;
        c++;
      }
    }
    return c ? Math.sqrt(s / c) : 0;
  })();

  const Re = (uInf * length) / inp.nu;
  const scalars: ScalarValue[] = [
    { key: 'Re', label: 'レイノルズ数', unit: '', value: Re },
    { key: 'drag', label: '抗力', unit: 'N', value: drag },
    { key: 'lift', label: '揚力', unit: 'N', value: lift },
    { key: 'Cd', label: '抗力係数', unit: '', value: qa > 0 ? drag / qa : 0 },
    { key: 'Cl', label: '揚力係数', unit: '', value: qa > 0 ? lift / qa : 0 },
    { key: 'time', label: steady ? '反復回数' : '経過時間', unit: steady ? '' : 's', value: inp.endTime },
    { key: 'CdMean', label: steady ? '抗力係数（最後の 10% の平均）' : '抗力係数（後半の平均）', unit: '', value: qa > 0 ? dragMean / qa : 0 },
  ];
  if (!steady) scalars.push({ key: 'ClRms', label: '揚力係数の振れ（後半の標準偏差）', unit: '', value: qa > 0 ? liftRms / qa : 0 });
  if (!steady) {
    const st = estimateStrouhal({ t: f.t, lift: liftH, qa, length, uInf });
    if (st !== null) scalars.push({ key: 'strouhal', label: 'ストローハル数', unit: '', value: st });
  }

  const idx = thin(Array.from({ length: f.t.length }, (_, q) => q), HISTORY_MAX);
  const history: History[] = [
    { key: 'drag', label: '抗力', unit: 'N', t: idx.map((q) => f.t[q]), values: idx.map((q) => dragH[q]) },
    { key: 'lift', label: '揚力', unit: 'N', t: idx.map((q) => f.t[q]), values: idx.map((q) => liftH[q]) },
  ];

  const warnings: string[] = [`OpenFOAM（${inp.solver}、${MODEL_LABEL[inp.model]}）で解きました（格子 ${nx} × ${ny}）。`];
  warnings.push(...(inp.warnings ?? []));
  warnings.push('2D の計算です。実際の流れは奥行き方向にも乱れるため、高い Re では抗力・渦の大きさが実物と異なります。');
  if (inp.model === 'les') {
    warnings.push('2D の LES は乱流の再現としては定性的です（本来の LES は 3D で行います）。傾向の確認に使ってください。');
  }
  if (inp.model === 'rans') {
    warnings.push('定常の RANS です。渦放出のような時間変化は出ません。階段状の物体表面の影響で、揚力・抗力は目安です。');
  }
  if (last < 0) warnings.push('力の履歴を読めませんでした（抗力・揚力は 0 になっています）。');

  return { analysis: 'flow', nx, ny, h, fields, scalars, history, warnings };
}
