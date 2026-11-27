# 同梱物の大きさと、平板の検証の結果・時間を、GitHub Actions のジョブの要約（Markdown）にする（標準ライブラリだけ）。
# 使い方: python step_summary.py --title "macOS (arm64)" --manifest manifest.json --zip workers.zip --check plate_check.json >> "$GITHUB_STEP_SUMMARY"
# どの入力も、なければ飛ばす（ビルドや検証が途中で落ちたときも、分かる範囲を出す）。
import argparse
import json
import os
import sys

STAGES = [('shapeMakeSec', '形状: 平板を作る（コールドは OCP の初回 import を含む）'), ('ocpImportSec', '  うち OCP の import'),
          ('shapeInspectSec', '形状: STEP を読む（inspect）'), ('meshSec', 'メッシュ（Gmsh）'),
          ('gmshImportSec', '  うち gmsh の import'), ('ccxSec', 'CalculiX'), ('postSec', '結果の読み取り'),
          ('totalSec', '合計')]


def mb(n) -> str:
    return f'{n / 1e6:,.1f} MB' if n is not None else '-'


def sec(v) -> str:
    return f'{v:.2f} s' if isinstance(v, (int, float)) else '-'


def load(path):
    if path and os.path.isfile(path):
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    return None


def render(title, manifest, zip_bytes, check) -> str:
    out = [f'## 3D ワーカーの同梱物: {title}', '']
    if manifest:
        s = manifest['sizes']
        out += ['### 大きさ（展開後）', '', '| 部分 | 大きさ |', '|---|---|']
        names = {'python': 'python/（Python 本体）', 'shape-site': 'shape-site/（形状ワーカーの部品）',
                 'mesh-site': 'mesh-site/（メッシュワーカーの部品。GPL の Gmsh）', 'scripts': 'scripts/',
                 'THIRD-PARTY-LICENSES': 'THIRD-PARTY-LICENSES/'}
        for k, label in names.items():
            if k in s:
                out.append(f'| {label} | {mb(s[k])} |')
        out.append(f'| **合計** | **{mb(s["total"])}** |')
        if zip_bytes is not None:
            out.append(f'| zip | {mb(zip_bytes)} |')
        out += ['', '部品ごと（1 MB 以上）:', '']
        for site, items in manifest.get('parts', {}).items():
            out.append(f'- {site}: ' + '、'.join(f'{p["name"]} {mb(p["bytes"])}' for p in items))
        out += ['', f'版: Python {manifest["python"]["version"]}、shape-site {manifest["shapeSite"]}、mesh-site {manifest["meshSite"]}', '']
    else:
        out += ['同梱物の manifest.json がありません（組み立てで失敗した可能性があります。ログを確認してください）。', '']
    if check:
        out += [f'### 平板の検証: {"合格" if check["ok"] else "**不合格**"}', '']
        out += [f'CalculiX: {check["ccx"].get("version")}、Python {check["packPython"]}、{check["platform"]}', '']
        runs = check['runs']
        if runs:
            out += ['| 項目 | ' + ' | '.join(r['label'] for r in runs) + ' |', '|---|' + '---|' * len(runs)]
            out.append('| 応力集中係数（目安 3.149） | ' + ' | '.join(f'{r["kt"]:.4f}' for r in runs) + ' |')
            out.append('| 反力 [N]（荷重 ' + f'{runs[0]["loadN"]:.0f}） | ' + ' | '.join(f'{r["reactionN"]:.1f}' for r in runs) + ' |')
            for key, label in STAGES:
                out.append(f'| {label} | ' + ' | '.join(sec(r['stages'].get(key)) for r in runs) + ' |')
            out.append('')
            bad = [c for r in runs for c in r['checks'] if not c['ok']]
            for c in bad:
                out.append(f'- 不合格: {c["name"]}（値 {c["value"]}、期待 {c["expected"]}）')
        for e in check.get('errors', []):
            out.append(f'- エラー: {e}')
        jp = check.get('japanesePath')
        if jp:
            out.append(f'- 日本語と空白を含む作業フォルダー: {"同じ値になった" if jp["ok"] else "**失敗**（警告。全体の合否には入れていません）: " + str(jp.get("error"))}')
        for w in check.get('warnings', []):
            out.append(f'- 警告: {w}')
        out.append('')
    else:
        out += ['平板の検証の結果（plate_check.json）がありません。', '']
    return '\n'.join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--title', required=True)
    ap.add_argument('--manifest')
    ap.add_argument('--zip')
    ap.add_argument('--check')
    a = ap.parse_args()
    zb = os.path.getsize(a.zip) if a.zip and os.path.isfile(a.zip) else None
    sys.stdout.write(render(a.title, load(a.manifest), zb, load(a.check)) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
