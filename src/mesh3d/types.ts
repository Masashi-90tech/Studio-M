// 3D モデル取り込み（v0.6）で使う共通の型。DOM にも他の層にも依存しない。

/** 三角形メッシュ。positions は x, y, z の並び（頂点 1 個につき 3 要素）、indices は三角形ごとに頂点番号 3 個 */
export interface TriMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** 3D の外接箱（モデルの単位のまま） */
export interface Box3 {
  min: [number, number, number];
  max: [number, number, number];
}

/** 切る軸（0 = X、1 = Y、2 = Z） */
export type Axis = 0 | 1 | 2;

export const AXIS_NAMES = ['X', 'Y', 'Z'] as const;

/** モデルの単位。長さを m にするときの倍率は UNIT_TO_M */
export type LengthUnit = 'mm' | 'm' | 'inch';

export const UNIT_TO_M: Record<LengthUnit, number> = { mm: 1e-3, m: 1, inch: 0.0254 };

export const UNIT_LABEL: Record<LengthUnit, string> = { mm: 'mm', m: 'm', inch: 'inch' };

/** 取り込みで扱う三角形の数の上限（これを超えるとブラウザのメモリが足りなくなる） */
export const MAX_TRIANGLES = 5_000_000;

/** 読み取りの失敗。メッセージは「何が悪いか」が分かる日本語で、そのまま画面に出す */
export class MeshParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeshParseError';
  }
}
