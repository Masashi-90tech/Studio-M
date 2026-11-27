# 同梱物の組み立て用スクリプト（workers/build/）の部品のテスト。標準ライブラリだけで走る。
import json
import os
import stat
import sys
import zipfile
from types import SimpleNamespace

import pytest

import manifest
import wheel_data
import zip_pack


@pytest.mark.skipif(sys.platform == 'win32', reason='シンボリックリンクと実行権限は Unix のみ')
def test_zip_pack_keeps_symlink_and_exec_bit(tmp_path):
    src = tmp_path / 'pack'
    (src / 'python' / 'bin').mkdir(parents=True)
    exe = src / 'python' / 'bin' / 'python3.12'
    exe.write_bytes(b'#!/bin/sh\n')
    exe.chmod(0o755)
    os.symlink('python3.12', src / 'python' / 'bin' / 'python3')
    (src / 'empty').mkdir()
    (src / 'manifest.json').write_text('{}')
    out = tmp_path / 'out.zip'
    zip_pack.zip_dir(str(src), str(out))
    with zipfile.ZipFile(out) as zf:
        names = set(zf.namelist())
        assert {'python/bin/python3.12', 'python/bin/python3', 'manifest.json', 'empty/'} <= names
        link = zf.getinfo('python/bin/python3')
        assert stat.S_ISLNK(link.external_attr >> 16) and zf.read('python/bin/python3') == b'python3.12'
        assert (zf.getinfo('python/bin/python3.12').external_attr >> 16) & 0o111


def _wheel(path):
    with zipfile.ZipFile(path, 'w') as zf:
        zf.writestr('gmsh.py', '# stub')
        zf.writestr('gmsh-1.0.data/data/lib/libgmsh.so.4', b'LIB')
        zf.writestr('gmsh-1.0.data/data/lib/gmsh.jl', 'julia')
        zf.writestr('gmsh-1.0.data/data/share/doc/x.txt', 'doc')
        zf.writestr('gmsh-1.0.dist-info/METADATA', 'Name: gmsh')


def test_wheel_data_extracts_only_libs(tmp_path):
    whl, site = tmp_path / 'gmsh.whl', tmp_path / 'site'
    _wheel(whl)
    got = wheel_data.extract(str(whl), str(site))
    assert [os.path.relpath(g, site) for g in got] == [os.path.join('lib', 'libgmsh.so.4')]
    assert (site / 'lib' / 'libgmsh.so.4').read_bytes() == b'LIB'
    assert not (site / 'share').exists() and not (site / 'lib' / 'gmsh.jl').exists()


def test_manifest_sizes_and_versions(tmp_path):
    pack = tmp_path / 'pack'
    (pack / 'shape-site' / 'OCP').mkdir(parents=True)
    (pack / 'shape-site' / 'OCP' / 'big.so').write_bytes(b'x' * (2 << 20))
    (pack / 'shape-site' / 'cadquery_ocp_novtk-8.0.1.1.0.dist-info').mkdir()
    (pack / 'mesh-site' / 'gmsh-4.15.2.dist-info').mkdir(parents=True)
    (pack / 'python').mkdir()
    (pack / 'python' / 'a').write_bytes(b'12345')
    (pack / 'scripts').mkdir()
    tsv = tmp_path / 'w.tsv'
    tsv.write_text('shape\tocp.whl\tabc\nmesh\tgmsh.whl\tdef\n', encoding='utf-8')
    doc = manifest.build(SimpleNamespace(pack=str(pack), platform='linux-x64', workers_version='0.1.0',
                                         python_version='3.12.11', wheels=str(tsv), commit='deadbeef'))
    assert doc['sizes']['shape-site'] == 2 << 20 and doc['sizes']['python'] == 5
    assert doc['sizes']['total'] == sum(v for k, v in doc['sizes'].items() if k not in ('total', 'manifestUnit'))
    assert doc['shapeSite'] == {'cadquery-ocp-novtk': '8.0.1.1.0'} and doc['meshSite'] == {'gmsh': '4.15.2'}
    assert doc['parts']['shape-site'] == [{'name': 'OCP', 'bytes': 2 << 20}]
    assert doc['wheels'][1] == {'group': 'mesh', 'file': 'gmsh.whl', 'sha256': 'def'}
    json.dumps(doc)
