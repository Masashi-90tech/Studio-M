# CalculiX の実行ファイルと、それが使う共有ライブラリを 1 つのフォルダーにまとめる（標準ライブラリだけ）。
#   macOS: Homebrew の dylib（/opt/homebrew・/usr/local）を再帰的に集め、install_name_tool で読み込み先を
#          @executable_path/../lib/... に書き換え、ad-hoc 署名（codesign --force -s -）をやり直す。
#          Apple Silicon は署名のない（書き換えで壊れた）実行ファイルを起動しない。
#   Linux: ldd で集めてコピーするだけ。動かすときは LD_LIBRARY_PATH に lib を指定する。
# 使い方: python bundle_ccx.py --ccx <ccx のパス> --out <出力フォルダー>   → out/bin/ccx と out/lib/ ができる
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
def bundle_linux(ccx, out):
    bin_dir, lib_dir = os.path.join(out, 'bin'), os.path.join(out, 'lib')
    os.makedirs(bin_dir, exist_ok=True)
    os.makedirs(lib_dir, exist_ok=True)
    copy_file(ccx, os.path.join(bin_dir, 'ccx'))
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


def bundle_mac(ccx, out):
    bin_dir, lib_dir = os.path.join(out, 'bin'), os.path.join(out, 'lib')
    os.makedirs(bin_dir, exist_ok=True)
    os.makedirs(lib_dir, exist_ok=True)
    ccx_real = os.path.realpath(ccx)
    ccx_dst = os.path.join(bin_dir, 'ccx')
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
            new = ('@executable_path/../lib/' if is_exe else '@loader_path/') + name
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ccx', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    if not os.path.exists(a.ccx):
        print(f'エラー: ccx が見つかりません（{a.ccx}）', file=sys.stderr)
        return 1
    try:
        libs = bundle_mac(a.ccx, a.out) if sys.platform == 'darwin' else bundle_linux(a.ccx, a.out)
    except RuntimeError as e:
        print(f'エラー: {e}', file=sys.stderr)
        return 1
    print(json.dumps({'ccx': os.path.join(a.out, 'bin', 'ccx'), 'libs': libs}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
