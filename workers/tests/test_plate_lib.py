# 平板の検証（workers/tools/plate_lib.py）の純粋な部分のテスト。OCP・gmsh・ccx なしで走る。
import pytest

import plate_lib as P

MESH = """** Studio M メッシュワーカー（長さの単位: m）
*NODE
1, 0.0, 0.0, 0.0
2, 0.4, 0.0, 0.0
3, 0.4, 0.1, 0.0
4, 0.4, 0.0, 0.01
*ELEMENT, TYPE=C3D10
1, 1, 2, 3, 4, 1, 2, 3,
4, 1, 2
*NSET, NSET=FIXED
1
*NSET, NSET=LOAD
2, 3,
4
*ELSET, ELSET=EALL
1
"""


def test_reference_kt_matches_experiment_4():
    assert P.kt_reference_gross(0.1, 0.02) == pytest.approx(3.149, abs=5e-4)
    assert P.kt_reference_net(0.1, 0.02) == pytest.approx(2.519, abs=5e-4)
    assert P.KT_REFERENCE == pytest.approx(P.kt_reference_gross(0.1, 0.02), abs=5e-4)


def test_stress_concentration():
    assert P.nominal_stress(50000, 0.1, 0.01) == pytest.approx(50e6)
    assert P.nominal_stress(50000, 0.1, 0.01, 0.02) == pytest.approx(62.5e6)
    assert P.stress_concentration(157.45e6, 50000, 0.1, 0.01) == pytest.approx(3.149)
    # 総断面基準と正味断面基準は (1 - d/W) 倍だけ違う
    assert P.stress_concentration(100e6, 50000, 0.1, 0.01, 0.02) == pytest.approx(
        P.stress_concentration(100e6, 50000, 0.1, 0.01) * 0.8)


def test_parse_nset_nodes_handles_continuation_and_case():
    assert P.parse_nset_nodes(MESH, 'LOAD') == [2, 3, 4]
    assert P.parse_nset_nodes(MESH, 'fixed') == [1]
    with pytest.raises(ValueError, match='NOPE'):
        P.parse_nset_nodes(MESH, 'NOPE')


def test_build_job_inp():
    job = P.build_job_inp(MESH, [2, 3, 4], load_n=1234.5)
    assert job.startswith(MESH)
    assert '*MATERIAL, NAME=STEEL' in job and '*SOLID SECTION, ELSET=EALL, MATERIAL=STEEL' in job
    # 荷重節点の x 方向を、基準の節点（2）に束ねる。*EQUATION は *STEP より前
    assert '2\n3, 1, 1., 2, 1, -1.\n2\n4, 1, 1., 2, 1, -1.\n' in job
    assert job.index('*EQUATION') < job.index('*STEP')
    assert 'FIXED, 1, 3, 0.' in job and '2, 1, 1.234500000e+03' in job
    assert '*NODE PRINT, NSET=FIXED, TOTALS=ONLY' in job and '*EL PRINT, ELSET=EALL' in job
    with pytest.raises(ValueError):
        P.build_job_inp(MESH, [2])


DAT = """
 total force (fx,fy,fz) for set FIXED and time  0.1000000E+01

      -5.000100E+04  1.2E-01 -3.4E-02

 stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz) for all elements of set EALL and time  0.1000000E+01

         1   1  4.000000E+07 -1.0E+06  2.0E+05  1.0E+06  0.0E+00  0.0E+00
         1   2  1.574500E+08  2.0E+06  1.0E+05  0.0E+00  0.0E+00  0.0E+00
         2   1 -9.000000E+08  0.0E+00  0.0E+00  0.0E+00  0.0E+00  0.0E+00

 total strain energy
"""


def test_parse_dat():
    assert P.parse_total_force(DAT) == pytest.approx(-50001.0)
    assert P.parse_max_sxx_integration_point(DAT) == pytest.approx(1.5745e8)
    with pytest.raises(ValueError, match='反力'):
        P.parse_total_force('nothing')
    with pytest.raises(ValueError, match='応力'):
        P.parse_max_sxx_integration_point('nothing')


def _frd(*values):
    rows = ''.join(f' -1{i + 1:10d}{v:12.5E}{0.0:12.5E}{0.0:12.5E}\n' for i, v in enumerate(values))
    return ' -4  STRESS      6    1\n -5  SXX         1    4    1    1\n' + rows + ' -3\n -1         9  9.99999E+09\n'


def test_parse_frd_max_sxx_ignores_other_blocks_and_bad_utf8(tmp_path):
    assert P.parse_frd_max_sxx(_frd(1.0e6, 1.6e8, -2.0e8).splitlines(keepends=True)) == pytest.approx(1.6e8)
    # 日本語の途中で切られた見出し（不正な UTF-8）でも、errors='replace' で開けば読める
    path = tmp_path / 'job.frd'
    path.write_bytes('    1C\n    1UUSER  Studio M テスト'.encode('utf-8')[:-1] + b'\n' + _frd(2.0e8).encode())
    with open(path, encoding='utf-8', errors='replace') as f:
        assert P.parse_frd_max_sxx(f) == pytest.approx(2.0e8)
    with pytest.raises(ValueError):
        P.parse_frd_max_sxx(['    1C\n'])


def test_pick_plane_face():
    def face(i, x, kind='plane'):
        return {'id': f'F{i}', 'type': kind, 'centroid': [x, 0.05, 0.005], 'bbox': [x, 0, 0, x, 0.1, 0.01]}
    faces = [face(1, 0.0), face(2, 0.4), face(3, 0.2, 'cylinder')]
    assert P.pick_plane_face(faces, 0, 0.4)['id'] == 'F2'
    with pytest.raises(ValueError, match='0 個'):
        P.pick_plane_face(faces, 0, 0.3)
    with pytest.raises(ValueError, match='2 個'):
        P.pick_plane_face(faces + [face(4, 0.0)], 0, 0.0)


def test_last_json_line():
    assert P.last_json_line('統計\n{"a": 1}\n{"ok": true}\n') == {'ok': True}
    assert P.last_json_line('なし') is None
    assert P.last_json_line('{壊れた') is None


def test_evaluate_checks_pass_and_each_failure():
    bb = [0, 0, 0, 0.4, 0.1, 0.01]

    def run(**kw):
        a = dict(kt=3.138, reaction_n=-50010.0, load_n=50000.0, areas={'FIXED': 0.0, 'LOAD': 1e-9},
                 bboxes={'メッシュ': bb}, expected_bbox=bb)
        a.update(kw)
        return {c['name']: c['ok'] for c in P.evaluate_checks(**a)}

    assert all(run().values())
    assert not run(kt=3.149 * 1.031)['応力集中係数が 3.149 の 3% 以内']
    assert run(kt=3.149 * 1.029)['応力集中係数が 3.149 の 3% 以内']
    assert not run(reaction_n=-50600.0)['反力が荷重と 1% 以内で釣り合う']
    assert not run(areas={'LOAD': 0.02})['選択 LOAD の面積の照合が 1% 以内']
    assert not run(bboxes={'メッシュ': [0, 0, 0, 0.41, 0.1, 0.01]})['bbox（メッシュ）が 0.4 × 0.1 × 0.01 m']
