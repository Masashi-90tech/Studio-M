// 3D 解析（v0.6。3D モデルをそのまま解く）の入口。
// 画面から使うときは screen を遅延 import すること（CLAUDE.md の「重いモジュールは遅延 import」。入口は src/ui/sim3d-open.ts）。
export { openSim3D } from './screen';
export type { Sim3DHandle, Sim3DOptions } from './screen';
export { Sim3DModel } from './model';
export { addRegion, removeRegion, updateRegion, studySignature } from './regions';
export { buildFaceGraph, raycastMesh, selectConnectedFaces } from './faces';
export { heatVerdict3D } from './verdict';
