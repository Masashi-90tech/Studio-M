# Diagram Design スキル（SKILL.md）の規則に沿って、構成図とデータフロー図を単体の HTML（インライン SVG）として作る。
import os
HERE = os.path.dirname(os.path.abspath(__file__))
PAPER, CARD, INK, MUTED, SOFT, ACCENT, TINT, STORE = '#f5f5f5', '#ffffff', '#2d3142', '#6b7080', '#9aa0ae', '#bf4520', '#f7e4dc', '#e9e8e3'
SANS = "'Geist','Hiragino Sans','Yu Gothic UI','Noto Sans JP','Noto Sans CJK JP',sans-serif"
MONO = "'Geist Mono','SFMono-Regular',Menlo,Consolas,'Noto Sans Mono CJK JP','Noto Sans JP',monospace"
SERIF = "'Instrument Serif','Hiragino Mincho ProN','Yu Mincho','Noto Serif JP','Noto Serif CJK JP',serif"

def defs():
    m = lambda i, c: f'<marker id="{i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="{c}"/></marker>'
    return '<defs>' + m('arrow', MUTED) + m('arrow-accent', ACCENT) + '</defs>'

def zone(x, y, w, h, label, dashed=False, bottom=False):
    d = ' stroke-dasharray="6,4"' if dashed else ''
    ly = y + h if bottom else y
    lw = sum(11.6 if ord(ch) > 255 else 7.2 for ch in label) + 16
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="none" stroke="{SOFT}" stroke-width="1"{d}/>'
            f'<rect x="{x+16}" y="{ly-8}" width="{lw:.0f}" height="16" fill="{PAPER}"/>'
            f'<text x="{x+24}" y="{ly+4}" font-family="{MONO}" font-size="11" letter-spacing="0.6" fill="{MUTED}">{label}</text>')

def node(x, y, w, h, tag, name, sub, kind='step'):
    fill, stroke, dash, sw = {'step': (CARD, INK, '', 1), 'focal': (TINT, ACCENT, '', 1.5), 'store': (STORE, INK, '', 1),
                              'external': (PAPER, MUTED, '', 1), 'optional': (CARD, MUTED, ' stroke-dasharray="5,4"', 1), 'input': (CARD, INK, '', 1)}[kind]
    tagc = ACCENT if kind == 'focal' else MUTED
    tw = len(tag)*6.4 + 12
    s = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{PAPER}"/>'
    s += f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{dash}/>'
    if kind == 'store':
        s += f'<line x1="{x+10}" y1="{y+h-6}" x2="{x+w-10}" y2="{y+h-6}" stroke="{INK}" stroke-width="1" opacity="0.35"/>'
    s += f'<rect x="{x+12}" y="{y+12}" width="{tw:.0f}" height="15" rx="2" fill="none" stroke="{tagc}" stroke-width="0.8"/>'
    s += f'<text x="{x+12+tw/2:.1f}" y="{y+23}" text-anchor="middle" font-family="{MONO}" font-size="9" letter-spacing="0.8" fill="{tagc}">{tag}</text>'
    s += f'<text x="{x+12}" y="{y+50}" font-family="{SANS}" font-size="15" font-weight="600" fill="{INK}">{name}</text>'
    s += f'<text x="{x+12}" y="{y+68}" font-family="{MONO}" font-size="10.5" fill="{MUTED}">{sub}</text>'
    return s

def path(points, accent=False, dashed=False, r=8):
    """直交の折れ線（角は r=8 の丸み）。points は [(x, y), ...] で、隣どうしは x か y が等しい"""
    c = ACCENT if accent else MUTED
    d = f'M{points[0][0]},{points[0][1]}'
    for i in range(1, len(points)):
        (x0, y0), (x1, y1) = points[i-1], points[i]
        assert x0 == x1 or y0 == y1, ('斜めの線は不可', points)
        if i < len(points)-1:
            x2, y2 = points[i+1]
            ux, uy = (x1-x0 > 0) - (x1-x0 < 0), (y1-y0 > 0) - (y1-y0 < 0)
            vx, vy = (x2-x1 > 0) - (x2-x1 < 0), (y2-y1 > 0) - (y2-y1 < 0)
            d += f' L{x1-ux*r},{y1-uy*r} Q{x1},{y1} {x1+vx*r},{y1+vy*r}'
        else:
            d += f' L{x1},{y1}'
    dash = ' stroke-dasharray="5,4"' if dashed else ''
    return f'<path d="{d}" fill="none" stroke="{c}" stroke-width="{1.5 if accent else 1.2}"{dash} marker-end="url(#{"arrow-accent" if accent else "arrow"})"/>'

