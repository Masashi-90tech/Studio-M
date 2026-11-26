# メッシュワーカーの純粋な部品。gmsh・OCP を import しない（単体テストを gmsh なしで走らせるため）。
# ここにあるもの: 選択（名前つき）の検査、Gmsh の面と形状ワーカーの面の突き合わせ、品質の集計、
# 節点・要素の番号付け、CalculiX の .inp の書き出し。長さはすべてメートル。
from __future__ import annotations

import math
import re
from typing import Dict, Iterable, List, Sequence, Tuple

NAME_RE = re.compile(r'^[A-Z][A-Z0-9_]*$')
NAME_MAX = 80  # CalculiX の集合名の長さの上限


class MeshInputError(Exception):
    """入力（選択・面の対応）の誤り。メッセージはそのまま利用者に見せる日本語。"""


def validate_name(name: object) -> str:
    """選択の名前を検査する。.inp の NSET 名にそのまま使うので、英大文字で始まり、英大文字・数字・_ だけ。"""
    if not isinstance(name, str) or not NAME_RE.match(name) or len(name) > NAME_MAX:
        raise MeshInputError(
            f'選択の名前「{name}」は使えません。英大文字で始まり、英大文字・数字・_ だけの名前（例: FIXED, LOAD_1）にしてください'
            f'（{NAME_MAX} 文字まで）')
    return name


def parse_selections(doc: dict) -> Tuple[List[dict], List[dict]]:
    """selections.json の中身を検査して (選択の一覧, 面の一覧) を返す。選んだ面の ID が面の一覧になければエラー。"""
    if not isinstance(doc, dict) or not isinstance(doc.get('selections'), list) or not isinstance(doc.get('faces'), list):
        raise MeshInputError('selections.json の形が正しくありません。{"selections": [...], "faces": [...]} の形にしてください'
                             '（faces は形状ワーカーの inspect の faces をそのまま入れます）')
    faces = doc['faces']
    ids = set()
    for f in faces:
        for k in ('id', 'area', 'centroid'):
            if not isinstance(f, dict) or k not in f:
                raise MeshInputError(f'faces の要素に {k} がありません。形状ワーカーの inspect の faces をそのまま入れてください')
        ids.add(f['id'])
    seen = set()
    sels = []
    for s in doc['selections']:
        name = validate_name(s.get('name') if isinstance(s, dict) else None)
        if name in seen:
            raise MeshInputError(f'選択の名前「{name}」が重複しています。名前は 1 つずつにしてください')
        seen.add(name)
        fids = s.get('faceIds')
        if not isinstance(fids, list) or not fids or not all(isinstance(i, str) for i in fids):
            raise MeshInputError(f'選択「{name}」に面がありません。faceIds に面の ID（例 "F3"）を 1 つ以上入れてください')
        for i in fids:
            if i not in ids:
                raise MeshInputError(f'選択「{name}」の面 {i} が、形状の面の一覧にありません。STEP を読み直して ID を確かめてください')
        sels.append({'name': name, 'faceIds': list(dict.fromkeys(fids))})
    return sels, faces


def match_faces(gmsh_faces: Sequence[dict], shape_faces: Sequence[dict], length_scale: float,
                rel_tol: float = 1e-6, abs_area_tol: float = 1e-12) -> Dict[str, List[int]]:
    """形状ワーカーの面（id・area・centroid）に、Gmsh の面（tag・area・centroid）を、面積と重心の一致で結ぶ。

    返すのは {面の ID: 一致した Gmsh の面の tag の一覧}。1 対 1 なら長さ 1、見つからなければ空、
    曖昧なら 2 つ以上（呼び出し側が検査する）。length_scale は形状の代表の長さ（バウンディングボックスの対角など）で、
    重心の許容 rel_tol * length_scale に使う。面積の許容は rel_tol の相対 + abs_area_tol。
    """
    out: Dict[str, List[int]] = {}
    c_tol = rel_tol * max(length_scale, 1e-12)
    for sf in shape_faces:
        hits = []
        for gf in gmsh_faces:
            if abs(gf['area'] - sf['area']) > rel_tol * abs(sf['area']) + abs_area_tol:
                continue
            if math.dist(gf['centroid'], sf['centroid']) > c_tol:
                continue
            hits.append(gf['tag'])
        out[sf['id']] = hits
    return out


def check_one_to_one(matches: Dict[str, List[int]], needed: Iterable[str]) -> Dict[str, int]:
    """選んだ面（needed）が、Gmsh の面とちょうど 1 つずつ対応しているか確かめ、{面の ID: tag} を返す。"""
    used: Dict[int, str] = {}
    for fid, tags in matches.items():
        if len(tags) == 1:
            used.setdefault(tags[0], fid)
    result: Dict[str, int] = {}
    for fid in needed:
        tags = matches.get(fid, [])
        if len(tags) == 0:
            raise MeshInputError(f'選んだ面 {fid} が、メッシュ側の面と対応しません。STEP が形状の読み込みのときと同じファイルか、'
                                 '単位が合っているか確認してください')
        if len(tags) > 1:
            raise MeshInputError(f'選んだ面 {fid} が、メッシュ側の複数の面（{tags}）に対応してしまいます。'
                                 '同じ形・同じ位置の面が重なっていないか確認してください')
        # 別の ID が同じ tag に結ばれていないか
        others = [f for f, t in matches.items() if f != fid and t == tags]
        if others:
            raise MeshInputError(f'選んだ面 {fid} と {others[0]} が、メッシュ側の同じ面に対応してしまいます。面の取り違えを避けるため中止します')
        result[fid] = tags[0]
    return result


