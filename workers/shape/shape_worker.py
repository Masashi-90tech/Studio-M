# 形状ワーカー: OCCT（OCP）で STEP を読み、面の一覧（ID・署名・面積・重心）と単位の確定結果を返す。
# 別プロセスとして呼ばれ、結果は標準出力の最後の行に JSON 1 つで返す（長さはすべてメートル）。
# 使い方:
#   python shape_worker.py inspect --step <絶対パス> [--length-unit mm|m|inch|...]
#   python shape_worker.py make-test-plate --out <出力する .step> [--length 400 --width 100 --thickness 10 --hole 20]  (mm)
# GPL の Gmsh は、このフォルダーから import しない（メッシュワーカーは workers/mesh に分ける）。
from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import sys
import time

t_start = time.perf_counter()
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I でも shape_lib を読めるように

import shape_lib  # noqa: E402


@contextlib.contextmanager
def quiet_stdout():
    """OCCT は C++ から標準出力に統計を書くので、処理の間だけ標準エラーへ回す（最後の行の JSON を汚さないため）。"""
    sys.stdout.flush()
    saved = os.dup(1)
    try:
        os.dup2(2, 1)
        yield
    finally:
        sys.stdout.flush()
        os.dup2(saved, 1)
        os.close(saved)


# 結果の JSON は、最初に複製しておいた標準出力へ書く。quiet_stdout の最中に fail() を呼んでも、最後の行に出るように
_OUT = os.fdopen(os.dup(1), 'w', encoding='utf-8')


def emit(obj: dict) -> None:
    _OUT.write(json.dumps(obj, ensure_ascii=False) + '\n')
    _OUT.flush()


def fail(message: str) -> int:
    emit({'ok': False, 'error': message})
    return 1


def _static(cls, name: str):
    """OCCT 8 の Python バインディングは static を _s 付きで公開する版と、付かない版がある。使えるほうを選ぶ。"""
    return getattr(cls, name + '_s', None) or getattr(cls, name)


def _box6(box) -> list:
    """Bnd_Box の [xmin, ymin, zmin, xmax, ymax, zmax]。Get() はこの版の OCP では戻り値を変換できないので、角の点から作る。"""
    lo, hi = box.CornerMin(), box.CornerMax()
    return [lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z()]


def _import_ocp():
    try:
        import OCP  # noqa: F401
    except ImportError as e:
        raise RuntimeError(
            f'OCP を読み込めません（{e}）。workers/shape/site-packages に cadquery-ocp-novtk が入っているか、'
            'PYTHONPATH がそこを指しているか確認してください（Python 3.12 が必要です。workers/README.md）') from e


def _tool_version() -> str:
    try:
        from importlib import metadata
        for pkg in ('cadquery-ocp-novtk', 'cadquery-ocp'):
            try:
                return f'{pkg} {metadata.version(pkg)}'
            except metadata.PackageNotFoundError:
                continue
    except Exception:
        pass
    return 'unknown'


