# 円孔のある平板の検証（plate_check.py）の純粋な部品。標準ライブラリだけで書き、OCP・gmsh・ccx なしで単体テストできる。
# ここにあるもの: 応力集中係数の計算、.inp の組み立て（材料・境界条件・荷重・ステップ）、.dat / .frd の読み取り、合否の判定。
# 単位はメートル・ニュートン・パスカル（メッシュワーカーの .inp はメートル）。
from __future__ import annotations

import re
from typing import Dict, List, Optional, Sequence

# 試験体（make-test-plate の既定。mm）。穴の中心は板の中央
LENGTH_MM, WIDTH_MM, THICKNESS_MM, HOLE_MM = 400.0, 100.0, 10.0, 20.0
E_PA, NU = 210e9, 0.3
LOAD_N = 50000.0  # 合計荷重 P。公称応力 50 MPa（降伏よりずっと下で、線形の範囲）

KT_REFERENCE = 3.149  # 有限幅の円孔平板、総断面基準、d/W = 0.2（実験 4 と同じ目安）
KT_TOLERANCE = 0.03   # 3% 以内（docs/EXPERIMENT-4.md の合格の目安）
BALANCE_TOLERANCE = 0.01
AREA_TOLERANCE = 0.01
BBOX_TOLERANCE_M = 1e-6


def kt_reference_gross(width: float, hole: float) -> float:
    """文献の近似式（Peterson）。総断面（幅 × 厚み）で割った公称応力に対する係数。d/W = 0.2 で 3.149。"""
    r = hole / width
    kt_net = 2 + 0.284 * (1 - r) - 0.6 * (1 - r) ** 2 + 1.32 * (1 - r) ** 3
    return kt_net / (1 - r)


def kt_reference_net(width: float, hole: float) -> float:
    """同じ近似式の、正味断面（（幅 − 穴径）× 厚み）基準の係数。d/W = 0.2 で 2.519。"""
    r = hole / width
    return 2 + 0.284 * (1 - r) - 0.6 * (1 - r) ** 2 + 1.32 * (1 - r) ** 3


def nominal_stress(load: float, width: float, thickness: float, hole: float = 0.0) -> float:
    """公称応力 [Pa]。hole = 0 なら総断面、穴径を渡せば正味断面で割る。"""
    return load / ((width - hole) * thickness)


def stress_concentration(sigma_max: float, load: float, width: float, thickness: float, hole: float = 0.0) -> float:
    """応力集中係数 = 最大応力 ÷ 公称応力。"""
    return sigma_max / nominal_stress(load, width, thickness, hole)


def rel_diff(actual: float, expected: float) -> float:
    if expected == 0:
        return abs(actual)
    return abs(actual - expected) / abs(expected)


def last_json_line(text: str) -> Optional[dict]:
    """標準出力の最後の { で始まる行を JSON として読む（ワーカーの約束。OCCT が途中に統計を出すため）。読めなければ None。"""
    import json
    lines = [l.strip() for l in text.splitlines() if l.strip().startswith('{')]
    if not lines:
        return None
    try:
        return json.loads(lines[-1])
    except ValueError:
        return None


def pick_plane_face(faces: Sequence[dict], axis: int, value: float, tol: float = 1e-9) -> dict:
    """軸に垂直な平面（axis 方向の位置が value）の面を 1 つ選ぶ。0 個か 2 個以上なら ValueError。"""
    hits = [f for f in faces if f.get('type') == 'plane'
            and abs(f['centroid'][axis] - value) < tol
            and abs(f['bbox'][axis] - value) < tol and abs(f['bbox'][axis + 3] - value) < tol]
    if len(hits) != 1:
        raise ValueError(f'位置 {value} の平面を 1 つに決められません（{len(hits)} 個見つかりました）。試験体の STEP が想定どおりか確認してください')
    return hits[0]


def parse_nset_nodes(inp_text: str, name: str) -> List[int]:
    """メッシュの .inp から、名前つきの節点集合の節点番号を読む（*NSET, NSET=NAME の次の行から、次の * まで）。"""
    nodes: List[int] = []
    inside = False
    for line in inp_text.splitlines():
        if line.startswith('*'):
            m = re.match(r'\*NSET\s*,\s*NSET\s*=\s*([A-Za-z0-9_]+)', line, re.I)
            inside = bool(m) and m.group(1).upper() == name.upper()
            continue
        if inside:
            nodes += [int(t) for t in line.replace(',', ' ').split() if t.strip()]
    if not nodes:
        raise ValueError(f'メッシュの .inp に節点集合 {name} がありません。メッシュワーカーの選択に {name} を入れたか確認してください')
    return sorted(set(nodes))


