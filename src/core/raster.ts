import type { Project, Raster, ShapeGeom } from './types';

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
  };

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

  for (const s of project.shapes) {
    const cells = cellsOf(s.geom);
    switch (s.role) {
      case 'solid':
      case 'heatSource': {
        const q = s.role === 'heatSource' && cells.length > 0 ? (s.heatW ?? 0) / (cells.length * cellVolume) : 0;
        for (const c of cells) {
          r.solid[c] = 1;
          r.materialId[c] = s.materialId;
          r.heatGen[c] = q;
        }
        break;
      }
      case 'hole':
        for (const c of cells) {
          r.solid[c] = 0;
          r.materialId[c] = null;
          r.heatGen[c] = 0;
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
  return r;
}
