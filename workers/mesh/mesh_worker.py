# メッシュワーカー: STEP を Gmsh（メートルで読む）で 2 次の四面体メッシュにし、名前つきの選択（面の ID の集合）を
# 物理グループにして、節点集合の名前つきで CalculiX の .inp（メッシュだけ）に書く。
# GPL の Gmsh を使うので、形状ワーカーとは別のフォルダー・別のプロセスで動かす。OCP は import しない。
# 結果は標準出力の最後の行に JSON 1 つで返す（--report のファイルと同じ内容）。
# 使い方:
#   python mesh_worker.py mesh --step <絶対パス> --selections <selections.json> --out <job.inp> --report <report.json>
#                         [--size 0.01] [--order 2] [--min-size ...]
# selections.json: {"selections": [{"name": "FIXED", "faceIds": ["F3"]}], "faces": [形状ワーカー inspect の faces]}
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

t_start = time.perf_counter()
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I でも mesh_lib を読めるように

import mesh_lib  # noqa: E402

# Windows の Python は標準出力が cp1252 などになり、日本語のメッセージを出すと UnicodeEncodeError で落ちる
# （本当のエラーが文字コードのエラーに隠れる）。UTF-8 に切り替える
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:  # noqa: BLE001  切り替えられない環境ではそのまま
        pass

AREA_WARN = 0.01  # 選択の面積が 1% を超えて違ったら警告


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def fail(message: str) -> int:
    emit({'ok': False, 'error': message})
    return 1


def _bbox_diag(faces) -> float:
    boxes = [f['bbox'] for f in faces if f.get('bbox')]
    if boxes:
        lo = [min(b[i] for b in boxes) for i in range(3)]
        hi = [max(b[i + 3] for b in boxes) for i in range(3)]
        return math.dist(lo, hi)
    return max((max(abs(v) for v in f['centroid']) for f in faces), default=1.0) * 2 or 1.0


