# wheel の data 領域（<名前>-<版>.data/data/lib など）の共有ライブラリを、site フォルダーの中へ取り出す（標準ライブラリだけ）。
# gmsh の wheel は libgmsh を data/lib に入れており、`pip install --target` はそれを捨ててしまう。
# gmsh.py は <site>/lib・<site>/Lib・<site>/bin の中を探すので、同じ名前のフォルダーに入れれば見つかる。
# 使い方: python wheel_data.py <wheel> <site フォルダー>
import os
import re
import stat
import sys
import zipfile

WANT = re.compile(r'^[^/]+\.data/data/(lib|Lib|bin)/(.+)$')
SKIP_SUFFIX = ('.jl',)  # Julia 用の包み（使わない）


def extract(wheel: str, site: str) -> list:
    out = []
    with zipfile.ZipFile(wheel) as zf:
        for info in zf.infolist():
            m = WANT.match(info.filename)
            if not m or info.filename.endswith('/') or info.filename.endswith(SKIP_SUFFIX):
                continue
            dest = os.path.join(site, m.group(1), *m.group(2).split('/'))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with zf.open(info) as src, open(dest, 'wb') as dst:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    dst.write(chunk)
            os.chmod(dest, os.stat(dest).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            out.append(dest)
    return out


def main() -> int:
    if len(sys.argv) != 3:
        print('使い方: python wheel_data.py <wheel> <site フォルダー>', file=sys.stderr)
        return 2
    files = extract(sys.argv[1], sys.argv[2])
    print(f'{os.path.basename(sys.argv[1])}: data 領域の共有ライブラリ {len(files)} 個を取り出しました')
    return 0


if __name__ == '__main__':
    sys.exit(main())
