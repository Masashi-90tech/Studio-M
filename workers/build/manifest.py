# 同梱物（workers-pack）の manifest.json を作る（標準ライブラリだけ）。版と、各フォルダー・部品ごとの大きさ [bytes] を書く。
# 使い方: python manifest.py --pack <フォルダー> --platform macos-arm64 --workers-version 0.1.0
#                            --python-version 3.12.11 --wheels <wheels.tsv（名前<TAB>ファイル名<TAB>SHA-256）> [--commit <sha>]
import argparse
import json
import os
import re
import sys

FOLDERS = ('python', 'shape-site', 'mesh-site', 'scripts', 'THIRD-PARTY-LICENSES')


def tree_size(path: str) -> int:
    """フォルダーの中のファイルの大きさの合計 [bytes]。シンボリックリンクはたどらない。"""
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def site_versions(site: str) -> dict:
    """site-packages の *.dist-info から {名前: 版} を読む。"""
    out = {}
    for e in sorted(os.listdir(site)):
        m = re.match(r'^(.+?)-([0-9][^-]*)\.dist-info$', e)
        if m:
            out[m.group(1).replace('_', '-')] = m.group(2)
    return out


def parts(site: str, min_bytes: int = 1 << 20) -> list:
    """site-packages の直下の項目ごとの大きさ（1 MB 以上のものだけ。部品ごとの内訳を見るため）。"""
    res = []
    for e in sorted(os.listdir(site)):
        p = os.path.join(site, e)
        n = tree_size(p) if os.path.isdir(p) else os.lstat(p).st_size
        if n >= min_bytes:
            res.append({'name': e, 'bytes': n})
    return sorted(res, key=lambda x: -x['bytes'])


def build(a) -> dict:
    sizes = {f: tree_size(os.path.join(a.pack, f)) for f in FOLDERS if os.path.isdir(os.path.join(a.pack, f))}
    wheels = []
    if a.wheels and os.path.isfile(a.wheels):
        for line in open(a.wheels, encoding='utf-8'):
            cols = line.rstrip('\n').split('\t')
            if len(cols) == 3:
                wheels.append({'group': cols[0], 'file': cols[1], 'sha256': cols[2]})
    return {
        'workersVersion': a.workers_version, 'commit': a.commit or None, 'platform': a.platform,
        'python': {'version': a.python_version, 'source': 'python-build-standalone'},
        'shapeSite': site_versions(os.path.join(a.pack, 'shape-site')),
        'meshSite': site_versions(os.path.join(a.pack, 'mesh-site')),
        'wheels': wheels,
        'sizes': dict(sizes, total=sum(sizes.values()), manifestUnit='bytes'),
        'parts': {'shape-site': parts(os.path.join(a.pack, 'shape-site')), 'mesh-site': parts(os.path.join(a.pack, 'mesh-site'))},
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--pack', required=True)
    ap.add_argument('--platform', required=True)
    ap.add_argument('--workers-version', required=True)
    ap.add_argument('--python-version', required=True)
    ap.add_argument('--wheels', default=None)
    ap.add_argument('--commit', default=None)
    a = ap.parse_args()
    doc = build(a)
    with open(os.path.join(a.pack, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(json.dumps(doc['sizes'], ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