def inspect(step: str, length_unit: str | None) -> int:
    if not os.path.isabs(step) or not os.path.isfile(step):
        return fail(f'STEP ファイルが見つかりません（{step}）。存在する場所を絶対パスで指定してください')
    t0 = time.perf_counter()
    try:
        _import_ocp()
        from OCP.STEPControl import STEPControl_Reader
        from OCP.Interface import Interface_Static
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.TopExp import TopExp, TopExp_Explorer
        from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE, TopAbs_SOLID
        from OCP.TopoDS import TopoDS
        from OCP.GProp import GProp_GProps
        from OCP.BRepGProp import BRepGProp
        from OCP.BRepAdaptor import BRepAdaptor_Surface
        from OCP.BRepBndLib import BRepBndLib
        from OCP.Bnd import Bnd_Box
        # OCP は OCCT のテンプレートを、この名前の型として公開している（TopTools_* の名前では見つからない）
        from OCP.collections import (
            Sequence_TCollection_AsciiString,
            IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as FaceMap,
            IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher as EdgeToFaces,
        )
    except RuntimeError as e:
        return fail(str(e))
    except ImportError as e:
        return fail(f'OCP の部品を読み込めません（{e}）。cadquery-ocp-novtk の版が requirements-shape.txt と同じか確認してください')
    t_import = time.perf_counter() - t0

    t0 = time.perf_counter()
    with quiet_stdout():
        reader = STEPControl_Reader()
        # 読み込み後の形状をメートルにする（既定は mm）。ファイルの単位が何でも、OCCT がここへ換算する。
        # 注意: リーダーを作った「後」に設定する。作る前に設定しても、作るときに既定の MM へ戻されて効かない（実測）
        Interface_Static.SetCVal_s('xstep.cascade.unit', 'M')
        cascade_scale = {'M': 1.0, 'MM': 1e-3}.get((Interface_Static.CVal_s('xstep.cascade.unit') or '').upper())
        if cascade_scale is None:
            return fail('OCCT の読み込み単位を確かめられません。cadquery-ocp-novtk の版が requirements-shape.txt と同じか確認してください')
        if reader.ReadFile(step) != IFSelect_RetDone:
            return fail(f'STEP を読み込めません（{step}）。壊れていないか、STEP（AP203/AP214/AP242）のファイルか確認してください')
        # ファイルに書かれた長さの単位の名前（"millimetre"・"metre"・"INCH" など）
        names, angles, solid_angles = (Sequence_TCollection_AsciiString() for _ in range(3))
        reader.FileUnits(names, angles, solid_angles)
        file_unit = next((x.ToCString() for x in names), None)
        try:
            source_unit, to_m = shape_lib.resolve_length_unit(file_unit, length_unit)
        except shape_lib.UnitError as e:
            return fail(str(e))
        reader.TransferRoots()
        shape = reader.OneShape()
    if shape.IsNull():
        return fail('STEP から形状を取り出せません。ソリッド（体積のある形）が入っているか確認してください')
    t_read = time.perf_counter() - t0
    # ファイルに単位がなく利用者の指定で決めたときは、OCCT は換算せず数値をそのまま返すので、ここで換算する
    # （単位なしの STEP はテストできていない。単位のあるファイルは OCCT が換算済みなので cascade_scale）
    geom_scale = to_m if file_unit is None else cascade_scale

    surf = _static(BRepGProp, 'SurfaceProperties')
    vol = _static(BRepGProp, 'VolumeProperties')

    fmap = FaceMap()
    _static(TopExp, 'MapShapes')(shape, TopAbs_FACE, fmap)
    e2f = EdgeToFaces()
    _static(TopExp, 'MapShapesAndAncestors')(shape, TopAbs_EDGE, TopAbs_FACE, e2f)

    # 面ごとの隣（辺を共有する別の面）の集合
    neighbors = {i: set() for i in range(1, fmap.Extent() + 1)}
    for ei in range(1, e2f.Extent() + 1):
        idx = [fmap.FindIndex(f) for f in e2f.FindFromIndex(ei)]
        for a in idx:
            for b in idx:
                if a != b:
                    neighbors[a].add(b)

    faces = []
    for i in range(1, fmap.Extent() + 1):
        face = _static(TopoDS, 'Face')(fmap.FindKey(i))  # TopoDS_Shape → TopoDS_Face
        g = GProp_GProps()
        surf(face, g)
        c = g.CentreOfMass()
        box = Bnd_Box()
        _static(BRepBndLib, 'AddOptimal')(face, box, False, False)
        bb = _box6(box)
        stype = shape_lib.classify_surface(str(BRepAdaptor_Surface(face).GetType()))
        faces.append(shape_lib.scale_face({
            'type': stype, 'area': g.Mass(), 'centroid': [c.X(), c.Y(), c.Z()],
            'bbox': bb, 'neighbors': len(neighbors[i]),
        }, geom_scale))
    faces = shape_lib.assign_ids(faces)

    gv = GProp_GProps()
    vol(shape, gv)
    box = Bnd_Box()
    _static(BRepBndLib, 'AddOptimal')(shape, box, False, False)
    bbox = [v * geom_scale for v in _box6(box)]
    solids = 0
    exp = TopExp_Explorer(shape, TopAbs_SOLID)
    while exp.More():
        solids += 1
        exp.Next()

    emit({
        'ok': True, 'tool': 'OCP', 'toolVersion': _tool_version(),
        'sourceUnit': source_unit, 'toMeters': to_m,
        'hash': shape_lib.sha256_file(step),
        'bbox': bbox, 'volume': gv.Mass() * geom_scale ** 3,
        'area': sum(f['area'] for f in faces), 'solidCount': solids,
        'faces': faces,
        'timings': {'importSec': t_import, 'readSec': t_read, 'totalSec': time.perf_counter() - t_start},
    })
    return 0