def mesh(args) -> int:
    for label, p in (('STEP ファイル', args.step), ('選択のファイル', args.selections)):
        if not os.path.isabs(p) or not os.path.isfile(p):
            return fail(f'{label}が見つかりません（{p}）。存在する場所を絶対パスで指定してください')
    for label, p in (('.inp の出力先', args.out), ('レポートの出力先', args.report)):
        if not os.path.isabs(p):
            return fail(f'{label}は絶対パスで指定してください（{p}）')
    if args.order not in (1, 2):
        return fail('--order は 1 か 2 を指定してください')
    if not args.size > 0 or (args.min_size is not None and not args.min_size > 0):
        return fail('--size と --min-size は正の数（メートル）で指定してください')
    try:
        with open(args.selections, encoding='utf-8') as f:
            sels, shape_faces = mesh_lib.parse_selections(json.load(f))
    except json.JSONDecodeError as e:
        return fail(f'選択のファイルを JSON として読めません（{e}）。形状ワーカーの出力から作り直してください')
    except mesh_lib.MeshInputError as e:
        return fail(str(e))

    t0 = time.perf_counter()
    try:
        import gmsh
    except ImportError as e:
        return fail(f'gmsh を読み込めません（{e}）。workers/mesh/site-packages に gmsh が入っているか、'
                    'PYTHONPATH がそこを指しているか確認してください（Python 3.12 が必要です。'
                    'Linux では libGLU.so.1 も要ります: apt-get install -y libglu1-mesa。workers/README.md）')
    t_import = time.perf_counter() - t0

    warnings: list = []
    gmsh.initialize()
    try:
        gmsh.option.setNumber('General.Terminal', 0)
        # STEP をメートルで読ませる。何も設定しないと、mm の STEP は 400 のような数値のまま読まれる。
        # Gmsh 4.15.2 で効くオプション名は Geometry.OCCTargetUnit（T が 1 つ。Geometry.OCCTTargetUnit は
        # 「そのようなオプションはない」エラーになる）。
        gmsh.option.setString('Geometry.OCCTargetUnit', 'M')
        t0 = time.perf_counter()
        try:
            gmsh.model.occ.importShapes(args.step)
            gmsh.model.occ.synchronize()
        except Exception as e:
            return fail(f'Gmsh が STEP を読めません（{e}）。壊れていないか、形状ワーカーで読めるファイルか確認してください')
        t_read = time.perf_counter() - t0

        # --- 面の突き合わせ（面積と重心。メートル換算後） ---
        gfaces = []
        for _, tag in gmsh.model.getEntities(2):
            gfaces.append({'tag': tag, 'area': gmsh.model.occ.getMass(2, tag),
                           'centroid': list(gmsh.model.occ.getCenterOfMass(2, tag))})
        matches = mesh_lib.match_faces(gfaces, shape_faces, length_scale=_bbox_diag(shape_faces))
        needed = list(dict.fromkeys(i for s in sels for i in s['faceIds']))
        try:
            id_to_tag = mesh_lib.check_one_to_one(matches, needed)
        except mesh_lib.MeshInputError as e:
            return fail(str(e))
        unmatched = [fid for fid, t in matches.items() if len(t) != 1 and fid not in needed]
        if unmatched:
            warnings.append(f'選んでいない面 {", ".join(unmatched)} が、メッシュ側の面と 1 対 1 に対応しませんでした'
                            '（選んだ面には影響しません）')

        pg_tags = {}
        for k, s in enumerate(sels, start=1):
            tags = sorted({id_to_tag[i] for i in s['faceIds']})
            pg_tags[s['name']] = gmsh.model.addPhysicalGroup(2, tags, tag=k, name=s['name'])
        vols = [t for _, t in gmsh.model.getEntities(3)]
        if not vols:
            return fail('STEP にソリッド（体積のある形）がありません。メッシュは作れないので、形状を確認してください')
        gmsh.model.addPhysicalGroup(3, vols, tag=1000, name='SOLID')

        # --- メッシュ ---
        min_size = args.min_size if args.min_size is not None else args.size / 6
        gmsh.option.setNumber('Mesh.ElementOrder', args.order)
        gmsh.option.setNumber('Mesh.MeshSizeMax', args.size)
        gmsh.option.setNumber('Mesh.MeshSizeMin', min(min_size, args.size))
        gmsh.option.setNumber('Mesh.MeshSizeFromCurvature', 40)
        t0 = time.perf_counter()
        try:
            gmsh.model.mesh.generate(3)
        except Exception as e:
            return fail(f'メッシュを作れませんでした（{e}）。--size（メートル）を小さくするか、形状に隙間や重なりがないか確認してください')
        t_mesh = time.perf_counter() - t0

        etype = 11 if args.order == 2 else 4  # 10 節点・4 節点の四面体
        tags, conn = gmsh.model.mesh.getElementsByType(etype)
        npe = 10 if args.order == 2 else 4
        if len(tags) == 0:
            return fail('四面体の要素ができませんでした。--size が形状に対して大きすぎないか確認してください')
        raw = [list(map(int, conn[i:i + npe])) for i in range(0, len(conn), npe)]
        used, elems_new = mesh_lib.renumber([mesh_lib.reorder_tet(e, args.order) for e in raw])
        all_tags, all_xyz, _ = gmsh.model.mesh.getNodes()
        pos = {int(t): i for i, t in enumerate(all_tags)}
        coords = [[float(all_xyz[3 * pos[t] + k]) for k in range(3)] for t in used]
        new_id = {t: i + 1 for i, t in enumerate(used)}

        # 品質（minSICN: 1 に近いほど良い。0 以下は反転した要素）
        quality = mesh_lib.summarize_quality(list(gmsh.model.mesh.getElementQualities(list(map(int, tags)), 'minSICN')))
        if quality['badCount']:
            warnings.append(f'品質の悪い要素（minSICN < {quality["threshold"]}）が {quality["badCount"]} 個あります。'
                            '--size を小さくするか、形状の細かい部分を確かめてください')

        # --- 節点集合と面積の照合 ---
        shape_by_id = {f['id']: f for f in shape_faces}
        nsets, sel_report = {}, []
        for s in sels:
            ntags, _ = gmsh.model.mesh.getNodesForPhysicalGroup(2, pg_tags[s['name']])
            ids = sorted({new_id[int(t)] for t in ntags if int(t) in new_id})
            nsets[s['name']] = ids
            chk = mesh_lib.area_check([shape_by_id[i]['area'] for i in s['faceIds']],
                                      [gmsh.model.occ.getMass(2, id_to_tag[i]) for i in s['faceIds']])
            if chk['relDiff'] > AREA_WARN:
                warnings.append(f'選択 {s["name"]} の面積が、形状ワーカーとメッシュ側で {chk["relDiff"] * 100:.1f}% 違います'
                                '（1% 超）。STEP の単位と、選んだ面が合っているか確認してください')
            sel_report.append({'name': s['name'], 'faceIds': s['faceIds'], 'nodeCount': len(ids), 'area': chk})

        mesh_lib.write_inp(args.out, coords, elems_new, nsets, order=args.order,
                           header=f'  Gmsh {gmsh.__version__}')
        bbox = [min(c[k] for c in coords) for k in range(3)] + [max(c[k] for c in coords) for k in range(3)]
        report = {
            'ok': True, 'tool': 'gmsh', 'toolVersion': gmsh.__version__, 'meshUnit': 'm',
            'inp': args.out, 'order': args.order, 'elementType': 'C3D10' if args.order == 2 else 'C3D4',
            'size': args.size, 'minSize': min_size,
            'nodes': len(coords), 'elements': len(elems_new), 'bbox': bbox,
            'quality': quality, 'selections': sel_report, 'warnings': warnings,
            'timings': {'importSec': t_import, 'readSec': t_read, 'meshSec': t_mesh,
                        'totalSec': time.perf_counter() - t_start},
        }
    except Exception as e:  # 想定外の失敗も、最後の行の JSON で返す
        return fail(f'メッシュワーカーで想定外のエラーが起きました（{type(e).__name__}: {e}）。STEP と --size を確認し、直らなければこの内容を報告してください')
    finally:
        gmsh.finalize()

    try:
        with open(args.report, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    except OSError as e:
        return fail(f'レポートを書き出せません（{args.report}: {e}）。書き込める場所か確認してください')
    emit(report)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='Studio M メッシュワーカー（Gmsh。GPL のため別プロセス）')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('mesh', help='STEP から四面体メッシュを作り、CalculiX の .inp（メッシュだけ）に書く')
    p.add_argument('--step', required=True, help='読み込む STEP ファイル（絶対パス）')
    p.add_argument('--selections', required=True, help='名前つき選択の JSON（絶対パス）')
    p.add_argument('--out', required=True, help='書き出す .inp（絶対パス）')
    p.add_argument('--report', required=True, help='書き出すレポートの JSON（絶対パス）')
    p.add_argument('--size', type=float, default=0.01, help='要素の最大寸法 [m]')
    p.add_argument('--min-size', type=float, default=None, help='要素の最小寸法 [m]（既定は size / 6）')
    p.add_argument('--order', type=int, default=2, help='要素の次数（2 = C3D10、1 = C3D4）')
    a = ap.parse_args(argv)
    return mesh(a)


if __name__ == '__main__':
    sys.exit(main())
