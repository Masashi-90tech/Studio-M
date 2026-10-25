// CalculiX の入力ファイル（.inp）を書く。
//
// 単位は SI（m, N, Pa, kg）のまま。2D の平面応力要素（CPS4 など）を使い、厚さは *SOLID SECTION で与える。
// 構成: 節点 → 要素 → 材料ごとの要素集合 → 材料 → 断面 → 拘束 → ステップ（荷重・出力要求）。

import { GRAVITY, type Mesh } from './mesh';

export interface InpOptions {
  /** 塑性（*PLASTIC）を入れるか。入れると荷重を増分で少しずつ掛ける */
  plasticity: boolean;
  largeDeformation: boolean;
  /** 荷重全体に掛ける倍率（塑性の「どこまで増やすか」。通常は 1） */
  loadScale: number;
  /** 降伏後の硬化係数（E に対する割合 [%]） */
  hardeningPercent: number;
  selfWeight: boolean;
  /** 先頭に入れる説明（日本語可。ccx は読み飛ばす） */
  title?: string;
}

/** 数値を ccx が読める形にする（有効数字 12 桁） */
const num = (x: number): string => (Number.isFinite(x) ? String(Number(x.toPrecision(12))) : '0');

/** 番号を 1 行 16 個ずつの行にする */
function listLines(ids: ArrayLike<number>): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += 16) {
    const row: number[] = [];
    for (let k = i; k < Math.min(ids.length, i + 16); k++) row.push(ids[k]);
    out.push(row.join(', '));
  }
  return out;
}

export function writeInp(mesh: Mesh, opts: InpOptions): string {
  const L: string[] = [];
  const t = mesh.thickness;
  L.push('** Studio M Engine が書いた CalculiX の入力（単位: m, N, Pa, kg）');
  if (opts.title) L.push(`** ${opts.title.replace(/[\r\n]+/g, ' ')}`);
  L.push('*HEADING', 'Studio M plane stress');

  // ----- 節点 -----
  L.push('*NODE, NSET=NALL');
  for (let n = 1; n <= mesh.nodeCount; n++) {
    L.push(`${n}, ${num(mesh.coords[2 * (n - 1)])}, ${num(mesh.coords[2 * (n - 1) + 1])}, 0`);
  }

  // ----- 要素 -----
  L.push(`*ELEMENT, TYPE=${mesh.elementType}, ELSET=EALL`);
  const nElem = mesh.elementCell.length;
  const npe = mesh.nodesPerElement;
  for (let e = 0; e < nElem; e++) {
    const row = [e + 1];
    for (let a = 0; a < npe; a++) row.push(mesh.connectivity[e * npe + a]);
    L.push(row.join(', '));
  }
  for (const m of mesh.materials) {
    L.push(`*ELSET, ELSET=E${m.name}`, ...listLines(m.elements));
  }
  if (mesh.supportNodes.length > 0) L.push('*NSET, NSET=NSUP', ...listLines(mesh.supportNodes));

  // ----- 材料と断面 -----
  for (const m of mesh.materials) {
    const E = m.material.E ?? 2e9;
    const nu = Math.min(0.49, Math.max(0, m.material.nu ?? 0.3));
    L.push(`*MATERIAL, NAME=${m.name}`, '*ELASTIC', `${num(E)}, ${num(nu)}`, '*DENSITY', num(m.material.rho));
    const y = m.material.yield;
    if (opts.plasticity && y !== undefined && y > 0) {
      // 完全弾塑性（硬化 0%）か、E の数 % の傾きで硬化する材料。点は降伏点と、ひずみ 100% の点の 2 つ
      const tangent = (opts.hardeningPercent / 100) * E;
      L.push('*PLASTIC', `${num(y)}, 0`, `${num(y + tangent * 1.0)}, 1`);
    }
    L.push(`*SOLID SECTION, ELSET=E${m.name}, MATERIAL=${m.name}`, num(t));
  }

  // ----- 拘束 -----
  if (mesh.supportNodes.length > 0) L.push('*BOUNDARY', 'NSUP, 1, 2');

  // ----- ステップ -----
  const nonlinear = opts.plasticity || opts.largeDeformation;
  L.push(`*STEP${opts.largeDeformation ? ', NLGEOM' : ''}${nonlinear ? ', INC=1000' : ''}`);
  L.push('*STATIC');
  // 増分: 初め 5%、成功が続けば最大 10%、収束しなければ自動で小さくする（最小 1e-6）
  if (nonlinear) L.push('0.05, 1., 1e-6, 0.1');
  const s = opts.loadScale;
  if (mesh.nodalLoads.size > 0) {
    L.push('*CLOAD');
    for (const [n, f] of [...mesh.nodalLoads.entries()].sort((a, b) => a[0] - b[0])) {
      if (f.fx !== 0) L.push(`${n}, 1, ${num(f.fx * s)}`);
      if (f.fy !== 0) L.push(`${n}, 2, ${num(f.fy * s)}`);
    }
  }
  if (opts.selfWeight) L.push('*DLOAD', `EALL, GRAV, ${num(GRAVITY * s)}, 0., -1., 0.`);

  // 出力: .dat は読み取り用（節点変位・支持の反力・要素の応力など）、.frd は ParaView / CGX 用
  L.push('*NODE PRINT, NSET=NALL', 'U');
  if (mesh.supportNodes.length > 0) L.push('*NODE PRINT, NSET=NSUP, TOTALS=ONLY', 'RF');
  L.push('*EL PRINT, ELSET=EALL', opts.plasticity ? 'S, PEEQ' : 'S');
  L.push('*NODE FILE', 'U, RF');
  L.push('*EL FILE', opts.plasticity ? 'S, PEEQ' : 'S');
  L.push('*END STEP');
  return L.join('\n') + '\n';
}
