// 3D モデル（STL / OBJ）の取り込み（v0.6）の入口。
// 画面から使うときは import-dialog を遅延 import すること（CLAUDE.md の「重いモジュールは遅延 import」）。
export { openMeshImport } from './import-dialog';
export type { MeshImportOptions, MeshImportResult } from './import-dialog';
export { parseMeshFile, formatOf } from './load';
export type { MeshFormat } from './load';
export { parseStl } from './stl';
export { parseObj } from './obj';
export { analyzeMesh, cleanMesh, checkWatertight, meshBounds, meshVolume, weldVertices } from './mesh';
export type { MeshInfo, CleanReport, WatertightReport } from './mesh';
export { sliceMesh, sliceAxes, sectionSegments3D } from './slice';
export type { SliceOptions, SliceResult, SliceLoop } from './slice';
export { buildMeshProject, domainMargins } from './build';
export type { BuildOptions, BuildResult } from './build';
export { MeshParseError, AXIS_NAMES, UNIT_LABEL, UNIT_TO_M } from './types';
export type { TriMesh, Box3, Axis, LengthUnit } from './types';
