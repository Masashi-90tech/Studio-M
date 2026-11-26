# 実物のテスト: make-test-plate → inspect → mesh（→ ccx があれば計算）。
# OCP・gmsh が入っていなければ skip する。ワーカーは別プロセスとして呼ぶ（本番と同じ）。
import json
import math
import os
import shutil
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SHAPE = os.path.join(HERE, '..', 'shape', 'shape_worker.py')
MESH = os.path.join(HERE, '..', 'mesh', 'mesh_worker.py')

# 形状側は OCP、メッシュ側は gmsh が要る。pytest を動かす Python に両方が入っている前提（なければ skip）
ocp = pytest.importorskip('OCP', reason='OCP（cadquery-ocp-novtk）が入っていません')
gmsh = pytest.importorskip('gmsh', reason='gmsh が入っていません')

L, W, T, D = 0.4, 0.1, 0.01, 0.02


def run(script, *args):
    p = subprocess.run([sys.executable, script, *map(str, args)], capture_output=True, text=True, timeout=300)
    last = [l for l in p.stdout.splitlines() if l.strip()][-1]
    return p.returncode, json.loads(last)


@pytest.fixture(scope='module')
def plate(tmp_path_factory):
    d = tmp_path_factory.mktemp('plate')
    step = str(d / 'plate.step')
    rc, r = run(SHAPE, 'make-test-plate', '--out', step)
    assert rc == 0 and r['ok'], r
    rc, info = run(SHAPE, 'inspect', '--step', step)
    assert rc == 0 and info['ok'], info
    return d, step, info


def face_at(info, axis, value):
    hits = [f for f in info['faces'] if f['type'] == 'plane' and abs(f['centroid'][axis] - value) < 1e-9
            and abs(f['bbox'][axis] - value) < 1e-9 and abs(f['bbox'][axis + 3] - value) < 1e-9]
    assert len(hits) == 1, hits
    return hits[0]


def test_inspect_plate(plate):
    _, step, info = plate
    assert info['sourceUnit'] == 'mm' and info['toMeters'] == 0.001
    assert len(info['faces']) == 7 and info['solidCount'] == 1
    expect = L * W * T - math.pi * (D / 2) ** 2 * T
    assert info['volume'] == pytest.approx(expect, rel=1e-9)
    assert info['bbox'] == pytest.approx([0, 0, 0, L, W, T], abs=1e-9)
    assert [f['id'] for f in info['faces']] == [f'F{i}' for i in range(1, 8)]
    assert sum(1 for f in info['faces'] if f['type'] == 'cylinder') == 1
    import hashlib
    assert info['hash'] == hashlib.sha256(open(step, 'rb').read()).hexdigest()
    # 同じファイルなら同じ ID・署名
    _, again = run(SHAPE, 'inspect', '--step', step)
    assert [(f['id'], f['signature']) for f in again['faces']] == [(f['id'], f['signature']) for f in info['faces']]


def test_inspect_errors_are_japanese_json(tmp_path):
    rc, r = run(SHAPE, 'inspect', '--step', str(tmp_path / 'none.step'))
    assert rc == 1 and r['ok'] is False and 'STEP ファイルが見つかりません' in r['error']
    bad = tmp_path / 'bad.step'
    bad.write_text('not a step file')
    rc, r = run(SHAPE, 'inspect', '--step', str(bad))
    assert rc == 1 and r['ok'] is False and r['error']


def test_inspect_unit_conflict(plate):
    _, step, _ = plate
    rc, r = run(SHAPE, 'inspect', '--step', step, '--length-unit', 'inch')
    assert rc == 1 and '指定されました' in r['error']
    rc, r = run(SHAPE, 'inspect', '--step', step, '--length-unit', 'mm')
    assert rc == 0 and r['sourceUnit'] == 'mm'


def make_selections(d, info, fixed, load, extra=None):
    path = d / 'selections.json'
    sels = [{'name': 'FIXED', 'faceIds': [fixed['id']]}, {'name': 'LOAD', 'faceIds': [load['id']]}] + (extra or [])
    path.write_text(json.dumps({'selections': sels, 'faces': info['faces']}))
    return str(path)


