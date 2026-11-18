# 形状ワーカー: 円孔のある平板を OCCT（OCP）で作って STEP に書き、読み直して面の数・面積・体積を返す。
# 別プロセスとして呼ばれ、結果は標準出力の最後の行に JSON 1 つで返す。
# 使い方: python shape_worker.py --out <出力する .step のパス> [--length 400 --width 100 --thickness 10 --hole 20]
import argparse
import json
import math
import sys
import time

t_start = time.perf_counter()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True, help='書き出す STEP ファイル（絶対パス）')
    ap.add_argument('--length', type=float, default=400.0)
    ap.add_argument('--width', type=float, default=100.0)
    ap.add_argument('--thickness', type=float, default=10.0)
    ap.add_argument('--hole', type=float, default=20.0, help='穴の直径 [mm]')
    a = ap.parse_args()

    t0 = time.perf_counter()
    try:
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
        from OCP.gp import gp_Pnt, gp_Ax2, gp_Dir
        from OCP.STEPControl import STEPControl_Writer, STEPControl_Reader, STEPControl_AsIs
        from OCP.Interface import Interface_Static
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopAbs import TopAbs_FACE
        from OCP.GProp import GProp_GProps
        from OCP.BRepGProp import BRepGProp
    except ImportError as e:
        print(f'エラー: OCP を読み込めません（{e}）。workers/shape/site-packages に cadquery-ocp が入っているか、'
              'PYTHONPATH がそこを指しているか確認してください', file=sys.stderr)
        return 1
    t_import = time.perf_counter() - t0

    L, W, T, D = a.length, a.width, a.thickness, a.hole
    t0 = time.perf_counter()
    box = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), L, W, T).Shape()
    cyl = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(L / 2, W / 2, -1), gp_Dir(0, 0, 1)), D / 2, T + 2).Shape()
    shape = BRepAlgoAPI_Cut(box, cyl).Shape()
    Interface_Static.SetCVal_s('write.step.unit', 'MM')
    w = STEPControl_Writer()
    w.Transfer(shape, STEPControl_AsIs)
    if w.Write(a.out) != IFSelect_RetDone:
        print(f'エラー: STEP を書き出せません（{a.out}）。書き込める場所か確認してください', file=sys.stderr)
        return 1
    t_build = time.perf_counter() - t0

    t0 = time.perf_counter()
    r = STEPControl_Reader()
    if r.ReadFile(a.out) != IFSelect_RetDone:
        print(f'エラー: 書いた STEP を読み直せません（{a.out}）', file=sys.stderr)
        return 1
    r.TransferRoots()
    back = r.OneShape()
    t_read = time.perf_counter() - t0

    # OCCT 8 は _s の付かない書き方に変わる版があるので、使えるほうを選ぶ
    surf = getattr(BRepGProp, 'SurfaceProperties_s', None) or BRepGProp.SurfaceProperties
    vol = getattr(BRepGProp, 'VolumeProperties_s', None) or BRepGProp.VolumeProperties
    n_faces = 0
    area = 0.0
    exp = TopExp_Explorer(back, TopAbs_FACE)
    while exp.More():
        g = GProp_GProps()
        surf(exp.Current(), g)
        area += g.Mass()
        n_faces += 1
        exp.Next()
    gv = GProp_GProps()
    vol(back, gv)

    expect_vol = L * W * T - math.pi * (D / 2) ** 2 * T
    print(json.dumps({
        'step': a.out,
        'faces': n_faces,
        'area_mm2': area,
        'volume_mm3': gv.Mass(),
        'volume_expected_mm3': expect_vol,
        'volume_rel_error': abs(gv.Mass() - expect_vol) / expect_vol,
        'seconds': {
            'import_ocp': t_import,
            'build_and_write': t_build,
            'read_back': t_read,
            'total': time.perf_counter() - t_start,
        },
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
