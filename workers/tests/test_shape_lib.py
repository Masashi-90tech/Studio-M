# 形状ワーカーの純粋な部品の単体テスト（OCP なしで走る）。
import random

import pytest

import shape_lib


def face(t, area, c, nb=4):
    return {'type': t, 'area': area, 'centroid': list(c), 'bbox': [c[0], c[1], c[2], c[0] + 1, c[1] + 1, c[2] + 1], 'neighbors': nb}


def test_resolve_unit_from_file():
    assert shape_lib.resolve_length_unit('millimetre') == ('mm', 0.001)
    assert shape_lib.resolve_length_unit('metre') == ('m', 1.0)
    assert shape_lib.resolve_length_unit('INCH') == ('in', 0.0254)


def test_resolve_unit_override_when_file_has_none():
    assert shape_lib.resolve_length_unit(None, 'mm') == ('mm', 0.001)
    assert shape_lib.resolve_length_unit('', 'inch')[1] == 0.0254


def test_resolve_unit_same_override_is_ok():
    assert shape_lib.resolve_length_unit('millimetre', 'mm') == ('mm', 0.001)


def test_resolve_unit_unknown_is_error_in_japanese():
    with pytest.raises(shape_lib.UnitError, match='単位を指定してください'):
        shape_lib.resolve_length_unit(None, None)


def test_resolve_unit_conflict_is_error():
    with pytest.raises(shape_lib.UnitError, match='食い違|指定されました'):
        shape_lib.resolve_length_unit('millimetre', 'inch')


def test_resolve_unit_unsupported():
    with pytest.raises(shape_lib.UnitError):
        shape_lib.resolve_length_unit('furlong')
    with pytest.raises(shape_lib.UnitError):
        shape_lib.resolve_length_unit(None, 'furlong')


def test_classify_surface():
    assert shape_lib.classify_surface('GeomAbs_Plane') == 'plane'
    assert shape_lib.classify_surface('GeomAbs_SurfaceType.GeomAbs_Cylinder') == 'cylinder'
    assert shape_lib.classify_surface('GeomAbs_BSplineSurface') == 'bspline'
    assert shape_lib.classify_surface('GeomAbs_SurfaceOfRevolution') == 'other'


def test_assign_ids_is_deterministic_regardless_of_input_order():
    faces = [face('plane', 0.001, (0, 0.05, 0.005)), face('plane', 0.004, (0.2, 0, 0.005)),
             face('cylinder', 0.0006, (0.2, 0.05, 0.005), 2), face('plane', 0.001, (0.4, 0.05, 0.005))]
    base = shape_lib.assign_ids(faces)
    for seed in range(5):
        shuffled = faces[:]
        random.Random(seed).shuffle(shuffled)
        assert shape_lib.assign_ids(shuffled) == base
    assert [f['id'] for f in base] == ['F1', 'F2', 'F3', 'F4']
    # 種類 → 重心 の順: cylinder が先、plane は x の小さい順
    assert [f['type'] for f in base] == ['cylinder', 'plane', 'plane', 'plane']
    assert base[1]['centroid'][0] == 0 and base[3]['centroid'][0] == 0.4


def test_assign_ids_does_not_change_input():
    f = [face('plane', 1.0, (0, 0, 0))]
    shape_lib.assign_ids(f)
    assert 'id' not in f[0] and 'signature' not in f[0]


def test_signature_same_for_same_face_and_changes_with_area():
    a = shape_lib.assign_ids([face('plane', 0.004, (0.2, 0, 0.005))])[0]
    b = shape_lib.assign_ids([face('plane', 0.004 + 1e-12, (0.2 + 1e-10, 0, 0.005))])[0]
    c = shape_lib.assign_ids([face('plane', 0.005, (0.2, 0, 0.005))])[0]
    assert a['signature'] == b['signature']
    assert a['signature'] != c['signature']
    assert a['signature'].startswith('plane:')


def test_signature_has_no_negative_zero():
    s = shape_lib.assign_ids([face('plane', 1.0, (-1e-12, 0, 0))])[0]['signature']
    assert '-0.0' not in s


def test_scale_face_to_meters():
    f = shape_lib.scale_face(face('plane', 1000.0, (200, 50, 5)), 0.001)
    assert f['area'] == pytest.approx(0.001)
    assert f['centroid'] == pytest.approx([0.2, 0.05, 0.005])
    assert f['bbox'][3] == pytest.approx(201 * 0.001)


def test_sha256_file(tmp_path):
    p = tmp_path / 'a.step'
    p.write_bytes(b'abc')
    assert shape_lib.sha256_file(str(p)) == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
