# メッシュワーカーの純粋な部品の単体テスト（gmsh なしで走る）。
import pytest

import mesh_lib


def test_validate_name():
    assert mesh_lib.validate_name('FIXED') == 'FIXED'
    assert mesh_lib.validate_name('LOAD_1') == 'LOAD_1'
    for bad in ('fixed', '1ABC', 'A-B', 'A B', '', 'Ａ', None, 5, 'A' * 81):
        with pytest.raises(mesh_lib.MeshInputError, match='選択の名前'):
            mesh_lib.validate_name(bad)


FACES = [{'id': 'F1', 'area': 0.001, 'centroid': [0, 0.05, 0.005], 'bbox': [0, 0, 0, 0, 0.1, 0.01]},
         {'id': 'F2', 'area': 0.001, 'centroid': [0.4, 0.05, 0.005], 'bbox': [0.4, 0, 0, 0.4, 0.1, 0.01]}]


def test_parse_selections_ok():
    sels, faces = mesh_lib.parse_selections({'selections': [{'name': 'FIXED', 'faceIds': ['F1', 'F1']}], 'faces': FACES})
    assert sels == [{'name': 'FIXED', 'faceIds': ['F1']}] and faces == FACES


@pytest.mark.parametrize('doc,msg', [
    ({}, '形が正しくありません'),
    ({'selections': [{'name': 'a', 'faceIds': ['F1']}], 'faces': FACES}, '選択の名前'),
    ({'selections': [{'name': 'A', 'faceIds': ['F1']}, {'name': 'A', 'faceIds': ['F2']}], 'faces': FACES}, '重複'),
    ({'selections': [{'name': 'A', 'faceIds': []}], 'faces': FACES}, '面がありません'),
    ({'selections': [{'name': 'A', 'faceIds': ['F9']}], 'faces': FACES}, '面の一覧にありません'),
    ({'selections': [], 'faces': [{'id': 'F1'}]}, 'area がありません'),
])
def test_parse_selections_errors(doc, msg):
    with pytest.raises(mesh_lib.MeshInputError, match=msg):
        mesh_lib.parse_selections(doc)


def gf(tag, area, c):
    return {'tag': tag, 'area': area, 'centroid': list(c)}


def test_match_faces_one_to_one_with_tolerance():
    g = [gf(7, 0.001 * (1 + 1e-9), (1e-9, 0.05, 0.005)), gf(3, 0.001, (0.4, 0.05, 0.005))]
    m = mesh_lib.match_faces(g, FACES, length_scale=0.4)
    assert m == {'F1': [7], 'F2': [3]}
    assert mesh_lib.check_one_to_one(m, ['F1', 'F2']) == {'F1': 7, 'F2': 3}


def test_match_faces_unit_mismatch_is_not_matched():
    # Gmsh が mm のまま読んだ場合（400 など）は、どの面にも対応しない
    g = [gf(1, 1000.0, (0, 50, 5)), gf(2, 1000.0, (400, 50, 5))]
    m = mesh_lib.match_faces(g, FACES, length_scale=0.4)
    assert m == {'F1': [], 'F2': []}
    with pytest.raises(mesh_lib.MeshInputError, match='選んだ面 F1 が、メッシュ側の面と対応しません'):
        mesh_lib.check_one_to_one(m, ['F1'])


def test_check_one_to_one_ambiguous():
    g = [gf(1, 0.001, (0, 0.05, 0.005)), gf(2, 0.001, (0, 0.05, 0.005))]
    m = mesh_lib.match_faces(g, FACES, length_scale=0.4)
    with pytest.raises(mesh_lib.MeshInputError, match='複数の面'):
        mesh_lib.check_one_to_one(m, ['F1'])


def test_check_one_to_one_two_ids_one_tag():
    m = {'F1': [5], 'F2': [5]}
    with pytest.raises(mesh_lib.MeshInputError, match='同じ面に対応'):
        mesh_lib.check_one_to_one(m, ['F1'])