def build_job_inp(mesh_inp: str, load_nodes: Sequence[int], load_n: float = LOAD_N,
                  e_pa: float = E_PA, nu: float = NU) -> str:
    """メッシュの .inp に、材料・境界条件・荷重・静解析のステップを足して、ccx に渡せる .inp にする。
    荷重は、LOAD 面の節点の x 方向の変位を 1 つの節点に束ね（*EQUATION）、その節点に合計荷重 P を掛ける。
    節点ごとに等分した力は 2 次の四面体では不釣り合いで、荷重面の近くに応力の偏りが出るため（束ねれば面が平らなまま引かれる）。
    FIXED 面は 3 方向を拘束する（実験 4 と同じ）。"""
    if len(load_nodes) < 2:
        raise ValueError('LOAD 面の節点が 2 個未満です。メッシュを確認してください')
    ref = load_nodes[0]
    eqs = ''.join(f'2\n{n}, 1, 1., {ref}, 1, -1.\n' for n in load_nodes[1:])
    body = mesh_inp if mesh_inp.endswith('\n') else mesh_inp + '\n'
    return body + f"""*MATERIAL, NAME=STEEL
*ELASTIC
{e_pa:.6e}, {nu}
*SOLID SECTION, ELSET=EALL, MATERIAL=STEEL
*EQUATION
{eqs}*STEP
*STATIC
*BOUNDARY
FIXED, 1, 3, 0.
*CLOAD
{ref}, 1, {load_n:.9e}
*NODE PRINT, NSET=FIXED, TOTALS=ONLY
RF
*EL PRINT, ELSET=EALL
S
*NODE FILE
U
*EL FILE
S
*END STEP
"""


_NUM = r'[-+]?\d*\.?\d+(?:[EeDd][-+]?\d+)?'


def parse_total_force(dat: str) -> float:
    """.dat の「total force (fx,fy,fz)」の次の数値行の fx [N]。見つからなければ ValueError。"""
    m = re.search(r'total force \(fx,fy,fz\)[^\n]*\n\s*\n\s*(' + _NUM + ')', dat)
    if not m:
        raise ValueError('.dat に反力の合計がありません。CalculiX が最後まで計算できたか、job.log を確認してください')
    return float(m.group(1))


def parse_max_sxx_integration_point(dat: str) -> float:
    """.dat の積分点の応力表（elem, integ.pnt., sxx, syy, szz, sxy, sxz, syz）から、σ_xx の最大 [Pa]。"""
    parts = dat.split('stresses (elem, integ.pnt.')
    if len(parts) < 2:
        raise ValueError('.dat に応力の表がありません。*EL PRINT の指定と、CalculiX のログを確認してください')
    best = None
    for line in parts[1].splitlines()[2:]:
        cols = line.split()
        if len(cols) != 8:
            if best is not None and line.strip() == '':
                break  # 表の終わり（空行）
            continue
        try:
            v = float(cols[2])
        except ValueError:
            continue
        best = v if best is None or v > best else best
    if best is None:
        raise ValueError('.dat の応力の表を読めませんでした。CalculiX のバージョンの出力形式を確認してください')
    return best


def parse_frd_max_sxx(lines) -> float:
    """.frd（行の反復可能なもの）の節点応力ブロックから σ_xx の最大 [Pa]。
    見出しに入力のパスが入り、日本語の途中で切られて不正な UTF-8 になることがある（実験 4）。呼ぶ側で errors='replace' で開く。"""
    best, inside = None, False
    for l in lines:
        if l.startswith(' -4  STRESS'):
            inside = True
        elif l.startswith(' -3'):
            inside = False
        elif inside and l.startswith(' -1'):
            v = float(l[13:25])
            best = v if best is None or v > best else best
    if best is None:
        raise ValueError('.frd に節点の応力がありません。*NODE FILE / *EL FILE の指定を確認してください')
    return best


def evaluate_checks(kt: float, reaction_n: float, load_n: float, areas: Dict[str, float],
                    bboxes: Dict[str, Sequence[float]], expected_bbox: Sequence[float]) -> List[dict]:
    """合格の条件をすべて検査して、{name, ok, value, expected, tolerance} の一覧にする（途中で止めない）。
    bboxes は {"形状ワーカー": [...], "メッシュ": [...]} のように、どこで測った bbox かを名前で渡す。"""
    checks: List[dict] = []
    d = rel_diff(kt, KT_REFERENCE)
    checks.append({'name': '応力集中係数が 3.149 の 3% 以内', 'ok': d <= KT_TOLERANCE,
                   'value': kt, 'expected': KT_REFERENCE, 'relDiff': d, 'tolerance': KT_TOLERANCE})
    d = rel_diff(abs(reaction_n), load_n)
    checks.append({'name': '反力が荷重と 1% 以内で釣り合う', 'ok': d <= BALANCE_TOLERANCE,
                   'value': abs(reaction_n), 'expected': load_n, 'relDiff': d, 'tolerance': BALANCE_TOLERANCE})
    for name, rd in areas.items():
        checks.append({'name': f'選択 {name} の面積の照合が 1% 以内', 'ok': rd <= AREA_TOLERANCE,
                       'value': rd, 'expected': 0.0, 'tolerance': AREA_TOLERANCE})
    for where, bbox in bboxes.items():
        worst = max((abs(a - b) for a, b in zip(bbox, expected_bbox)), default=float('inf'))
        ok = len(bbox) == len(expected_bbox) and worst <= BBOX_TOLERANCE_M
        checks.append({'name': f'bbox（{where}）が 0.4 × 0.1 × 0.01 m', 'ok': ok,
                       'value': list(bbox), 'expected': list(expected_bbox), 'tolerance': BBOX_TOLERANCE_M})
    return checks
