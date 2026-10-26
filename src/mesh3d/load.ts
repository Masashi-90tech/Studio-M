// ファイル名と中身から、STL か OBJ かを見分けて読む。DOM に依存しない。
import { parseObj } from './obj';
import { parseStl } from './stl';
import { MeshParseError, type TriMesh } from './types';

export type MeshFormat = 'stl' | 'obj';

/** ファイル名から形式を決める。分からなければ undefined */
export function formatOf(name: string): MeshFormat | undefined {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  const ext = m?.[1].toLowerCase();
  return ext === 'stl' || ext === 'obj' ? ext : undefined;
}

/** 中身から形式を当てる（拡張子が当てにならないとき用） */
function sniff(bytes: Uint8Array): MeshFormat | undefined {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 2048)));
  if (/^\s*solid\b/i.test(head) && /facet|vertex/i.test(head)) return 'stl';
  if (/^\s*v\s/m.test(head)) return 'obj';
  return undefined;
}

/** STL / OBJ を読む。読めないときは MeshParseError（日本語の理由つき） */
export function parseMeshFile(name: string, data: ArrayBuffer | Uint8Array): TriMesh {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const format = formatOf(name) ?? sniff(bytes);
  if (!format) {
    const dot = /\.([^./\\]+)$/.exec(name)?.[1];
    throw new MeshParseError(
      `「${name}」は読めない形式です${dot ? `（.${dot}）` : ''}。STL（.stl）か OBJ（.obj）のファイルを選んでください。STEP・glTF・Blender のファイルは、STL か OBJ で書き出してから開いてください。`,
    );
  }
  if (format === 'stl') return parseStl(bytes);
  return parseObj(new TextDecoder('utf-8').decode(bytes));
}