def test_mesh_plate(plate):
    d, step, info = plate
    fixed, load = face_at(info, 0, 0.0), face_at(info, 0, L)
    sel = make_selections(d, info, fixed, load)
    inp, rep = str(d / 'job.inp'), str(d / 'report.json')
    rc, r = run(MESH, 'mesh', '--step', step, '--selections', sel, '--out', inp, '--report', rep)
    assert rc == 0 and r['ok'], r
    assert r['meshUnit'] == 'm' and r['elementType'] == 'C3D10'
    assert r['bbox'] == pytest.approx([0, 0, 0, L, W, T], abs=1e-6)
    assert r['nodes'] > 0 and r['elements'] > 0 and r['quality']['min'] > 0 and r['quality']['badCount'] == 0
    assert json.load(open(rep, encoding='utf-8')) == r
    by = {s['name']: s for s in r['selections']}
    assert set(by) == {'FIXED', 'LOAD'}
    for s in by.values():
        assert s['nodeCount'] > 0 and s['area']['relDiff'] < 0.01
    assert r['warnings'] == []
    txt = open(inp, encoding='utf-8').read()
    assert '*NSET, NSET=FIXED' in txt and '*NSET, NSET=LOAD' in txt and '*ELSET, ELSET=EALL' in txt
    assert '*ELEMENT, TYPE=C3D10' in txt and '*MATERIAL' not in txt


def test_mesh_rejects_unmatched_face(plate):
    d, step, info = plate
    faces = [dict(f) for f in info['faces']]
    faces[0]['area'] *= 1.5  # 形状側の面積が違えば、メッシュ側の面と対応しない
    path = d / 'bad_sel.json'
    path.write_text(json.dumps({'selections': [{'name': 'X', 'faceIds': [faces[0]['id']]}], 'faces': faces}))
    rc, r = run(MESH, 'mesh', '--step', step, '--selections', path, '--out', d / 'x.inp', '--report', d / 'x.json')
    assert rc == 1 and 'メッシュ側の面と対応しません' in r['error'] and faces[0]['id'] in r['error']


def test_mesh_rejects_bad_name(plate):
    d, step, info = plate
    path = d / 'bad_name.json'
    path.write_text(json.dumps({'selections': [{'name': 'fixed', 'faceIds': ['F1']}], 'faces': info['faces']}))
    rc, r = run(MESH, 'mesh', '--step', step, '--selections', path, '--out', d / 'x.inp', '--report', d / 'x.json')
    assert rc == 1 and '選択の名前' in r['error']


@pytest.mark.skipif(shutil.which('ccx') is None, reason='ccx（CalculiX）が PATH にありません')
def test_inp_runs_in_calculix_with_correct_node_order(plate):
    """節点 9・10 の順序が合っていないと、ccx は負のヤコビアンで止まるか、反力が大きくずれる。"""
    d, step, info = plate
    sel = make_selections(d, info, face_at(info, 0, 0.0), face_at(info, 0, L))
    mesh_inp = str(d / 'ccxjob_mesh.inp')
    rc, r = run(MESH, 'mesh', '--step', step, '--selections', sel, '--out', mesh_inp, '--report', d / 'r2.json')
    assert rc == 0, r
    E, nu, disp = 210e9, 0.3, 1e-5
    job = d / 'ccxjob.inp'
    job.write_text(open(mesh_inp, encoding='utf-8').read() + f"""*MATERIAL, NAME=STEEL
*ELASTIC
{E}, {nu}
*SOLID SECTION, ELSET=EALL, MATERIAL=STEEL
*STEP
*STATIC
*BOUNDARY
FIXED, 1, 3, 0.
LOAD, 1, 1, {disp}
*NODE PRINT, NSET=LOAD, TOTALS=ONLY
RF
*END STEP
""", encoding='utf-8')
    p = subprocess.run(['ccx', 'ccxjob'], cwd=d, capture_output=True, text=True, timeout=300)
    out = p.stdout + p.stderr
    assert p.returncode == 0 and '*ERROR' not in out and 'negative' not in out.lower(), out[-800:]
    dat = (d / 'ccxjob.dat').read_text(errors='replace')
    import re
    m = re.search(r'total force \(fx,fy,fz\)[^\n]*\n\s*\n\s*([-\d.E+]+)', dat)
    assert m, dat[-500:]
    rf = float(m.group(1))
    eps = disp / L
    a_net, a_gross = (W - D) * T, W * T
    assert 0.9 * E * eps * a_net < rf < 1.2 * E * eps * a_gross, rf
