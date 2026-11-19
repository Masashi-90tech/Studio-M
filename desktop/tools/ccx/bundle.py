# 製品版: CalculiX の実行ファイルと、それが使う共有ライブラリを 1 つのフォルダーにまとめる（標準ライブラリだけ）。
# 実験 4 の bundle_ccx.py（experiments/exp4-packaging/lib）が元。出力の形は desktop/src/bundled-tools.ts の
# findBundledCcx が探す形:
#   <out>/ccx/ccx_<版>（Windows は .exe）   <out>/ccx/lib/（共有ライブラリ。Windows は exe の隣に DLL）
#   <out>/THIRD-PARTY-LICENSES/ccx/（GPL-2.0 全文・SOURCE.txt・DEPENDENCIES.md）
#   macOS: Homebrew の dylib を集め、install_name_tool で読み込み先を @executable_path/lib に書き換え、
#          ad-hoc 署名（codesign --force -s -）をやり直す（Apple Silicon は署名のない実行ファイルを起動しない）。
#   Linux: ldd で集めてコピーするだけ（試験用。動かすときは LD_LIBRARY_PATH に lib を指定する）。
# 使い方: python3 bundle.py --ccx <ccx> --out <出力> --version 2.23 --licenses THIRD-PARTY-LICENSES/ccx
# 結果は標準出力の最後の行に JSON 1 つで返す。
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

MAC_SYSTEM_PREFIXES = ('/usr/lib/', '/System/', '/Library/Apple/')
BREW_PREFIXES = ('/opt/homebrew', '/usr/local')
LINUX_BASE = ('linux-vdso', 'ld-linux', 'libc.so', 'libm.so', 'libdl.so', 'libpthread.so', 'librt.so', 'libutil.so', 'libresolv.so')


def run(cmd, check=True):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} が失敗しました: {r.stderr.strip()}")
    return r.stdout


def copy_file(src, dst):
    shutil.copy2(os.path.realpath(src), dst)
    os.chmod(dst, 0o755)


# ---------- Linux ----------
def bundle_linux(ccx, exe_dst, lib_dir):
    os.makedirs(lib_dir, exist_ok=True)
    copy_file(ccx, exe_dst)
    seen = {}
    queue = [os.path.realpath(ccx)]
    while queue:
        f = queue.pop()
        for line in run(['ldd', f]).splitlines():
            m = re.match(r'\s*(\S+) => (\S+) \(', line)
            if not m:
                continue
            name, path = m.group(1), m.group(2)
            if name.startswith(LINUX_BASE) or name in seen or not os.path.exists(path):
                continue
            seen[name] = path
            copy_file(path, os.path.join(lib_dir, name))
            queue.append(os.path.realpath(path))
    return sorted(seen)


# ---------- macOS ----------
def otool_deps(path):
    lines = run(['otool', '-L', path]).splitlines()[1:]
    return [l.strip().split(' (')[0] for l in lines if l.strip()]


def otool_rpaths(path):
    out = run(['otool', '-l', path]).splitlines()
    rp = []
    for i, l in enumerate(out):
        if 'cmd LC_RPATH' in l:
            for j in range(i + 1, min(i + 4, len(out))):
                m = re.match(r'\s*path (\S+) ', out[j])
                if m:
                    rp.append(m.group(1))
    return rp


def resolve_mac(dep, loader_dir, rpaths):
    """依存の参照を実在するファイルに直す。システムのライブラリや見つからないものは None"""
    if dep.startswith(MAC_SYSTEM_PREFIXES):
        return None
    cands = []
    if dep.startswith('@rpath/'):
        rest = dep[len('@rpath/'):]
        for rp in rpaths + ['/opt/homebrew/lib', '/opt/homebrew/opt/gcc/lib/gcc/current', '/usr/local/lib']:
            rp = rp.replace('@loader_path', loader_dir).replace('@executable_path', loader_dir)
            cands.append(os.path.join(rp, rest))
    elif dep.startswith('@loader_path/'):
        cands.append(os.path.join(loader_dir, dep[len('@loader_path/'):]))
    elif dep.startswith(BREW_PREFIXES):
        cands.append(dep)
    for c in cands:
        if os.path.exists(c):
            return os.path.realpath(c)
    if dep.startswith(BREW_PREFIXES) or dep.startswith('@rpath/'):
        raise RuntimeError(f'依存ライブラリ {dep} が見つかりません。brew でその formula が入っているか確認してください')
    return None


