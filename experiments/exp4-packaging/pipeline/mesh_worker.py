# メッシュワーカー: STEP を Gmsh で読み、面に名前（fixed・pulled）を付けて 2 次の四面体メッシュを作り、
# CalculiX の .inp に書く。GPL の Gmsh を使うので、形状ワーカーとは別のフォルダー・別のプロセスで動かす。
# 結果は標準出力の最後の行に JSON 1 つで返す。
# 使い方: python mesh_worker.py --step <入力 .step> --out <出力 .inp> [--size 10]
import argparse
import json
import sys
import time

t_start = time.perf_counter()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--step', required=True, help='読み込む STEP ファイル（絶対パス）')
    ap.add_argument('--out', required=True, help='書き出す .inp（絶対パス）')
    ap.add_argument('--size', type=float, default=10.0, help='要素の最大寸法 [mm]')
    ap.add_argument('--length', type=float, default=400.0, help='板の長さ（引っ張る面の位置）[mm]')
    a = ap.parse_args()

    t0 = time.perf_counter()
    try:
        import gmsh
    except ImportError as e:
        print(f'エラー: gmsh を読み込めません（{e}）。workers/mesh/site-packages に gmsh が入っているか、'
              'PYTHONPATH がそこを指しているか確認してください', file=sys.stderr)
        return 1
    t_import = time.perf_counter() - t0

    gmsh.initialize()
    try:
        gmsh.option.setNumber('General.Terminal', 0)
        t0 = time.perf_counter()
        gmsh.model.occ.importShapes(a.step)
        gmsh.model.occ.synchronize()
        t_read = time.perf_counter() - t0

        # 面の重心で、固定する面（x=0）と引っ張る面（x=長さ）を見つける
        tol = 1e-6 * a.length
        fixed, pulled = [], []
        for _, tag in gmsh.model.getEntities(2):
            cx = gmsh.model.occ.getCenterOfMass(2, tag)[0]
            if abs(cx) < tol:
                fixed.append(tag)
            elif abs(cx - a.length) < tol:
                pulled.append(tag)
        if len(fixed) != 1 or len(pulled) != 1:
            print(f'エラー: 固定する面・引っ張る面を 1 つずつ見つけられません（fixed={fixed}, pulled={pulled}）。'
                  '板の長さ（--length）が STEP と合っているか確認してください', file=sys.stderr)
            return 1
        gmsh.model.addPhysicalGroup(2, fixed, name='fixed')
        gmsh.model.addPhysicalGroup(2, pulled, name='pulled')
        gmsh.model.addPhysicalGroup(3, [t for _, t in gmsh.model.getEntities(3)], name='solid')

        gmsh.option.setNumber('Mesh.ElementOrder', 2)
        gmsh.option.setNumber('Mesh.MeshSizeMax', a.size)
        gmsh.option.setNumber('Mesh.MeshSizeMin', a.size / 6)
        gmsh.option.setNumber('Mesh.MeshSizeFromCurvature', 40)
        t0 = time.perf_counter()
        gmsh.model.mesh.generate(3)
        t_mesh = time.perf_counter() - t0

        n_tet = sum(len(t) for t in gmsh.model.mesh.getElements(3)[1])
        n_node = len(gmsh.model.mesh.getNodes()[0])
        gmsh.option.setNumber('Mesh.SaveGroupsOfNodes', 1)
        gmsh.write(a.out)
    finally:
        gmsh.finalize()

    print(json.dumps({
        'inp': a.out, 'tets': n_tet, 'nodes': n_node, 'size_mm': a.size,
        'seconds': {'import_gmsh': t_import, 'read_step': t_read, 'mesh': t_mesh, 'total': time.perf_counter() - t_start},
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