def make_test_plate(out: str, length: float, width: float, thickness: float, hole: float) -> int:
    """円孔のある平板（mm）を作って STEP に書く。テストと自己診断用。"""
    if not os.path.isabs(out):
        return fail(f'出力先は絶対パスで指定してください（{out}）')
    try:
        t0 = time.perf_counter()
        _import_ocp()
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
        from OCP.gp import gp_Pnt, gp_Ax2, gp_Dir
        from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
        from OCP.Interface import Interface_Static
        from OCP.IFSelect import IFSelect_RetDone
        t_import = time.perf_counter() - t0
    except RuntimeError as e:
        return fail(str(e))
    except ImportError as e:
        return fail(f'OCP の部品を読み込めません（{e}）。cadquery-ocp-novtk の版を確認してください')
    if min(length, width, thickness) <= 0 or hole < 0 or hole >= min(length, width):
        return fail('平板の寸法が正しくありません。長さ・幅・厚みは正の数、穴の直径は 0 以上で幅より小さくしてください')
    with quiet_stdout():
        shape = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), length, width, thickness).Shape()
        if hole > 0:
            cyl = BRepPrimAPI_MakeCylinder(
                gp_Ax2(gp_Pnt(length / 2, width / 2, -1), gp_Dir(0, 0, 1)), hole / 2, thickness + 2).Shape()
            shape = BRepAlgoAPI_Cut(shape, cyl).Shape()
        Interface_Static.SetCVal_s('write.step.unit', 'MM')
        w = STEPControl_Writer()
        w.Transfer(shape, STEPControl_AsIs)
        ok = w.Write(out) == IFSelect_RetDone
    if not ok:
        return fail(f'STEP を書き出せません（{out}）。書き込める場所か確認してください')
    emit({'ok': True, 'step': out, 'unit': 'mm',
          'timings': {'importSec': t_import, 'totalSec': time.perf_counter() - t_start}})
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='Studio M 形状ワーカー（OCCT）')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('inspect', help='STEP を読んで面の一覧を JSON で返す')
    p.add_argument('--step', required=True, help='読み込む STEP ファイル（絶対パス）')
    p.add_argument('--length-unit', default=None, help='長さの単位（STEP が単位を持たないときに必須。例: mm, m, inch）')
    q = sub.add_parser('make-test-plate', help='円孔のある平板（mm）の STEP を作る')
    q.add_argument('--out', required=True, help='書き出す STEP ファイル（絶対パス）')
    q.add_argument('--length', type=float, default=400.0)
    q.add_argument('--width', type=float, default=100.0)
    q.add_argument('--thickness', type=float, default=10.0)
    q.add_argument('--hole', type=float, default=20.0, help='穴の直径 [mm]。0 なら穴なし')
    a = ap.parse_args(argv)
    try:
        if a.cmd == 'inspect':
            return inspect(a.step, a.length_unit)
        return make_test_plate(a.out, a.length, a.width, a.thickness, a.hole)
    except Exception as e:  # 想定外の失敗も、最後の行の JSON で返す
        return fail(f'形状ワーカーで想定外のエラーが起きました（{type(e).__name__}: {e}）。STEP が壊れていないか確認し、直らなければこの内容を報告してください')


if __name__ == '__main__':
    sys.exit(main())
