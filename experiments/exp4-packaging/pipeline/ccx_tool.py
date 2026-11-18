# CalculiX の入力づくりと後処理（標準ライブラリだけ。同梱の Python で動かす）。
#   prepare: Gmsh の .inp（体積要素と節点集合）に材料・境界条件・出力を足して job.inp を作る
#   post:    job.dat / job.frd を読んで、応力集中係数を出して文献の近似式と比べる
# 結果は標準出力の最後の行に JSON 1 つで返す。
# 使い方: python ccx_tool.py prepare --mesh <mesh.inp> --job <job.inp>
#         python ccx_tool.py post --dir <作業フォルダー> --job job [--width 100 --thickness 10 --hole 20]
import argparse
import json
import os
import re
import sys

DISP = 0.1  # 引っ張る面の変位 [mm]


def prepare(mesh: str, job: str) -> int:
    # 面要素の定義は捨て、体積要素（C3D10）と節点集合だけ使う
    keep, out = True, []
    for line in open(mesh, encoding='utf-8'):
        if line.upper().startswith('*ELEMENT'):
            keep = 'C3D10' in line.upper()
        elif line.startswith('*'):
            keep = True
        if keep:
            out.append(line)
    txt = ''.join(out)
    m = re.search(r'\*ELEMENT[^\n]*C3D10[^\n]*ELSET=(\w+)', txt, re.I)
    if not m:
        print('エラー: メッシュに 2 次の四面体（C3D10）が見つかりません。mesh_worker の設定を確認してください', file=sys.stderr)
        return 1
    elset = m.group(1)
    nsets = {n.lower(): n for n in re.findall(r'\*NSET,\s*NSET=(\w+)', txt, re.I)}
    if 'fixed' not in nsets or 'pulled' not in nsets:
        print(f'エラー: 節点集合 fixed・pulled が .inp にありません（あるのは {sorted(nsets)}）', file=sys.stderr)
        return 1
    with open(job, 'w', encoding='utf-8') as f:
        f.write(txt)
        f.write(f"""*MATERIAL, NAME=STEEL
*ELASTIC
210000., 0.3
*SOLID SECTION, ELSET={elset}, MATERIAL=STEEL
*STEP
*STATIC
*BOUNDARY
{nsets['fixed']}, 1, 3, 0.
{nsets['pulled']}, 1, 1, {DISP}
*NODE PRINT, NSET={nsets['pulled']}, TOTALS=ONLY
RF
*EL PRINT, ELSET={elset}
S
*NODE FILE
U
*EL FILE
S
*END STEP
""")
    print(json.dumps({'job': job, 'elset': elset, 'nsets': sorted(nsets.values())}, ensure_ascii=False))
    return 0


def post(d: str, job: str, w: float, t: float, hole: float) -> int:
    dat = open(os.path.join(d, job + '.dat'), encoding='utf-8').read()
    m = re.search(r'total force \(fx,fy,fz\)[^\n]*\n\s*\n\s*([-\d.E+]+)', dat)
    if not m:
        print('エラー: job.dat に反力の合計がありません。CalculiX が最後まで計算できたか job.log を確認してください', file=sys.stderr)
        return 1
    rf = float(m.group(1))
    # probe_structure.py と同じく、積分点の応力表の 3 列目（x 方向応力）の最大を使う
    smax_ip = max(float(l.split()[2]) for l in dat.split('stresses (elem, integ.pnt.')[1].splitlines()[2:] if len(l.split()) == 8)
    smax_node, in_s = -1e30, False
    for l in open(os.path.join(d, job + '.frd'), encoding='utf-8'):
        if l.startswith(' -4  STRESS'):
            in_s = True
        elif l.startswith(' -3'):
            in_s = False
        elif in_s and l.startswith(' -1'):
            smax_node = max(smax_node, float(l[13:25]))
    sg = rf / (w * t)
    r = hole / w
    # 文献の近似式（有限幅の円孔平板、総断面基準。d/W=0.2 で 3.149）
    kt_ref = (2 + 0.284 * (1 - r) - 0.6 * (1 - r) ** 2 + 1.32 * (1 - r) ** 3) / (1 - r)
    print(json.dumps({
        'reaction_N': rf, 'nominal_MPa': sg,
        'kt_integration_point': smax_ip / sg, 'kt_node': smax_node / sg, 'kt_reference': kt_ref,
        'rel_error_integration_point': abs(smax_ip / sg - kt_ref) / kt_ref,
        'rel_error_node': abs(smax_node / sg - kt_ref) / kt_ref,
    }, ensure_ascii=False))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--mesh', required=True)
    p.add_argument('--job', required=True)
    q = sub.add_parser('post')
    q.add_argument('--dir', required=True)
    q.add_argument('--job', default='job')
    q.add_argument('--width', type=float, default=100.0)
    q.add_argument('--thickness', type=float, default=10.0)
    q.add_argument('--hole', type=float, default=20.0)
    a = ap.parse_args()
    if a.cmd == 'prepare':
        return prepare(a.mesh, a.job)
    return post(a.dir, a.job, a.width, a.thickness, a.hole)


if __name__ == '__main__':
    sys.exit(main())