def label(cx, cy, text, accent=False):
    w = sum(11 if ord(ch) > 255 else 6.6 for ch in text) + 12
    return (f'<rect x="{cx-w/2:.1f}" y="{cy-9}" width="{w:.1f}" height="18" fill="{PAPER}"/>'
            f'<text x="{cx}" y="{cy+4}" text-anchor="middle" font-family="{MONO}" font-size="10.5" letter-spacing="0.4" fill="{ACCENT if accent else MUTED}">{text}</text>')

def callout(x, y, lines):
    return ''.join(f'<text x="{x}" y="{y+i*18}" font-family="{SERIF}" font-style="italic" font-size="14.5" fill="{INK}" opacity="0.85">{t}</text>' for i, t in enumerate(lines))

def legend(y, width, items):
    s = f'<line x1="48" y1="{y}" x2="{width-48}" y2="{y}" stroke="{SOFT}" stroke-width="0.8"/>'
    x = 48
    for kind, text in items:
        yy = y + 28
        if kind == 'arrow': s += f'<line x1="{x}" y1="{yy}" x2="{x+26}" y2="{yy}" stroke="{MUTED}" stroke-width="1.2" marker-end="url(#arrow)"/>'
        elif kind == 'dash': s += f'<line x1="{x}" y1="{yy}" x2="{x+26}" y2="{yy}" stroke="{MUTED}" stroke-width="1.2" stroke-dasharray="5,4" marker-end="url(#arrow)"/>'
        elif kind == 'accent-arrow': s += f'<line x1="{x}" y1="{yy}" x2="{x+26}" y2="{yy}" stroke="{ACCENT}" stroke-width="1.5" marker-end="url(#arrow-accent)"/>'
        else:
            fill, stroke, dash = {'focal': (TINT, ACCENT, ''), 'step': (CARD, INK, ''), 'store': (STORE, INK, ''), 'external': (PAPER, MUTED, ''), 'optional': (CARD, MUTED, ' stroke-dasharray="4,3"')}[kind]
            s += f'<rect x="{x}" y="{yy-8}" width="26" height="16" rx="3" fill="{fill}" stroke="{stroke}" stroke-width="1"{dash}/>'
        s += f'<text x="{x+34}" y="{yy+4}" font-family="{SANS}" font-size="11.5" fill="{MUTED}">{text}</text>'
        x += 34 + sum(11.5 if ord(ch) > 255 else 6.4 for ch in text) + 28
    return s

def page(slug, eyebrow, h1, title, desc, w, h, body, top=0):
    return f'''<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{h1}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&family=Noto+Sans+JP:wght@400;600&display=swap" rel="stylesheet">
<style>
  body {{ margin: 0; background: {PAPER}; color: {INK}; font-family: {SANS}; }}
  main {{ max-width: {w}px; margin: 0 auto; padding: 40px 24px 48px; }}
  .eyebrow {{ font-family: {MONO}; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: {MUTED}; margin: 0 0 8px; }}
  h1 {{ font-family: {SERIF}; font-weight: 400; font-size: 34px; line-height: 1.2; margin: 0 0 20px; }}
  .wrap {{ overflow-x: auto; }}
  svg {{ display: block; width: 100%; min-width: {w}px; height: auto; }}
</style></head><body><main>
<p class="eyebrow">{eyebrow}</p><h1>{h1}</h1>
<div class="wrap"><svg id="{slug}" viewBox="0 {top} {w} {h-top}" role="img" aria-labelledby="{slug}-title {slug}-desc" xmlns="http://www.w3.org/2000/svg">
<title id="{slug}-title">{title}</title><desc id="{slug}-desc">{desc}</desc>{defs()}
<rect y="{top}" width="{w}" height="{h-top}" fill="{PAPER}"/>{body}</svg></div>
</main></body></html>'''

# ---------- 図1: システム構成 ----------
W, H = 1056, 640
b = ''
b += zone(48, 72, 952, 136, 'アプリ本体 · MIT')
b += zone(48, 312, 952, 136, '外部エンジン · 別プロセス · 各ライセンス', dashed=True, bottom=True)
# 矢印（箱より先に描く）
b += path([(320, 140), (404, 140)], accent=True)                      # GUI → 中核
b += path([(644, 140), (732, 140)])                                   # 中核 → 保管
for k, (ax, level, cx) in enumerate([(444, 240, 156), (484, 268, 340), (524, None, 524), (564, 268, 708), (604, 240, 892)]):
    pts = [(ax, 180), (ax, 336)] if level is None else [(ax, 180), (ax, level), (cx, level), (cx, 336)]
    b += path(pts, dashed=(k == 4))
