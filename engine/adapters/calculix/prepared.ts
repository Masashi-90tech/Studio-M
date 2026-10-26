// 強度解析の「メッシュの作り方の違い」を、解く流れ（stress.ts）から切り離すための約束。
// 格子（Lite と同じ正方格子 + CPS4 など）と、gmsh（形に沿った三角形 CPS6）は、どちらもこの形で返す。
// 解く流れは、.inp を書く → ccx を走らせる → map で結果にする、だけを知っていればよい。

import type { ResultSet } from '../../../src/core/types';
import type { SolveOutput } from '../../types';
import type { InpMesh } from './inp';
import type { MappedResults } from './results';

export interface PreparedMesh {
  /** .inp を書くメッシュ */
  inpMesh: InpMesh;
  /** 要素の種類の名前（ログ・見出し用。例: CPS4、CPS6） */
  elementLabel: string;
  /** メッシュを言うときの呼び方（利用者向けの文言用。格子 / メッシュ） */
  meshWord: string;
  elementCount: number;
  /** 解析に含めた荷重の大きさの合計（自重を除く）。0 で自重もなければ解けない */
  appliedLoad: number;
  /** 自重を入れたか */
  selfWeight: boolean;
  /** .dat に積分点の座標（COORD）も出すか */
  integrationPointCoords: boolean;
  /** ログに 1 行 */
  logLine: string;
  /** 見出し（warnings の 2 つ目から）: メッシュの作り方の説明 */
  intro: string[];
  /** メッシュを作ったときに気づいたこと（支持されていない部品など） */
  meshWarnings: string[];
  /** 結果の格子 */
  grid: { nx: number; ny: number; h: number; thickness: number; mask: Uint8Array };
  /** 利用者に渡すファイル（.inp・.frd・.vtk のほかに） */
  extraFiles: SolveOutput['files'];
  /** .dat の文字列と、読んだブロックから、結果の場と代表値にする */
  map(datText: string, opts: { plasticity: boolean; loadScale?: number }): MappedResults;
  toResultSet(mapped: MappedResults, warnings: string[]): ResultSet;
}
