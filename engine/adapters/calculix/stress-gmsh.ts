// 強度解析のメッシュを、gmsh で作る「形に沿った」ものにする（オプション mesher = gmsh）。
//
// 流れ: 形（shapes）→ gmsh（gmsh/mesh2d.ts。2 次の三角形）→ CalculiX 用のメッシュ（gmsh-mesh.ts）
//       →（stress.ts が .inp を書いて ccx を走らせる）→ 結果を Lite と同じ格子に戻す（gmsh-results.ts）。
// 要素の寸法は、Lite と同じ格子の h（quality に応じて細かくなる）。曲線は曲率に応じて、さらに細かく切る。

import type { Project } from '../../../src/core/types';
import { gridSize } from '../../../src/core/raster';
import { generateShapedMesh } from '../gmsh/mesh2d';
import { GEO_FILE, MSH_FILE } from '../gmsh/mesh2d';
import type { AdapterContext } from '../../types';
import { parseDat } from './dat';
import { buildShapedMesh } from './gmsh-mesh';
import { mapShapedResults, toShapedResultSet } from './gmsh-results';
import { MAX_SHAPED_ELEMENTS } from './options';
import type { PreparedMesh } from './prepared';

export async function prepareShaped(args: { project: Project; ctx: AdapterContext; selfWeight: boolean }): Promise<PreparedMesh> {
  const { project, ctx, selfWeight } = args;
  const { nx, ny, h } = gridSize(project);
  ctx.progress(0.02, 'gmsh で形に沿ったメッシュを作っています', 'meshing');
  const { mesh: raw, size, coarsened } = await generateShapedMesh(ctx, { project, size: h, curvatureCount: 20, maxElements: MAX_SHAPED_ELEMENTS });
  const mesh = buildShapedMesh({ project, gmsh: raw, grid: { nx, ny, h }, selfWeight });

  const sizeMm = Number((size * 1000).toPrecision(3));
  const intro = [
    `gmsh で形に沿ったメッシュ（要素数 ${mesh.elementCount.toLocaleString('ja-JP')}、2 次の三角形）を作りました。要素の寸法は約 ${sizeMm} mm で、曲線のまわりはさらに細かく切っています。`,
    `結果は Lite と同じ ${nx} × ${ny} セルの格子に戻して表示します（最大値は、格子に戻す前の節点の値です）。`,
  ];
  if (coarsened) intro.push(`要素数の上限（${MAX_SHAPED_ELEMENTS.toLocaleString('ja-JP')}）のため、要素の寸法を大きくしました。`);

  return {
    inpMesh: mesh,
    elementLabel: mesh.elementType,
    meshWord: 'メッシュ',
    elementCount: mesh.elementCount,
    appliedLoad: mesh.appliedLoad,
    selfWeight,
    integrationPointCoords: true,
    logLine: `要素 ${mesh.elementCount}（${mesh.elementType}・gmsh）、節点 ${mesh.nodeCount}、結果の格子 ${nx}×${ny}`,
    intro,
    meshWarnings: mesh.warnings,
    grid: { nx, ny, h, thickness: mesh.thickness, mask: mesh.included },
    extraFiles: [
      { name: GEO_FILE, description: 'gmsh の形状（メッシュを作る入力）' },
      { name: MSH_FILE, description: 'gmsh のメッシュ（msh 2.2。gmsh や ParaView で開けます）' },
    ],
    map: (datText, o) => mapShapedResults(mesh, datText, parseDat(datText), o),
    toResultSet: (mapped, warnings) => toShapedResultSet(mesh, mapped, warnings),
  };
}