def bundle_mac(ccx, exe_dst, lib_dir):
    os.makedirs(lib_dir, exist_ok=True)
    ccx_real = os.path.realpath(ccx)
    ccx_dst = exe_dst
    copy_file(ccx_real, ccx_dst)

    # 1. 依存を再帰的に集める（参照の文字列 → コピー後のファイル名）
    todo = [(ccx_real, ccx_dst)]  # (元の場所, コピー先)
    copied = {}                   # 元の実体のパス → ファイル名
    edges = {}                    # コピー先 → [(参照の文字列, ファイル名)]
    while todo:
        src, dst = todo.pop()
        rpaths = otool_rpaths(src)
        edges[dst] = []
        for dep in otool_deps(src):
            real = resolve_mac(dep, os.path.dirname(src), rpaths)
            if real is None:
                continue
            name = os.path.basename(dep)
            if real not in copied:
                if name in copied.values():
                    raise RuntimeError(f'同じ名前の別のライブラリがあります: {name}')
                copied[real] = name
                lib_dst = os.path.join(lib_dir, name)
                copy_file(real, lib_dst)
                todo.append((real, lib_dst))
            edges[dst].append((dep, copied[real]))
        # 自分自身の id（dylib のとき otool -L の先頭に出る）は下で付け直す

    # 2. 読み込み先の書き換え
    for dst, deps in edges.items():
        is_exe = dst == ccx_dst
        if not is_exe:
            run(['install_name_tool', '-id', '@loader_path/' + os.path.basename(dst), dst])
        for dep, name in deps:
            new = ('@executable_path/lib/' if is_exe else '@loader_path/') + name
            if dep != new:
                run(['install_name_tool', '-change', dep, new, dst], check=False)
        for rp in otool_rpaths(dst):
            if rp.startswith(BREW_PREFIXES):
                run(['install_name_tool', '-delete_rpath', rp, dst], check=False)

    # 3. ad-hoc 署名をやり直す（書き換えると署名が壊れ、Apple Silicon では起動できなくなる）
    for dst in edges:
        run(['codesign', '--force', '-s', '-', dst])

    # 4. 検算: Homebrew の場所への参照が残っていないか
    left = []
    for dst in edges:
        for dep in otool_deps(dst)[0 if dst == ccx_dst else 1:]:
            if dep.startswith(BREW_PREFIXES):
                left.append(f'{os.path.basename(dst)} → {dep}')
    if left:
        raise RuntimeError('書き換えきれていない参照があります: ' + '; '.join(left))
    return sorted(copied.values())


# ---------- Windows（MSYS2 MINGW64。未検証） ----------
def bundle_windows(ccx, exe_dst, lib_dir):
    """ldd で /mingw64 の DLL を集め、exe と同じフォルダーに置く（Windows は exe のフォルダーを先に探す）"""
    exe_dir = os.path.dirname(exe_dst)
    copy_file(ccx, exe_dst)
    seen = {}
    queue = [ccx]
    while queue:
        f = queue.pop()
        for line in run(['ldd', f]).splitlines():
            m = re.match(r'\s*(\S+) => (\S+) ', line)
            if not m:
                continue
            name, path = m.group(1), m.group(2)
            if not path.lower().startswith('/mingw64/') or name in seen:
                continue
            seen[name] = path
            copy_file(path, os.path.join(exe_dir, name))
            queue.append(path)
    return sorted(seen)


# ---------- ライセンス文 ----------
def copy_licenses(src, out):
    """THIRD-PARTY-LICENSES/ccx を、同梱フォルダーの ccx/ の隣（out/THIRD-PARTY-LICENSES/ccx）にコピーする"""
    if not os.path.isdir(src):
        raise RuntimeError(f'ライセンス文のフォルダーが見つかりません（{src}）。--licenses で THIRD-PARTY-LICENSES/ccx を指定してください')
    for need in ('GPL-2.0.txt', 'SOURCE.txt', 'DEPENDENCIES.md'):
        if not os.path.exists(os.path.join(src, need)):
            raise RuntimeError(f'{need} がありません（{src}）。ライセンス文なしでは同梱できません')
    dst = os.path.join(out, 'THIRD-PARTY-LICENSES', 'ccx')
    shutil.copytree(src, dst, dirs_exist_ok=True)
    return dst


def main():
    ap = argparse.ArgumentParser(description='ccx と共有ライブラリを <out>/ccx/ にまとめる')
    ap.add_argument('--ccx', required=True, help='ビルドした ccx の実行ファイル')
    ap.add_argument('--out', required=True, help='出力フォルダー（この中に ccx/ と THIRD-PARTY-LICENSES/ccx/ ができる）')
    ap.add_argument('--version', required=True, help='CalculiX の版（例 2.23）。ccx_<版> という名前にする')
    ap.add_argument('--licenses', required=True, help='THIRD-PARTY-LICENSES/ccx のフォルダー')
    a = ap.parse_args()
    if not os.path.exists(a.ccx):
        print(f'エラー: ccx が見つかりません（{a.ccx}）。ビルドが終わっているか確認してください', file=sys.stderr)
        return 1
    win = sys.platform in ('win32', 'msys', 'cygwin')
    ccx_dir = os.path.join(a.out, 'ccx')
    exe_dst = os.path.join(ccx_dir, f'ccx_{a.version}' + ('.exe' if win else ''))
    lib_dir = os.path.join(ccx_dir, 'lib')
    try:
        os.makedirs(ccx_dir, exist_ok=True)
        if win:
            libs = bundle_windows(a.ccx, exe_dst, lib_dir)
        elif sys.platform == 'darwin':
            libs = bundle_mac(a.ccx, exe_dst, lib_dir)
        else:
            libs = bundle_linux(a.ccx, exe_dst, lib_dir)
        lic = copy_licenses(a.licenses, a.out)
    except RuntimeError as e:
        print(f'エラー: {e}', file=sys.stderr)
        return 1
    print(json.dumps({'ccx': exe_dst, 'libs': libs, 'licenses': lic}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