def area_check(shape_areas: Sequence[float], mesh_areas: Sequence[float]) -> dict:
    """選択した面の面積の合計（形状ワーカーの値）と、メッシュ側（Gmsh の測度）の合計の、相対差。"""
    a, b = sum(shape_areas), sum(mesh_areas)
    return {'shape': a, 'mesh': b, 'relDiff': abs(a - b) / a if a > 0 else 0.0}


def summarize_quality(values: Sequence[float], threshold: float = 0.1, metric: str = 'minSICN') -> dict:
    """要素の品質（minSICN など。1 に近いほど良い）の最小・平均と、しきい値より悪い要素の数。"""
    n = len(values)
    return {
        'metric': metric, 'min': min(values) if n else None,
        'mean': (sum(values) / n) if n else None,
        'threshold': threshold, 'badCount': sum(1 for v in values if v < threshold), 'count': n,
    }


# Gmsh の 10 節点四面体と CalculiX の C3D10 は、節点 9・10 の順序が違う。
#   Gmsh : 0-3 が頂点、4=辺(0,1)、5=辺(1,2)、6=辺(2,0)、7=辺(0,3)、8=辺(2,3)、9=辺(1,3)
#   CalculiX: 1-4 が頂点、5=辺(1,2)、6=辺(2,3)、7=辺(3,1)、8=辺(1,4)、9=辺(2,4)、10=辺(3,4)  （1 始まり）
#   つまり 0 始まりで CalculiX の 9 番目は辺(1,3) = Gmsh の 9、10 番目は辺(2,3) = Gmsh の 8。
# よって Gmsh の並びから最後の 2 つを入れ替える。入れ替えないと要素の体積が負（または歪み）になり、
# CalculiX が「negative jacobian」で止まるか、答えが間違う。実験 4 の試作は Gmsh 自身の .inp 書き出しを使い、
# そこで同じ入れ替えが行われていた。ここは自前で書くので、同じ入れ替えを明示する。
GMSH_TET10_TO_CCX = (0, 1, 2, 3, 4, 5, 6, 7, 9, 8)
# 1 次の四面体（C3D4）は同じ並び
GMSH_TET4_TO_CCX = (0, 1, 2, 3)


def reorder_tet(nodes: Sequence[int], order: int) -> List[int]:
    perm = GMSH_TET10_TO_CCX if order == 2 else GMSH_TET4_TO_CCX
    if len(nodes) != len(perm):
        raise MeshInputError(f'四面体の節点が {len(nodes)} 個です（{len(perm)} 個のはず）。--order と Gmsh の要素の種類が合っていません')
    return [nodes[i] for i in perm]


def renumber(tet_nodes: Sequence[Sequence[int]]) -> Tuple[List[int], List[List[int]]]:
    """要素の節点の tag を、1 から始まる連番にする。節点の番号は元の tag の小さい順。
    返すのは (使われた元の tag を小さい順に並べた一覧, 連番にした要素の節点)。節点の新しい番号 = 一覧の位置 + 1。"""
    used = sorted({n for e in tet_nodes for n in e})
    new = {t: i + 1 for i, t in enumerate(used)}
    return used, [[new[n] for n in e] for e in tet_nodes]


def _wrap(ids: Sequence[int], per_line: int = 16) -> str:
    return '\n'.join(', '.join(str(i) for i in ids[k:k + per_line]) for k in range(0, len(ids), per_line))


def write_inp(path: str, coords: Sequence[Sequence[float]], elements: Sequence[Sequence[int]],
              nsets: Dict[str, Sequence[int]], order: int = 2, header: str = '') -> None:
    """節点・要素・節点集合・要素集合（EALL）だけの .inp を書く。節点・要素の番号は 1 から。
    coords[i] が節点 i+1 の座標（メートル）。elements は CalculiX の並びにした節点番号（1 始まり）。
    材料・境界条件・ステップは書かない（Engine の側で足す）。"""
    etype = 'C3D10' if order == 2 else 'C3D4'
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(f'** Studio M メッシュワーカー（長さの単位: m）{header}\n')
        f.write('*NODE\n')
        for i, (x, y, z) in enumerate(coords, start=1):
            f.write(f'{i}, {x:.12e}, {y:.12e}, {z:.12e}\n')
        f.write(f'*ELEMENT, TYPE={etype}\n')
        for i, e in enumerate(elements, start=1):
            # 1 行に書ける項目は 16 個まで。続きの行は、前の行をコンマで終える
            head = ', '.join(str(n) for n in e[:7])
            if len(e) > 7:
                f.write(f'{i}, {head},\n{", ".join(str(n) for n in e[7:])}\n')
            else:
                f.write(f'{i}, {head}\n')
        for name, ids in nsets.items():
            validate_name(name)
            f.write(f'*NSET, NSET={name}\n{_wrap(sorted(set(ids)))}\n')
        f.write('*ELSET, ELSET=EALL\n')
        f.write(_wrap(list(range(1, len(elements) + 1))) + '\n')
