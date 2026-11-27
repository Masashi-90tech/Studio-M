# フォルダーの中身を zip にする（標準ライブラリだけ）。Windows の Git Bash には zip コマンドがないため、全 OS でこれを使う。
# シンボリックリンクと実行権限を保つ（macOS・Linux の Python の bin/ や dylib のリンクが壊れないように）。
# 使い方: python zip_pack.py <固めるフォルダー> <出力する zip>   （zip の中は、フォルダーの中身が直下に並ぶ）
import os
import stat
import sys
import zipfile


def zip_dir(src: str, out: str) -> int:
    src = os.path.abspath(src)
    count = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for root, dirs, files in os.walk(src):
            dirs.sort()
            entries = [(d, True) for d in dirs] + [(f, False) for f in sorted(files)]
            keep = []
            for name, is_dir in entries:
                path = os.path.join(root, name)
                arc = os.path.relpath(path, src).replace(os.sep, '/')
                if os.path.islink(path):
                    info = zipfile.ZipInfo(arc)
                    info.create_system = 3  # Unix
                    info.external_attr = (stat.S_IFLNK | 0o777) << 16
                    zf.writestr(info, os.readlink(path))
                    count += 1
                elif is_dir:
                    keep.append(name)
                    zf.write(path, arc + '/')
                else:
                    zf.write(path, arc)
                    count += 1
            dirs[:] = keep  # リンクのフォルダーには入らない
    return count


def main() -> int:
    if len(sys.argv) != 3:
        print('使い方: python zip_pack.py <固めるフォルダー> <出力する zip>', file=sys.stderr)
        return 2
    if not os.path.isdir(sys.argv[1]):
        print(f'エラー: フォルダーがありません: {sys.argv[1]}', file=sys.stderr)
        return 1
    n = zip_dir(sys.argv[1], sys.argv[2])
    print(f'{n} 個のファイルを {sys.argv[2]} にしました')
    return 0


if __name__ == '__main__':
    sys.exit(main())