def test_only_needed_faces_are_required():
    m = {'F1': [1], 'F2': []}
    assert mesh_lib.check_one_to_one(m, ['F1']) == {'F1': 1}


def test_area_check():
    r = mesh_lib.area_check([0.001, 0.002], [0.003 * 1.02])
    assert r['relDiff'] == pytest.approx(0.02)
    assert r['shape'] == pytest.approx(0.003)


def test_summarize_quality():
    q = mesh_lib.summarize_quality([0.5, 0.05, 0.9, -0.1])
    assert q['min'] == -0.1 and q['badCount'] == 2 and q['count'] == 4 and q['metric'] == 'minSICN'
    assert mesh_lib.summarize_quality([])['min'] is None


def test_reorder_tet10_midside_nodes_follow_calculix_convention():
    # 頂点 P0..P3 と、Gmsh の並び（4=辺01, 5=辺12, 6=辺20, 7=辺03, 8=辺23, 9=辺13）で、辺の中点の節点を作る
    P = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)]
    mid = lambda a, b: tuple((P[a][k] + P[b][k]) / 2 for k in range(3))
    gmsh_pos = P + [mid(0, 1), mid(1, 2), mid(2, 0), mid(0, 3), mid(2, 3), mid(1, 3)]
    out = [gmsh_pos[i] for i in mesh_lib.reorder_tet(list(range(10)), 2)]
    # CalculiX: 5=辺(1,2) 6=辺(2,3) 7=辺(3,1) 8=辺(1,4) 9=辺(2,4) 10=辺(3,4)（1 始まり）
    expected = P + [mid(0, 1), mid(1, 2), mid(2, 0), mid(0, 3), mid(1, 3), mid(2, 3)]
    assert out == expected


def test_reorder_tet4_and_wrong_size():
    assert mesh_lib.reorder_tet([5, 6, 7, 8], 1) == [5, 6, 7, 8]
    with pytest.raises(mesh_lib.MeshInputError, match='節点が 4 個'):
        mesh_lib.reorder_tet([1, 2, 3, 4], 2)


def test_renumber_starts_at_one_and_keeps_order():
    used, els = mesh_lib.renumber([[10, 30, 20, 40], [20, 30, 40, 50]])
    assert used == [10, 20, 30, 40, 50]
    assert els == [[1, 3, 2, 4], [2, 3, 4, 5]]


def test_write_inp(tmp_path):
    coords = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)] + [(0.5, 0, 0)] * 6
    p = tmp_path / 'm.inp'
    mesh_lib.write_inp(str(p), coords, [list(range(1, 11))], {'FIXED': [3, 1, 1, 2], 'LOAD': [4]})
    txt = p.read_text(encoding='utf-8')
    lines = txt.splitlines()
    assert '*NODE' in lines and '*ELEMENT, TYPE=C3D10' in lines
    assert '*NSET, NSET=FIXED' in lines and '1, 2, 3' in lines  # 重複なし・昇順
    assert '*NSET, NSET=LOAD' in lines
    assert '*ELSET, ELSET=EALL' in lines
    assert lines[lines.index('*ELSET, ELSET=EALL') + 1] == '1'
    assert '1, 1, 2, 3, 4, 5, 6, 7,' in lines and '8, 9, 10' in lines
    # 材料・境界条件・ステップは書かない
    for kw in ('*MATERIAL', '*BOUNDARY', '*STEP', '*SOLID SECTION'):
        assert kw not in txt


def test_write_inp_wraps_long_sets_and_rejects_bad_names(tmp_path):
    p = tmp_path / 'm.inp'
    mesh_lib.write_inp(str(p), [(0, 0, 0)] * 4, [[1, 2, 3, 4]], {'N': list(range(1, 40))}, order=1)
    lines = p.read_text().splitlines()
    assert '*ELEMENT, TYPE=C3D4' in lines
    i = lines.index('*NSET, NSET=N')
    assert len(lines[i + 1].split(',')) == 16
    with pytest.raises(mesh_lib.MeshInputError):
        mesh_lib.write_inp(str(p), [(0, 0, 0)], [], {'bad name': [1]})
