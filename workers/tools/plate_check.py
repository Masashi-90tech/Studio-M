# 3D ワーカーの同梱物の検証: 円孔のある平板を STEP → 形状ワーカー → メッシュワーカー → CalculiX で解き、
# 応力集中係数が文献の近似式（3.149）の 3% 以内に入ることを確かめる（実験 4 の run-pipeline.mjs・ccx_tool.py を製品用に整えたもの。
# docs/EXPERIMENT-4.md、docs/WORKERS-BUILD.md）。標準ライブラリだけで書く（同梱物の Python で動く）。
#
# 使い方:
#   python plate_check.py --pack <workers-pack のフォルダー> --ccx <ccx の実行ファイルの絶対パス> [--out plate_check.json]
#                         [--work-base <作業フォルダーを作る場所>] [--size 0.01] [--skip-japanese-path]
# 流れ: 1 回目（コールド）→ 2 回目（ウォーム）→ 日本語と空白を含む作業フォルダー（<work-base>/Studio M テスト/）で 1 回。
# 合格の条件を全部検査して JSON に書く。1・2 回目のどれかが落ちたら終了コード 1。日本語パスの失敗は警告にとどめる
# （ccx・Gmsh・OCP が日本語のパスで動くかを実機で確かめるためで、全体の合否には入れない）。
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import plate_lib as P  # noqa: E402

# Windows の Python は標準出力が cp1252 などになり、日本語のメッセージを出すと UnicodeEncodeError で落ちる
# （本当のエラーが文字コードのエラーに隠れる）。UTF-8 に切り替える
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:  # noqa: BLE001  切り替えられない環境ではそのまま
        pass


class StageError(Exception):
    """ある段が失敗した。メッセージはそのまま利用者に見せる日本語。"""


def pack_paths(pack: str) -> dict:
    """同梱物の中のパス。Engine が後で使う呼び方と同じ（workers/README.md）。"""
    pack = os.path.abspath(pack)
    win = os.name == 'nt'
    py = os.path.join(pack, 'python', 'python.exe' if win else os.path.join('bin', 'python3'))
    return {
        'python': py,
        'shapeScript': os.path.join(pack, 'scripts', 'shape_worker.py'),
        'meshScript': os.path.join(pack, 'scripts', 'mesh_worker.py'),
        'shapeSite': os.path.join(pack, 'shape-site'),
        'meshSite': os.path.join(pack, 'mesh-site'),
    }


def base_env() -> dict:
    env = dict(os.environ)
    env.update({'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'})
    for k in ('PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP'):
        env.pop(k, None)
    return env


def exec_(cmd, cwd, env, timeout=900):
    t0 = time.perf_counter()
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise StageError(f'{os.path.basename(cmd[0])} が {timeout} 秒で終わりませんでした。マシンの負荷か、入力が大きすぎないか確認してください')
    except OSError as e:
        raise StageError(f'{cmd[0]} を起動できません（{e}）。同梱物のフォルダーの形と、実行権限を確認してください')
    sec = time.perf_counter() - t0
    # 出力は UTF-8 として読み、読めない文字は置き換える
    return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace'), sec


def worker(paths, kind, args, cwd, env_base):
    """ワーカーを別プロセスで呼び、(最後の行の JSON, かかった秒) を返す。失敗は StageError。"""
    site, script = (paths['shapeSite'], paths['shapeScript']) if kind == 'shape' else (paths['meshSite'], paths['meshScript'])
    env = dict(env_base, PYTHONPATH=site)
    rc, out, err, sec = exec_([paths['python'], script] + [str(a) for a in args], cwd, env)
    doc = P.last_json_line(out)
    label = '形状ワーカー' if kind == 'shape' else 'メッシュワーカー'
    if doc is None:
        tail = (err or out).strip().splitlines()[-4:]
        raise StageError(f'{label}の出力を読めません（終了コード {rc}）: {" / ".join(tail)}')
    if rc != 0 or not doc.get('ok'):
        raise StageError(f'{label}が失敗しました: {doc.get("error", "(理由なし)")}')
    return doc, sec


