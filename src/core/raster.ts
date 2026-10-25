import { getMaterial } from './materials';
import type { PcbInfo, Project, Raster, ShapeGeom } from './types';

export function gridSize(project: Project): { nx: number; ny: number; h: number } {
  const nx = project.domain.nx;
  const h = project.domain.width / nx;
  const ny = Math.max(1, Math.round(project.domain.height / h));
  return { nx, ny, h };
}

export function containsPoint(g: ShapeGeom, x: number, y: number): boolean {
  switch (g.kind) {
    case 'rect':
      return x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h;
    case 'circle': {
      const dx = x - g.cx;
      const dy = y - g.cy;
      return dx * dx + dy * dy <= g.r * g.r;
    }
    case 'polygon': {
      // 偶奇規則のレイキャスト
      const p = g.points;
      let inside = false;
      for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
        const [xa, ya] = p[a];
        const [xb, yb] = p[b];
        if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
      }
      return inside;
    }
  }
}

/** 形状をセル中心で判定して格子化する */
export function rasterize(project: Project): Raster {
  const { nx, ny, h } = gridSize(project);
  const n = nx * ny;
  const r: Raster = {
    nx,
    ny,
    h,
    solid: new Uint8Array(n),
    materialId: new Array<string | null>(n).fill(null),
    heatGen: new Float32Array(n),
    fixedTemp: new Float32Array(n).fill(NaN),
    support: new Uint8Array(n),
    loadFx: new Float32Array(n),
    loadFy: new Float32Array(n),
    shapeIndex: new Int32Array(n).fill(-1),
  };
  const shapeIndex = r.shapeIndex!;

  const cellsOf = (g: ShapeGeom): number[] => {
    const cells: number[] = [];
    for (let j = 0; j < ny; j++) {
      const y = (j + 0.5) * h;
      for (let i = 0; i < nx; i++) {
        if (containsPoint(g, (i + 0.5) * h, y)) cells.push(j * nx + i);
      }
    }
    return cells;
  };

  // 物体と発熱を先に確定させてから、荷重を最終的な物体セルへ配分する
  const loads: { cells: number[]; fx: number; fy: number }[] = [];
  const cellVolume = h * h * project.thickness;

  for (const [index, s] of project.shapes.entries()) {
    const cells = cellsOf(s.geom);
    switch (s.role) {
      case 'solid':
      case 'heatSource': {
        const q = s.role === 'heatSource' && cells.length > 0 ? (s.heatW ?? 0) / (cells.length * cellVolume) : 0;
        for (const c of cells) {
          r.solid[c] = 1;
          r.materialId[c] = s.materialId;
          r.heatGen[c] = q;
          shapeIndex[c] = index;
        }
        break;
      }
      case 'hole':
        for (const c of cells) {
          r.solid[c] = 0;
          r.materialId[c] = null;
          r.heatGen[c] = 0;
          shapeIndex[c] = -1;
        }
        break;
      case 'fixedTemp':
        for (const c of cells) r.fixedTemp[c] = s.tempC ?? 20;
        break;
      case 'support':
        for (const c of cells) r.support[c] = 1;
        break;
      case 'load':
        loads.push({ cells, fx: s.force?.fx ?? 0, fy: s.force?.fy ?? 0 });
        break;
    }
  }

  for (const l of loads) {
    // 物体に重なったセルだけに配分する。どこにも物体がなければ荷重は掛からない
    const target = l.cells.filter((c) => r.solid[c]);
    if (target.length === 0) continue;
    for (const c of target) {
      r.loadFx[c] += l.fx / target.length;
      r.loadFy[c] += l.fy / target.length;
    }
  }

  if (project.pcb) r.kEff = copperConductivity(project.pcb, r);
  return r;
}

/** 銅箔の被覆率を数えるときの、1 セルあたりの標本数（一辺） */
const COPPER_SAMPLES = 2;

/**
 * 基板の面内の実効熱伝導率。板厚方向に並んだ基材と銅箔を、厚さで重み付けした平均にする。
 *   k_eff = (k_基材 × (T − Σ t_銅 × 被覆率) + Σ k_銅 × t_銅 × 被覆率) / T
 * 物体のないセルは NaN（材料の k を使う）
 */
export function copperConductivity(pcb: PcbInfo, r: Pick<Raster, 'nx' | 'ny' | 'h' | 'solid'>): Float32Array {
  const { nx, ny, h, solid } = r;
  const n = nx * ny;
  const T = pcb.boardThicknessMm * 1e-3;
  const kSub = getMaterial(pcb.substrateId).k;
  const kCu = getMaterial('c1100').k;
  const copperKt = new Float64Array(n); // Σ k_銅 × t_銅 × 被覆率
  const copperT = new Float64Array(n); // Σ t_銅 × 被覆率
  const cover = new Float32Array(n);
  const step = h / COPPER_SAMPLES;
  const perSample = 1 / (COPPER_SAMPLES * COPPER_SAMPLES);

  for (const layer of pcb.layers) {
    const t = layer.thicknessUm * 1e-6;
    cover.fill(0);
    for (const points of layer.polygons) {
      if (points.length < 3) continue;
      // 多角形の外接矩形の中だけを調べる
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of points) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      const geom: ShapeGeom = { kind: 'polygon', points };
      const i0 = Math.max(0, Math.floor(x0 / h)), i1 = Math.min(nx - 1, Math.floor(x1 / h));
      const j0 = Math.max(0, Math.floor(y0 / h)), j1 = Math.min(ny - 1, Math.floor(y1 / h));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const c = j * nx + i;
          if (!solid[c] || cover[c] >= 1) continue;
          let hits = 0;
          for (let sj = 0; sj < COPPER_SAMPLES; sj++) {
            for (let si = 0; si < COPPER_SAMPLES; si++) {
              if (containsPoint(geom, i * h + (si + 0.5) * step, j * h + (sj + 0.5) * step)) hits++;
            }
          }
          // 重なった多角形で 100% を超えないようにする
          cover[c] = Math.min(1, cover[c] + hits * perSample);
        }
      }
    }
    for (let c = 0; c < n; c++) {
      if (cover[c] > 0) {
        copperKt[c] += kCu * t * cover[c];
        copperT[c] += t * cover[c];
      }
    }
  }

  const kEff = new Float32Array(n).fill(NaN);
  for (let c = 0; c < n; c++) {
    if (!solid[c]) continue;
    kEff[c] = (kSub * Math.max(0, T - copperT[c]) + copperKt[c]) / T;
  }
  return kEff;
}
