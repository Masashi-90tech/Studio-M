// プロジェクトの形（shapes）から、gmsh の形状ファイル（.geo）を組み立てる。純粋な関数だけ（gmsh は呼ばない）。
//
// 形の約束は types.ts の ShapeRole と同じ:
//   - shapes を順に適用し、後のものが前のものを上書きする（solid / heatSource は物体、hole は削る）
//   - support / load は物体を作らず、範囲だけを持つ
//
// 作り方: 関係する形をぜんぶ面（Rectangle / Disk / 多角形）にして、BooleanFragments でひとつながりに分割する。
// 分割された面は、境界が互いにぴったり合ったメッシュになる（材料の境目・穴の縁・支持や荷重の範囲の縁に節点が並ぶ）。
// 「どの面が物体か・どの材料か・支持や荷重の範囲か」は、メッシュの要素の中心の点で TS 側が判定する
// （classify の関数。要素は分割された面の中にあるので、中心の判定が要素全体の判定になる）。
// 形の名前などプロジェクトの文字列は .geo に書かない（形の番号と役割だけ）。

import { containsPoint } from '../../../src/core/raster';
import type { Project, Shape, ShapeGeom } from '../../../src/core/types';

/** 形が物体になる役割か */
export const isBodyRole = (role: Shape['role']): boolean => role === 'solid' || role === 'heatSource';

const ROLE_LABEL: Partial<Record<Shape['role'], string>> = { solid: '固体', heatSource: '発熱体', hole: '穴', support: '支持', load: '荷重' };

/** 点 (x, y) で、最後に塗った solid / heatSource の形の番号。hole が最後なら（または何もなければ）-1 */
export function bodyShapeAt(project: Project, x: number, y: number): number {
  let found = -1;
  for (let i = 0; i < project.shapes.length; i++) {
    const s = project.shapes[i];
    if (s.role === 'solid' || s.role === 'heatSource') {
      if (containsPoint(s.geom, x, y)) found = i;
    } else if (s.role === 'hole') {
      if (containsPoint(s.geom, x, y)) found = -1;
    }
  }
  return found;
}

/** 点が領域（domain）の中か。結果の格子は領域の中だけなので、外は解析に含めない */
export function inDomain(project: Project, x: number, y: number): boolean {
  return x >= 0 && x <= project.domain.width && y >= 0 && y <= project.domain.height;
}

// ---------- 形の寸法 ----------

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function geomBox(g: ShapeGeom): Box {
  switch (g.kind) {
    case 'rect':
      return { x0: Math.min(g.x, g.x + g.w), y0: Math.min(g.y, g.y + g.h), x1: Math.max(g.x, g.x + g.w), y1: Math.max(g.y, g.y + g.h) };
    case 'circle':
      return { x0: g.cx - g.r, y0: g.cy - g.r, x1: g.cx + g.r, y1: g.cy + g.r };
    case 'polygon': {
      const b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const [x, y] of g.points) {
        b.x0 = Math.min(b.x0, x);
        b.y0 = Math.min(b.y0, y);
        b.x1 = Math.max(b.x1, x);
        b.y1 = Math.max(b.y1, y);
      }
      return b;
    }
  }
}

const overlaps = (a: Box, b: Box, tol: number): boolean => a.x0 <= b.x1 + tol && b.x0 <= a.x1 + tol && a.y0 <= b.y1 + tol && b.y0 <= a.y1 + tol;

function polygonArea(points: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  return a / 2;
}

/** 形の面積 [m²]。使えない形（幅 0・半径 0・頂点が 3 つ未満）は 0 */
export function geomArea(g: ShapeGeom): number {
  switch (g.kind) {
    case 'rect':
      return g.w > 0 && g.h > 0 ? g.w * g.h : 0;
    case 'circle':
      return g.r > 0 ? Math.PI * g.r * g.r : 0;
    case 'polygon':
      return Math.abs(polygonArea(cleanPolygon(g.points)));
  }
}

