// 熱解析の CalculiX 入力（.inp）。定常熱伝導（*HEAT TRANSFER, STEADY STATE）。単位は SI（m, W, K ではなく °C のまま）。

import type { HeatMesh } from './heat-mesh';

const num = (x: number): string => (Number.isFinite(x) ? String(Number(x.toPrecision(12))) : '0');

function listLines(ids: ArrayLike<number>): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += 16) {
    const row: number[] = [];
    for (let k = i; k < Math.min(ids.length, i + 16); k++) row.push(ids[k]);
    out.push(row.join(', '));
  }
  return out;
}

export function writeHeatInp(mesh: HeatMesh, opts: { title?: string } = {}): string {
  const L: string[] = ['** Studio M Engine が書いた CalculiX の入力（熱伝導。単位: m, W, °C）'];
  if (opts.title) L.push(`** ${opts.title.replace(/[\r\n]+/g, ' ')}`);
  L.push('*HEADING', 'Studio M heat conduction');

  L.push('*NODE, NSET=NALL');
  for (let n = 1; n <= mesh.nodeCount; n++) {
    const o = 3 * (n - 1);
    L.push(`${n}, ${num(mesh.coords[o])}, ${num(mesh.coords[o + 1])}, ${num(mesh.coords[o + 2])}`);
  }
  L.push('*ELEMENT, TYPE=DC3D8, ELSET=EALL');
  for (let e = 0; e < mesh.elementCell.length; e++) {
    const row = [e + 1];
    for (let a = 0; a < 8; a++) row.push(mesh.connectivity[8 * e + a]);
    L.push(row.join(', '));
  }

  // 熱伝導率ごとの要素集合・材料（面内 kx = ky、板厚方向 kz）
  mesh.conductivity.forEach((g, i) => {
    L.push(`*ELSET, ELSET=EK${i + 1}`, ...listLines(g.elements));
    L.push(`*MATERIAL, NAME=MK${i + 1}`, '*CONDUCTIVITY, TYPE=ORTHO', `${num(g.kx)}, ${num(g.ky)}, ${num(g.kz)}`);
    L.push(`*SOLID SECTION, ELSET=EK${i + 1}, MATERIAL=MK${i + 1}`);
  });

  // 固定温度（温度ごとに節点集合を作る）
  const byTemp = new Map<number, number[]>();
  for (const [node, temp] of mesh.fixedNodes) {
    const list = byTemp.get(temp);
    if (list) list.push(node);
    else byTemp.set(temp, [node]);
  }
  const temps = [...byTemp.keys()].sort((a, b) => a - b);
  temps.forEach((temp, i) => {
    L.push(`*NSET, NSET=NT${i + 1}`, ...listLines((byTemp.get(temp) as number[]).sort((a, b) => a - b)));
  });
  if (mesh.fixedNodes.size > 0) L.push('*NSET, NSET=NFIX', ...listLines([...mesh.fixedNodes.keys()].sort((a, b) => a - b)));

  mesh.heatGroups.forEach((g, i) => L.push(`*ELSET, ELSET=EQ${i + 1}`, ...listLines(g.elements)));
  mesh.films.forEach((g, i) => L.push(`*ELSET, ELSET=EF${i + 1}`, ...listLines(g.elements)));

  L.push('*STEP', '*HEAT TRANSFER, STEADY STATE', '1., 1.');
  if (temps.length > 0) {
    L.push('*BOUNDARY');
    temps.forEach((temp, i) => L.push(`NT${i + 1}, 11, 11, ${num(temp)}`));
  }
  if (mesh.heatGroups.length > 0) {
    L.push('*DFLUX');
    mesh.heatGroups.forEach((g, i) => L.push(`EQ${i + 1}, BF, ${num(g.qv)}`));
  }
  if (mesh.films.length > 0) {
    L.push('*FILM');
    mesh.films.forEach((g, i) => L.push(`EF${i + 1}, F${g.face}, ${num(g.sink)}, ${num(g.h)}`));
  }

  // 出力: .dat は読み取り用（節点温度・固定温度の節点の熱の出入り・要素の熱流束）、.frd は ParaView / CGX 用
  L.push('*NODE PRINT, NSET=NALL', 'NT');
  if (mesh.fixedNodes.size > 0) L.push('*NODE PRINT, NSET=NFIX, TOTALS=ONLY', 'RFL');
  L.push('*EL PRINT, ELSET=EALL', 'HFL');
  L.push('*NODE FILE', 'NT, RFL', '*EL FILE', 'HFL', '*END STEP');
  return L.join('\n') + '\n';
}
