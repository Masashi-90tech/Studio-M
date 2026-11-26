# 形状ワーカーの純粋な部品。OCP（OCCT）を import しない（単体テストを OCP なしで走らせるため）。
# ここにあるもの: 長さの単位の確定、面の種類の分類、署名、面の ID の振り方。
from __future__ import annotations

import hashlib
from typing import Dict, List, Optional, Tuple

# STEP の長さの単位（OCCT の STEPControl_Reader.FileUnits が返す名前）→ (短い名前, メートルへの換算係数)
# 名前は大文字小文字を区別しない。SI の接頭辞つきは "millimetre" のように返り、
# CONVERSION_BASED_UNIT は "INCH" のようにファイルに書かれた名前で返る。
_UNITS: Dict[str, Tuple[str, float]] = {
    'micrometre': ('um', 1e-6),
    'millimetre': ('mm', 1e-3),
    'centimetre': ('cm', 1e-2),
    'metre': ('m', 1.0),
    'kilometre': ('km', 1e3),
    'inch': ('in', 0.0254),
    'foot': ('ft', 0.3048),
}
# 利用者が --length-unit に書く短い名前と別名
_ALIASES: Dict[str, str] = {
    'um': 'micrometre', 'micrometer': 'micrometre',
    'mm': 'millimetre', 'millimeter': 'millimetre',
    'cm': 'centimetre', 'centimeter': 'centimetre',
    'm': 'metre', 'meter': 'metre',
    'km': 'kilometre', 'kilometer': 'kilometre',
    'in': 'inch', 'inches': 'inch',
    'ft': 'foot', 'feet': 'foot',
}


class UnitError(Exception):
    """単位を確定できないときの例外。メッセージはそのまま利用者に見せる日本語。"""


def _canonical(name: str) -> Optional[str]:
    n = name.strip().lower()
    if n in _UNITS:
        return n
    return _ALIASES.get(n)


def resolve_length_unit(file_unit: Optional[str], override: Optional[str] = None) -> Tuple[str, float]:
    """STEP が持つ長さの単位（file_unit）と、利用者の指定（override）から、(短い名前, メートルへの係数) を返す。

    - ファイルが単位を持ち、指定がないか同じ → ファイルの単位
    - ファイルが単位を持たない（None・空）→ 指定が必須
    - ファイルの単位と指定が食い違う → エラー（黙ってどちらかを選ぶと、寸法が 25 倍や 1000 倍ずれるため）
    """
    file_c = _canonical(file_unit) if file_unit else None
    if file_unit and file_c is None:
        raise UnitError(f'STEP の長さの単位「{file_unit}」には対応していません。mm・m・inch などの単位で書き出し直してください')
    over_c = None
    if override:
        over_c = _canonical(override)
        if over_c is None:
            raise UnitError(f'指定された単位「{override}」には対応していません（{", ".join(sorted(_ALIASES))} などが使えます）')
    if file_c is None and over_c is None:
        raise UnitError('STEP の長さの単位を読み取れません。単位を指定してください（例: --length-unit mm）')
    if file_c is not None and over_c is not None and file_c != over_c:
        raise UnitError(f'STEP の単位は {_UNITS[file_c][0]} ですが、{_UNITS[over_c][0]} が指定されました。'
                        '指定を外すか、ファイルの単位に合わせてください')
    name = file_c or over_c
    short, to_m = _UNITS[name]  # type: ignore[index]
    return short, to_m


def classify_surface(geom_abs_name: str) -> str:
    """OCCT の GeomAbs_SurfaceType の名前（例 'GeomAbs_Plane'）を、契約の種類名にする。"""
    n = geom_abs_name.split('.')[-1].replace('GeomAbs_', '').lower()
    if n in ('plane', 'cylinder', 'cone', 'sphere', 'torus'):
        return n
    if n in ('beziersurface', 'bsplinesurface'):
        return 'bspline'
    return 'other'


def _r(x: float, digits: int) -> float:
    # -0.0 を 0.0 にそろえる（署名の文字列が変わらないように）
    return round(x, digits) + 0.0


# 署名と並べ替えに使う丸め。長さはメートルで 1e-7（0.1 マイクロメートル）、面積は 1e-9 m²
LEN_DIGITS = 7
AREA_DIGITS = 9
SORT_DIGITS = 6  # 並べ替えの比較は少し粗くする（丸めの境目で順序が入れ替わりにくくする）


def make_signature(face: dict) -> str:
    """種類・面積・重心・外接する箱・隣の面の数 を丸めて連結する。同じ面なら同じ値になる。"""
    c = ','.join(f'{_r(v, LEN_DIGITS):.7f}' for v in face['centroid'])
    b = ','.join(f'{_r(v, LEN_DIGITS):.7f}' for v in face['bbox'])
    return f"{face['type']}:{_r(face['area'], AREA_DIGITS):.9f}:{c}:{b}:{face['neighbors']}"


def assign_ids(faces: List[dict]) -> List[dict]:
    """面を決定的な順序（種類 → 重心 → 面積）に並べ替え、F1… の ID と署名を振って返す。

    位相の走査順は読み込みごとに変わりうるので使わない。入力の faces は 'type'・'area'・'centroid'・
    'bbox'・'neighbors' を持つ（長さはメートル）。入力は変更しない。
    """
    def key(f: dict):
        return (f['type'], tuple(_r(v, SORT_DIGITS) for v in f['centroid']), _r(f['area'], SORT_DIGITS))

    out = []
    for i, f in enumerate(sorted(faces, key=key), start=1):
        g = dict(f)
        g['id'] = f'F{i}'
        g['signature'] = make_signature(g)
        out.append(g)
    return out


def scale_face(face: dict, to_m: float) -> dict:
    """読み込んだ単位の面を、メートルの面にする（面積は 2 乗で換算）。"""
    g = dict(face)
    g['area'] = face['area'] * to_m * to_m
    g['centroid'] = [v * to_m for v in face['centroid']]
    g['bbox'] = [v * to_m for v in face['bbox']]
    return g


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()