b += path([(972, 140), (1024, 140), (1024, 520), (976, 520)])         # 保管 → 外部ソフト
b += label(362, 122, 'IPC', accent=True)
b += label(688, 122, '成果物')
b += label(560, 296, 'CTX.RUN')
b += node(72, 100, 248, 80, 'UI', '統合 GUI と 3D ビューア', 'Electron · three.js', 'input')
b += node(404, 100, 240, 80, 'CORE', 'オーケストレーター', 'Studio M Engine · ジョブ · 来歴', 'focal')
b += node(732, 100, 240, 80, 'STORE', 'プロジェクト保管', 'manifest.json + artifacts/', 'store')
b += node(72, 336, 168, 80, 'GEOM', '形状ワーカー', 'OCCT 8 · 面ID', 'step')
b += node(256, 336, 168, 80, 'MESH', 'メッシュワーカー', 'Gmsh · snappyHexMesh', 'step')
b += node(440, 336, 168, 80, 'SOLVE', 'ソルバー', 'OpenFOAM · CalculiX', 'step')
b += node(624, 336, 168, 80, 'POST', '結果処理ワーカー', 'VTK · 断面 · 流線', 'step')
b += node(808, 336, 168, 80, 'CAM', 'CAM ワーカー', 'Phase 3', 'optional')
b += node(736, 480, 240, 80, 'EXT', '外部ソフト', 'ParaView · FreeCAD · KiCad', 'external')
b += callout(72, 504, ['GPL のエンジンは実行ファイルとして呼ぶだけ。', 'アプリ本体には組み込まない。'])
b += legend(H-56+8, W, [('focal', '中核'), ('step', 'ワーカー（差し替え可）'), ('store', '保管'), ('optional', '後の段階'), ('external', '外部'), ('dash', '任意の経路')])
open(os.path.join(HERE, 'architecture.html'), 'w').write(page('architecture', 'Studio M · 基本設計 · 図 1', 'システム構成', 'Studio M のシステム構成',
    '統合 GUI がオーケストレーターに指示し、オーケストレーターが形状・メッシュ・ソルバー・結果処理の各ワーカーを別プロセスとして実行して、成果物をプロジェクト保管に記録する。', W, H, b, top=40))

# ---------- 図2: データの流れ ----------
W, H = 1216, 560
xs = [48, 240, 432, 624, 816, 1008]; y0 = 168; bw, bh = 160, 80
b = ''
b += zone(24, 96, 1168, 360, 'プロジェクト保管 · すべての成果物に 内容ハッシュ · 作成ツールの版 · 入力の参照 を記録')
for i in range(5):
    b += path([(xs[i]+bw, y0+40), (xs[i+1], y0+40)])
b += path([(xs[2]+80, y0), (xs[2]+80, 128), (xs[4]+80, 128), (xs[4]+80, y0)])            # 選択 → ケース（境界条件）
b += path([(xs[5]+52, y0+bh), (xs[5]+52, 300), (xs[4]+80, 300), (xs[4]+80, 344)])        # 結果 → 検証
b += path([(xs[5]+108, y0+bh), (xs[5]+108, 344)])                                                     # 結果 → 表示
b += path([(xs[4]+bw, 384), (xs[5], 384)])                                                            # 検証 → 表示
b += path([(xs[4], 384), (xs[3]+80, 384), (xs[3]+80, y0+bh)], dashed=True)                            # 検証 → メッシュ（細かくして再計算）
b += label((xs[2]+xs[4])/2+80, 128, '条件は面の名前に結ぶ')
b += label(xs[3]+80-8-50, 304, '細かくして再計算')
names = [('IN', 'CAD ファイル', 'STEP · STL', 'input'), ('GEOM', '形状', 'B-rep · 面ID · 署名', 'step'), ('SEL', '名前付き選択', 'inlet · wall · 固定面', 'focal'),
         ('MESH', 'メッシュ', 'グループ · 品質', 'step'), ('CASE', '解析ケース', '材料 · 条件 · 設定', 'step'), ('RUN', '実行と結果', '版 · 入力ハッシュ · 場', 'step')]
for x, (tag, name, sub, kind) in zip(xs, names):
    b += node(x, y0, bw, bh, tag, name, sub, kind)
b += node(xs[4], 344, bw, bh, 'V&V', '検証記録', '収束 · 保存則 · 基準解', 'focal')
b += node(xs[5], 344, bw, bh, 'OUT', '表示とレポート', '3D · Excel · VTK', 'external')
b += callout(48, 330, ['形状を差し替えたら、面の署名で選択を引き継ぐ。', '引き継げない面は「要確認」にして、計算を止める。'])
b += legend(H-56+8, W, [('focal', '追跡と精度の要'), ('step', '成果物'), ('external', '出力'), ('dash', '収束スタディの繰り返し')])
open(os.path.join(HERE, 'dataflow.html'), 'w').write(page('dataflow', 'Studio M · 基本設計 · 図 2', 'データの流れ', 'Studio M のデータの流れ',
    'CAD ファイルから形状、名前付き選択、メッシュ、解析ケース、実行と結果、検証記録、表示までの成果物の流れ。境界条件は面の名前に結び、検証で不足があればメッシュを細かくして再計算する。', W, H, b, top=56))
print('ok')