/** 多角形の頂点から、同じ点の連続と、終点が始点と同じ点を除く */
export function cleanPolygon(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = out[out.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    out.push([x, y]);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

/** gmsh に渡せる形か（面積があるか） */
const usable = (g: ShapeGeom): boolean => geomArea(g) > 0;

// ---------- .geo ----------

export interface GeoOptions {
  project: Project;
  /** 要素の代表寸法（辺の長さ）[m] */
  size: number;
  /** これより小さい要素は作らない [m]。省略時は size の 1/10 */
  minSize?: number;
  /** 曲線 1 周あたりの要素数の目安（曲率に応じた細分化）。省略時 20 */
  curvatureCount?: number;
}

export interface GeoPlan {
  geo: string;
  /** .geo に書いた形の番号（project.shapes の添字） */
  shapeIndexes: number[];
  /** 領域（domain）の矩形も分割に加えたか（物体が領域の外にはみ出すとき） */
  usesDomain: boolean;
  /** 物体（solid / heatSource）の面積の合計 [m²]。重なりは二重に数える（要素数の見積もり用の上限） */
  bodyAreaUpper: number;
}

/** 数値を .geo に書く形にする（有効数字 15 桁。-0 は 0） */
const num = (x: number): string => {
  const v = Number(x.toPrecision(15));
  return Object.is(v, -0) ? '0' : String(v);
};

/**
 * .geo の文章を作る。形の面（物体・穴・支持・荷重）を作り、BooleanFragments でまとめて分割し、メッシュの設定を書く。
 * 解析に関係しない形（物体と重ならない穴・支持・荷重）は入れない。
 * 物体がひとつもなければ空の shapeIndexes を返す（呼び出し側がエラーにする）
 */
export function buildGeo(opts: GeoOptions): GeoPlan {
  const { project } = opts;
  const size = opts.size;
  if (!(size > 0) || !Number.isFinite(size)) throw new Error('メッシュの寸法が正しくありません');
  const minSize = opts.minSize ?? size / 10;
  const curvature = Math.max(6, Math.round(opts.curvatureCount ?? 20));
  const tol = size * 1e-6;

  // 関係する形を選ぶ: 物体はすべて。穴は、それより前の物体と重なるものだけ。支持・荷重は、物体のどれかと重なるものだけ
  const include: number[] = [];
  const bodyBoxes: Box[] = [];
  const allBodyBoxes: Box[] = project.shapes.filter((s) => isBodyRole(s.role) && usable(s.geom)).map((s) => geomBox(s.geom));
  let bodyAreaUpper = 0;
  for (let i = 0; i < project.shapes.length; i++) {
    const s = project.shapes[i];
    if (!usable(s.geom)) continue;
    const box = geomBox(s.geom);
    if (isBodyRole(s.role)) {
      include.push(i);
      bodyBoxes.push(box);
      bodyAreaUpper += geomArea(s.geom);
    } else if (s.role === 'hole') {
      if (bodyBoxes.some((b) => overlaps(b, box, tol))) include.push(i);
    } else if (s.role === 'support' || s.role === 'load') {
      if (allBodyBoxes.some((b) => overlaps(b, box, tol))) include.push(i);
    }
  }
  const hasBody = include.some((i) => isBodyRole(project.shapes[i].role));
  if (!hasBody) return { geo: '', shapeIndexes: [], usesDomain: false, bodyAreaUpper: 0 };

  // 物体が領域の外にはみ出すときだけ、領域の矩形でも分割する（外側は解析に含めない）
  const { width, height } = project.domain;
  const usesDomain = bodyBoxes.some((b) => b.x0 < -tol || b.y0 < -tol || b.x1 > width + tol || b.y1 > height + tol);

  const L: string[] = [];
  L.push('// Studio M Engine が書いた gmsh の形状（単位: m）', 'SetFactory("OpenCASCADE");');
  const surfaces: string[] = [];
  const addSurface = (index: number | 'domain', geom: ShapeGeom | { kind: 'domain' }): void => {
    const v = `sf${surfaces.length}`;
    const label = index === 'domain' ? '領域' : `形 ${index + 1}（${ROLE_LABEL[project.shapes[index].role] ?? '?'}）`;
    L.push(`// ${label}`);
    switch (geom.kind) {
      case 'domain':
        L.push(`${v} = news; Rectangle(${v}) = {0, 0, 0, ${num(width)}, ${num(height)}};`);
        break;
      case 'rect': {
        const b = geomBox(geom);
        L.push(`${v} = news; Rectangle(${v}) = {${num(b.x0)}, ${num(b.y0)}, 0, ${num(b.x1 - b.x0)}, ${num(b.y1 - b.y0)}};`);
        break;
      }
      case 'circle':
        L.push(`${v} = news; Disk(${v}) = {${num(geom.cx)}, ${num(geom.cy)}, 0, ${num(geom.r)}, ${num(geom.r)}};`);
        break;
      case 'polygon': {
        const pts = cleanPolygon(geom.points);
        const ps = pts.map((_, k) => `${v}p${k}`);
        pts.forEach(([x, y], k) => L.push(`${ps[k]} = newp; Point(${ps[k]}) = {${num(x)}, ${num(y)}, 0};`));
        const ls = pts.map((_, k) => `${v}l${k}`);
        pts.forEach((_, k) => L.push(`${ls[k]} = newl; Line(${ls[k]}) = {${ps[k]}, ${ps[(k + 1) % pts.length]}};`));
        L.push(`${v}c = newll; Curve Loop(${v}c) = {${ls.join(', ')}};`, `${v} = news; Plane Surface(${v}) = {${v}c};`);
        break;
      }
    }
    surfaces.push(v);
  };
  for (const i of include) addSurface(i, project.shapes[i].geom);
  if (usesDomain) addSurface('domain', { kind: 'domain' });

  if (surfaces.length > 1) L.push(`BooleanFragments{ Surface{${surfaces.join(', ')}}; Delete; }{}`);

  L.push(
    '// メッシュの設定: 2 次の三角形（辺の中点にも節点）、曲率に応じた細分化',
    `Mesh.MeshSizeMax = ${num(size)};`,
    `Mesh.MeshSizeMin = ${num(minSize)};`,
    `Mesh.MeshSizeFromCurvature = ${curvature};`,
    'Mesh.ElementOrder = 2;',
    'Mesh.Algorithm = 6;',
  );
  return { geo: L.join('\n') + '\n', shapeIndexes: include, usesDomain, bodyAreaUpper };
}
