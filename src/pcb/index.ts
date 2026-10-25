// KiCad 基板の取り込み（v0.4）の入口。
// 画面から使うときは import-dialog を遅延 import すること（CLAUDE.md の「重いモジュールは遅延 import」）。
export { openPcbImport } from './import-dialog';
export type { PcbImportOptions, PcbImportResult } from './import-dialog';
export { parseKicadPcb, KicadParseError } from './kicad';
export type { KicadBoard, KicadFootprint, KicadCopperLayer, ParseOptions } from './kicad';
export { buildPcbProject, assignParts } from './build';
export type { BuildOptions, BuildResult, PartAssignment, PartOverride } from './build';
export { PART_LIBRARY, matchPart } from './parts';
export type { PartLibraryEntry, PartMatch } from './parts';