def ccx_env(env_base: dict, ccx: str) -> dict:
    env = dict(env_base)
    # 実験 4: SPOOLES の並列実行が時々間違った答えを出す。連立方程式を解く部分だけ 1 スレッドにする
    env['CCX_NPROC_EQUATION_SOLVER'] = '1'
    env['CCX_NPROC_RESULTS'] = '1'
    env.setdefault('OMP_NUM_THREADS', str(min(4, os.cpu_count() or 1)))
    d = os.path.dirname(os.path.abspath(ccx))
    lib = os.path.join(d, 'lib')
    libs = [x for x in (lib, d) if os.path.isdir(x)]
    if sys.platform == 'darwin':
        env['DYLD_FALLBACK_LIBRARY_PATH'] = os.pathsep.join(libs)
    elif sys.platform.startswith('linux'):
        env['LD_LIBRARY_PATH'] = os.pathsep.join(libs + ([env['LD_LIBRARY_PATH']] if env.get('LD_LIBRARY_PATH') else []))
    elif os.name == 'nt':
        env['PATH'] = os.pathsep.join(libs + [env.get('PATH', '')])
    return env


def run_once(paths, ccx, work, size, label, env_base):
    """1 回分: 形状 → メッシュ → ccx → 後処理 → 合否。各段の秒数と値を返す。失敗は StageError。"""
    os.makedirs(work, exist_ok=True)
    st = {}
    t_all = time.perf_counter()

    step = os.path.join(work, 'plate.step')
    made, sec = worker(paths, 'shape', ['make-test-plate', '--out', step], work, env_base)
    st['shapeMakeSec'] = sec
    st['ocpImportSec'] = (made.get('timings') or {}).get('importSec')  # この回の最初の OCP の import

    info, sec = worker(paths, 'shape', ['inspect', '--step', step], work, env_base)
    st['shapeInspectSec'] = sec
    st['ocpReadSec'] = (info.get('timings') or {}).get('readSec')

    try:
        fixed = P.pick_plane_face(info['faces'], 0, 0.0)
        load = P.pick_plane_face(info['faces'], 0, P.LENGTH_MM / 1000)
    except ValueError as e:
        raise StageError(str(e))
    sel = os.path.join(work, 'selections.json')
    with open(sel, 'w', encoding='utf-8') as f:
        json.dump({'selections': [{'name': 'FIXED', 'faceIds': [fixed['id']]},
                                  {'name': 'LOAD', 'faceIds': [load['id']]}], 'faces': info['faces']}, f)

    mesh_inp, report_json = os.path.join(work, 'mesh.inp'), os.path.join(work, 'report.json')
    rep, sec = worker(paths, 'mesh', ['mesh', '--step', step, '--selections', sel, '--out', mesh_inp,
                                      '--report', report_json, '--size', size, '--order', 2], work, env_base)
    st['meshSec'] = sec
    mt = rep.get('timings') or {}
    st['gmshImportSec'], st['gmshReadSec'], st['gmshMeshSec'] = mt.get('importSec'), mt.get('readSec'), mt.get('meshSec')

    try:
        with open(mesh_inp, encoding='utf-8') as f:
            mesh_text = f.read()
        job = P.build_job_inp(mesh_text, P.parse_nset_nodes(mesh_text, 'LOAD'))
    except (ValueError, OSError) as e:
        raise StageError(f'計算の入力（.inp）を作れません: {e}')
    with open(os.path.join(work, 'job.inp'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(job)

    rc, out, err, sec = exec_([ccx, '-i', 'job'], work, ccx_env(env_base, ccx))
    st['ccxSec'] = sec
    with open(os.path.join(work, 'job.log'), 'w', encoding='utf-8') as f:
        f.write(out + err)
    if rc != 0:
        tail = (out + err).strip().splitlines()[-4:]
        raise StageError(f'CalculiX が失敗しました（終了コード {rc}）: {" / ".join(tail)}。job.log を確認してください')

    t0 = time.perf_counter()
    try:
        with open(os.path.join(work, 'job.dat'), encoding='utf-8', errors='replace') as f:
            dat = f.read()
        reaction = P.parse_total_force(dat)
        smax_ip = P.parse_max_sxx_integration_point(dat)
        with open(os.path.join(work, 'job.frd'), encoding='utf-8', errors='replace') as f:
            smax_node = P.parse_frd_max_sxx(f)
    except (ValueError, OSError) as e:
        raise StageError(f'結果の読み取りに失敗しました: {e}')
    st['postSec'] = time.perf_counter() - t0

    w, t, d = P.WIDTH_MM / 1000, P.THICKNESS_MM / 1000, P.HOLE_MM / 1000
    kt = P.stress_concentration(smax_ip, P.LOAD_N, w, t)
    areas = {s['name']: s['area']['relDiff'] for s in rep.get('selections', [])}
    checks = P.evaluate_checks(
        kt, reaction, P.LOAD_N, areas,
        {'形状ワーカー': info['bbox'], 'メッシュ': rep['bbox']}, [0, 0, 0, P.LENGTH_MM / 1000, w, t])
    st['totalSec'] = time.perf_counter() - t_all
    return {
        'label': label, 'workDir': work, 'ok': all(c['ok'] for c in checks), 'checks': checks,
        'kt': kt, 'ktNode': P.stress_concentration(smax_node, P.LOAD_N, w, t), 'ktReference': P.KT_REFERENCE,
        'ktNetBased': P.stress_concentration(smax_ip, P.LOAD_N, w, t, d), 'ktNetReference': P.kt_reference_net(w, d),
        'sigmaMaxPa': smax_ip, 'nominalGrossPa': P.nominal_stress(P.LOAD_N, w, t), 'reactionN': reaction, 'loadN': P.LOAD_N,
        'mesh': {'nodes': rep.get('nodes'), 'elements': rep.get('elements'), 'size': float(size),
                 'minSICN': (rep.get('quality') or {}).get('min'), 'warnings': rep.get('warnings', [])},
        'stages': st,
    }


def ccx_version(ccx, env_base):
    try:
        rc, out, err, _ = exec_([ccx, '-v'], None, ccx_env(env_base, ccx), timeout=30)
        for l in (out + err).splitlines():
            if 'Version' in l:
                return l.strip()
    except StageError:
        pass
    return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='3D ワーカーの同梱物の検証（円孔のある平板の応力集中係数）')
    ap.add_argument('--pack', required=True, help='workers-pack のフォルダー（python/・shape-site/・mesh-site/・scripts/ がある場所）')
    ap.add_argument('--ccx', required=True, help='ccx の実行ファイルの絶対パス')
    ap.add_argument('--out', default='plate_check.json', help='結果の JSON の出力先')
    ap.add_argument('--work-base', default=None, help='作業フォルダーを作る場所（既定は一時フォルダー）')
    ap.add_argument('--size', default='0.01', help='要素の最大寸法 [m]（実験 4 と同じ程度）')
    ap.add_argument('--skip-japanese-path', action='store_true')
    a = ap.parse_args(argv)

    paths = pack_paths(a.pack)
    ccx = os.path.abspath(a.ccx)
    for k in ('python', 'shapeScript', 'meshScript', 'shapeSite', 'meshSite'):
        if not os.path.exists(paths[k]):
            print(f'エラー: 同梱物にありません: {paths[k]}（{k}）。build-pack.sh の出力のフォルダーを --pack に指定してください', file=sys.stderr)
            return 2
    if not os.path.isfile(ccx):
        print(f'エラー: ccx が見つかりません: {ccx}。build-ccx の成果物を展開した場所の ccx_<版> を絶対パスで指定してください', file=sys.stderr)
        return 2

    env_base = base_env()
    base = os.path.abspath(a.work_base or tempfile.gettempdir())
    os.makedirs(base, exist_ok=True)
    ascii_root = tempfile.mkdtemp(prefix='plate-check-', dir=base)
    result = {
        'ok': False, 'platform': platform.platform(), 'machine': platform.machine(), 'cpuCount': os.cpu_count(),
        'packPython': sys.version.split()[0], 'ccx': {'path': ccx, 'version': ccx_version(ccx, env_base)},
        'params': {'lengthMm': P.LENGTH_MM, 'widthMm': P.WIDTH_MM, 'thicknessMm': P.THICKNESS_MM, 'holeMm': P.HOLE_MM,
                   'loadN': P.LOAD_N, 'meshSizeM': float(a.size)},
        'runs': [], 'japanesePath': None, 'warnings': [], 'errors': [],
    }

    for label in ('cold', 'warm'):
        print(f'[{label}] 平板を解きます', file=sys.stderr)
        try:
            r = run_once(paths, ccx, os.path.join(ascii_root, label), a.size, label, env_base)
        except StageError as e:
            result['errors'].append(f'{label}: {e}')
            print(f'エラー（{label}）: {e}', file=sys.stderr)
            break
        result['runs'].append(r)
        print(f'  kt={r["kt"]:.4f}（目安 {P.KT_REFERENCE}）反力={r["reactionN"]:.1f} N 合計 {r["stages"]["totalSec"]:.1f} s '
              f'{"合格" if r["ok"] else "不合格"}', file=sys.stderr)
        for c in r['checks']:
            if not c['ok']:
                print(f'  不合格: {c["name"]}（値 {c["value"]}、期待 {c["expected"]}）', file=sys.stderr)

    ok_runs = len(result['runs']) == 2 and all(r['ok'] for r in result['runs'])
    result['ok'] = ok_runs and not result['errors']

    # 日本語と空白を含む作業フォルダー。失敗しても全体は止めず、警告にする
    if not a.skip_japanese_path and result['runs']:
        jp_dir = os.path.join(base, 'Studio M テスト')
        jp = {'path': jp_dir, 'ok': False}
        try:
            shutil.rmtree(jp_dir, ignore_errors=True)
            r = run_once(paths, ccx, os.path.join(jp_dir, 'plate'), a.size, 'japanese-path', env_base)
            ref = result['runs'][0]
            d = P.rel_diff(r['kt'], ref['kt'])
            jp.update({'ok': r['ok'] and d <= 1e-3, 'kt': r['kt'], 'reactionN': r['reactionN'], 'ktRelDiffVsAscii': d,
                       'stages': r['stages']})
            if not jp['ok']:
                jp['error'] = (f'係数が英数字のパスの結果と {d * 100:.3f}% 違うか、合格の条件を満たしませんでした'
                               if r['ok'] else '合格の条件を満たしませんでした')
        except StageError as e:
            jp['error'] = str(e)
        except OSError as e:
            jp['error'] = f'日本語のパスの作業フォルダーを作れません（{e}）'
        result['japanesePath'] = jp
        if not jp['ok']:
            msg = (f'日本語と空白を含む作業フォルダーで失敗しました: {jp.get("error")}。'
                   'Engine は、作業フォルダーを英数字だけの場所にする対策（STUDIO_M_WORK_ROOT）を ccx・Gmsh・OCP にも使うか検討してください')
            result['warnings'].append(msg)
            print(f'警告: {msg}', file=sys.stderr)
        shutil.rmtree(jp_dir, ignore_errors=True)

    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
        f.write('\n')
    if not os.environ.get('PLATE_CHECK_KEEP'):
        shutil.rmtree(ascii_root, ignore_errors=True)
    print(f'{"合格" if result["ok"] else "不合格"}: {a.out}')
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
