#!/usr/bin/env python3
"""docs/PLATFORM-DESIGN.md から、Word（.docx）と PDF の設計書を作る。

使い方（リポジトリのルートで）:
    python3 docs/design/build-docs.py

必要なもの: pandoc、LibreOffice（soffice。PDF を作るときだけ）、Pillow は不要。
Word 版の本文は「Yu Gothic」（游ゴシック）で組む。PDF は、この PC にある日本語フォントで組む
（IPAGothic があればそれを使い、なければ Word 版と同じ指定のまま変換する）。
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'docs' / 'PLATFORM-DESIGN.md'
OUT_DOCX = ROOT / 'docs' / 'PLATFORM-DESIGN.docx'
OUT_PDF = ROOT / 'docs' / 'PLATFORM-DESIGN.pdf'

INK = '2D3142'
ACCENT = 'BF4520'
RULE = 'BFBFBF'
HEAD_FILL = 'F2F2F2'

# 図のキャプション（Markdown の alt 文字列 → 図番号つき）
CAPTIONS = {
    'design/architecture.png': '図 1　システム構成',
    'design/dataflow.png': '図 2　データの流れ',
}


def run(cmd: list[str], **kw) -> None:
    subprocess.run(cmd, check=True, **kw)


def prepare_markdown(text: str) -> str:
    """図に番号と幅を付け、パイプ表の列幅を中身の長さに合わせる。元のファイルは書き換えない。"""
    for path, caption in CAPTIONS.items():
        text = re.sub(r'!\[[^\]]*\]\(' + re.escape(path) + r'\)', f'![{caption}]({path}){{width=100%}}', text)

    lines = text.split('\n')
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        is_sep = i > 0 and re.fullmatch(r'\|(\s*:?-{3,}:?\s*\|)+', line.strip() or 'x') and lines[i - 1].lstrip().startswith('|')
        if not is_sep:
            out.append(line)
            i += 1
            continue
        header = out[-1]
        body: list[str] = []
        j = i + 1
        while j < len(lines) and lines[j].lstrip().startswith('|'):
            body.append(lines[j])
            j += 1
        rows = [header] + body
        ncol = len([c for c in header.strip().strip('|').split('|')])
        sums = [0.0] * ncol
        maxes = [0.0] * ncol
        for r in rows:
            cells = r.strip().strip('|').split('|')
            for k in range(min(ncol, len(cells))):
                n = float(len(cells[k].strip()))
                sums[k] += n
                maxes[k] = max(maxes[k], n)
        # 平均の文字数を主に、いちばん長いセルも少し考える（短い列が 1 字ずつ折り返さないように）
        lens = [0.65 * (x / len(rows)) + 0.35 * m for x, m in zip(sums, maxes)]
        # 長い列ほど広く。ただし短い列も読める幅を残す
        # pandoc は区切り線のダッシュの数を --columns（72）に対する比として使うので、合計を 72 にそろえる
        raw = [max(3.0, l) ** 0.75 for l in lens]
        total = sum(raw)
        widths = [max(6, int(round(72 * r / total))) for r in raw]
        out.append('|' + '|'.join('-' * w for w in widths) + '|')
        out.extend(body)
        i = j
    return '\n'.join(out)


def edit_styles(xml: str, font: str, mono: str, latin: str) -> str:
    xml = re.sub(r'\s+w:(ascii|hAnsi|eastAsia|cs)theme="[^"]*"', '', xml, flags=re.I)
    fonts = f'<w:rFonts w:ascii="{latin}" w:hAnsi="{latin}" w:eastAsia="{font}" w:cs="{latin}" />'
    xml = re.sub(r'<w:rFonts\s*/>', fonts, xml)
    xml = re.sub(
        r'<w:rPrDefault>.*?</w:rPrDefault>',
        '<w:rPrDefault><w:rPr>' + fonts + '<w:sz w:val="21" /><w:szCs w:val="21" />'
        '<w:lang w:val="en-US" w:eastAsia="ja-JP" w:bidi="ar-SA" /></w:rPr></w:rPrDefault>',
        xml, flags=re.S)
    xml = re.sub(r'<w:pPrDefault>.*?</w:pPrDefault>',
                 '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="320" w:lineRule="auto" /></w:pPr></w:pPrDefault>',
                 xml, flags=re.S)

    def restyle(style_id: str, ppr: str | None = None, rpr: str | None = None) -> None:
        nonlocal xml
        m = re.search(r'(<w:style [^>]*w:styleId="%s"[^>]*>)(.*?)(</w:style>)' % style_id, xml, re.S)
        if not m:
            return
        inner = m.group(2)
        if ppr is not None:
            inner = re.sub(r'<w:pPr>.*?</w:pPr>', '', inner, flags=re.S) + ppr
        if rpr is not None:
            inner = re.sub(r'<w:rPr>.*?</w:rPr>', '', inner, flags=re.S) + rpr
        xml = xml[:m.start()] + m.group(1) + inner + m.group(3) + xml[m.end():]

    color = f'<w:color w:val="{INK}" />'
    restyle('Title',
            '<w:pPr><w:keepNext /><w:spacing w:before="0" w:after="240" /><w:jc w:val="left" /></w:pPr>',
            f'<w:rPr><w:b /><w:bCs />{color}<w:sz w:val="40" /><w:szCs w:val="40" /></w:rPr>')
    restyle('Heading1',
            '<w:pPr><w:keepNext /><w:keepLines /><w:spacing w:before="480" w:after="160" />'
            f'<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="4" w:color="{ACCENT}" /></w:pBdr>'
            '<w:outlineLvl w:val="0" /></w:pPr>',
            f'<w:rPr><w:b /><w:bCs />{color}<w:sz w:val="30" /><w:szCs w:val="30" /></w:rPr>')
    restyle('Heading2',
            '<w:pPr><w:keepNext /><w:keepLines /><w:spacing w:before="320" w:after="120" /><w:outlineLvl w:val="1" /></w:pPr>',
            f'<w:rPr><w:b /><w:bCs />{color}<w:sz w:val="25" /><w:szCs w:val="25" /></w:rPr>')
    restyle('Heading3',
            '<w:pPr><w:keepNext /><w:keepLines /><w:spacing w:before="240" w:after="80" /><w:outlineLvl w:val="2" /></w:pPr>',
            f'<w:rPr><w:b /><w:bCs />{color}<w:sz w:val="22" /><w:szCs w:val="22" /></w:rPr>')
    restyle('BodyText', '<w:pPr><w:spacing w:before="0" w:after="120" /></w:pPr>')
    restyle('FirstParagraph', '<w:pPr><w:spacing w:before="0" w:after="120" /></w:pPr>')
    restyle('Compact', '<w:pPr><w:spacing w:before="20" w:after="20" w:line="280" w:lineRule="auto" /></w:pPr>')
    restyle('Caption', '<w:pPr><w:spacing w:before="60" w:after="240" /><w:jc w:val="center" /></w:pPr>',
            '<w:rPr><w:color w:val="555555" /><w:sz w:val="18" /><w:szCs w:val="18" /></w:rPr>')
    restyle('ImageCaption', '<w:pPr><w:spacing w:before="60" w:after="240" /><w:jc w:val="center" /></w:pPr>',
            '<w:rPr><w:color w:val="555555" /><w:sz w:val="18" /><w:szCs w:val="18" /></w:rPr>')
    restyle('CaptionedFigure', '<w:pPr><w:keepNext /><w:spacing w:before="120" w:after="0" /><w:jc w:val="center" /></w:pPr>')
    restyle('SourceCode', '<w:pPr><w:wordWrap w:val="off" /><w:shd w:val="clear" w:color="auto" w:fill="F6F6F6" />'
            '<w:spacing w:before="60" w:after="60" w:line="260" w:lineRule="auto" /></w:pPr>')
    restyle('VerbatimChar', rpr=f'<w:rPr><w:rFonts w:ascii="{mono}" w:hAnsi="{mono}" w:eastAsia="{font}" w:cs="{mono}" />'
            '<w:sz w:val="18" /><w:szCs w:val="18" /></w:rPr>')

    border = f'w:val="single" w:sz="4" w:space="0" w:color="{RULE}"'
    table = (
        '<w:style w:type="table" w:default="1" w:styleId="Table"><w:name w:val="Table" />'
        '<w:basedOn w:val="TableNormal" /><w:uiPriority w:val="59" /><w:qFormat />'
        '<w:pPr><w:spacing w:before="0" w:after="0" w:line="260" w:lineRule="auto" /></w:pPr>'
        '<w:rPr><w:sz w:val="18" /><w:szCs w:val="18" /></w:rPr>'
        '<w:tblPr><w:tblInd w:w="0" w:type="dxa" />'
        f'<w:tblBorders><w:top {border} /><w:left {border} /><w:bottom {border} /><w:right {border} />'
        f'<w:insideH {border} /><w:insideV {border} /></w:tblBorders>'
        '<w:tblCellMar><w:top w:w="40" w:type="dxa" /><w:left w:w="80" w:type="dxa" />'
        '<w:bottom w:w="40" w:type="dxa" /><w:right w:w="80" w:type="dxa" /></w:tblCellMar></w:tblPr>'
        '<w:tblStylePr w:type="firstRow"><w:rPr><w:b /><w:bCs /></w:rPr>'
        f'<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="{HEAD_FILL}" /></w:tcPr></w:tblStylePr>'
        '</w:style>')
    xml, n = re.subn(r'<w:style\b[^>]*w:styleId="Table"[^>]*>.*?</w:style>', table, xml, count=1, flags=re.S)
    if n != 1:
        raise RuntimeError('表のスタイル（Table）が見つかりません')
    return xml


FOOTER = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
          '<w:p><w:pPr><w:jc w:val="center" /></w:pPr>'
          '<w:r><w:rPr><w:color w:val="777777" /><w:sz w:val="16" /></w:rPr><w:fldChar w:fldCharType="begin" /></w:r>'
          '<w:r><w:rPr><w:color w:val="777777" /><w:sz w:val="16" /></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
          '<w:r><w:rPr><w:color w:val="777777" /><w:sz w:val="16" /></w:rPr><w:fldChar w:fldCharType="separate" /></w:r>'
          '<w:r><w:rPr><w:color w:val="777777" /><w:sz w:val="16" /></w:rPr><w:t>1</w:t></w:r>'
          '<w:r><w:rPr><w:color w:val="777777" /><w:sz w:val="16" /></w:rPr><w:fldChar w:fldCharType="end" /></w:r>'
          '</w:p></w:ftr>')

SECT = ('<w:sectPr><w:footerReference w:type="default" r:id="rIdStudioMFooter" />'
        '<w:pgSz w:w="11906" w:h="16838" />'
        '<w:pgMar w:top="1247" w:right="1134" w:bottom="1247" w:left="1134" w:header="567" w:footer="567" w:gutter="0" />'
        '</w:sectPr>')


W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def _w(tag: str) -> str:
    return '{%s}%s' % (W, tag)


# Word の XML は子要素の順番が決まっている（ECMA-376）。足すときはこの順に並べ直す
TBLPR_ORDER = ['tblStyle', 'tblpPr', 'tblOverlap', 'bidiVisual', 'tblStyleRowBandSize', 'tblStyleColBandSize',
               'tblW', 'jc', 'tblCellSpacing', 'tblInd', 'tblBorders', 'shd', 'tblLayout', 'tblCellMar', 'tblLook',
               'tblCaption', 'tblDescription']
TCPR_ORDER = ['cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders', 'shd', 'noWrap', 'tcMar',
              'textDirection', 'tcFitText', 'vAlign', 'hideMark']
RPR_FIRST = ['rStyle', 'rFonts', 'b', 'bCs']


def _put(parent, tag: str, order: list[str], attrs: dict[str, str] | None = None):
    """parent の子に tag を（あれば置き換えて）入れ、order の順に並べ直す。"""
    from lxml import etree
    for old in parent.findall(_w(tag)):
        parent.remove(old)
    el = etree.SubElement(parent, _w(tag))
    for k, v in (attrs or {}).items():
        el.set(_w(k), v)
    kids = list(parent)
    rank = {t: i for i, t in enumerate(order)}
    kids.sort(key=lambda e: rank.get(etree.QName(e).localname, len(order)))
    for k in kids:
        parent.remove(k)
    parent.extend(kids)
    return el


PPR_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr',
             'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap',
             'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid',
             'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection',
             'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange']
RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline',
             'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w',
             'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign',
             'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath']
STYLE_ORDER = ['name', 'aliases', 'basedOn', 'next', 'link', 'autoRedefine', 'hidden', 'uiPriority', 'semiHidden',
               'unhideWhenUsed', 'qFormat', 'locked', 'personal', 'personalCompose', 'personalReply', 'rsid',
               'pPr', 'rPr', 'tblPr', 'trPr', 'tcPr', 'tblStylePr']


def normalize_order(xml: str) -> str:
    """styles.xml の pPr・rPr・style の子要素を、スキーマの順に並べ直す。"""
    from lxml import etree
    root = etree.fromstring(xml.encode('utf-8'))

    def sort_children(el, order):
        rank = {t: i for i, t in enumerate(order)}
        kids = [k for k in el if isinstance(k.tag, str)]
        kids.sort(key=lambda e: rank.get(etree.QName(e).localname, len(order)))
        for k in list(el):
            el.remove(k)
        el.text = None
        el.extend(kids)
        for k in kids:
            k.tail = None

    for el in root.iter(_w('pPr')):
        sort_children(el, PPR_ORDER)
    for el in root.iter(_w('rPr')):
        sort_children(el, RPR_ORDER)
    for el in root.iter(_w('style')):
        sort_children(el, STYLE_ORDER)
    return etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True).decode('utf-8')


SETTINGS_ORDER = (
    'writeProtection view zoom removePersonalInformation removeDateAndTime doNotDisplayPageBoundaries '
    'displayBackgroundShape printPostScriptOverText printFractionalCharacterWidth printFormsData embedTrueTypeFonts '
    'embedSystemFonts saveSubsetFonts saveFormsData mirrorMargins alignBordersAndEdges bordersDoNotSurroundHeader '
    'bordersDoNotSurroundFooter gutterAtTop hideSpellingErrors hideGrammaticalErrors activeWritingStyle proofState '
    'formsDesign attachedTemplate linkStyles stylePaneFormatFilter stylePaneSortMethod documentType mailMerge '
    'revisionView trackRevisions doNotTrackMoves doNotTrackFormatting documentProtection autoFormatOverride '
    'styleLockTheme styleLockQFSet defaultTabStop autoHyphenation consecutiveHyphenLimit hyphenationZone '
    'doNotHyphenateCaps showEnvelope summaryLength clickAndTypeStyle defaultTableStyle evenAndOddHeaders '
    'bookFoldRevPrinting bookFoldPrinting bookFoldPrintingSheets drawingGridHorizontalSpacing '
    'drawingGridVerticalSpacing displayHorizontalDrawingGridEvery displayVerticalDrawingGridEvery '
    'doNotUseMarginsForDrawingGridOrigin drawingGridHorizontalOrigin drawingGridVerticalOrigin doNotShadeFormData '
    'noPunctuationKerning characterSpacingControl printTwoOnOne strictFirstAndLastChars noLineBreaksAfter '
    'noLineBreaksBefore savePreviewPicture doNotValidateAgainstSchema saveInvalidXml ignoreMixedContent '
    'alwaysShowPlaceholderText doNotDemarcateInvalidXml saveXmlDataOnly useXSLTWhenSaving saveThroughXslt '
    'showXMLTags alwaysMergeEmptyNamespace updateFields hdrShapeDefaults footnotePr endnotePr compat docVars rsids '
    'mathPr attachedSchema themeFontLang clrSchemeMapping doNotIncludeSubdocsInStats doNotAutoCompressPictures '
    'forceUpgrade captions readModeInkLockDown smartTagType schemaLibrary shapeDefaults doNotEmbedSmartTags '
    'decimalSymbol listSeparator').split()


def normalize_settings(xml: str) -> str:
    """pandoc の settings.xml は子要素の順番が規格と違うので、規格の順に並べ直す。"""
    from lxml import etree
    root = etree.fromstring(xml.encode('utf-8'))
    rank = {t: i for i, t in enumerate(SETTINGS_ORDER)}
    kids = [k for k in root if isinstance(k.tag, str)]
    kids.sort(key=lambda e: rank.get(etree.QName(e).localname, len(SETTINGS_ORDER)))
    for k in list(root):
        root.remove(k)
    root.extend(kids)
    return etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True).decode('utf-8')


def direct_table_format(doc: str) -> str:
    """LibreOffice は表スタイルの罫線や見出し行の色を描かないので、表ごとに直接書く。幅は本文いっぱいにする。"""
    from lxml import etree
    root = etree.fromstring(doc.encode('utf-8'))
    text_width = 9638  # A4 の幅 11906 から左右の余白 1134 ずつを引いた値（twip）
    for tbl in root.iter(_w('tbl')):
        tblpr = tbl.find(_w('tblPr'))
        if tblpr is None:
            tblpr = etree.Element(_w('tblPr'))
            tbl.insert(0, tblpr)
        _put(tblpr, 'tblW', TBLPR_ORDER, {'type': 'dxa', 'w': str(text_width)})
        borders = _put(tblpr, 'tblBorders', TBLPR_ORDER)
        for side in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']:
            b = etree.SubElement(borders, _w(side))
            for k, v in {'val': 'single', 'sz': '4', 'space': '0', 'color': RULE}.items():
                b.set(_w(k), v)
        _put(tblpr, 'tblLayout', TBLPR_ORDER, {'type': 'fixed'})

        grid = tbl.find(_w('tblGrid'))
        cols = grid.findall(_w('gridCol')) if grid is not None else []
        widths = [int(c.get(_w('w'), '0')) for c in cols]
        if widths and sum(widths) > 0:
            k = text_width / sum(widths)
            widths = [int(w * k) for w in widths]
            for c, w in zip(cols, widths):
                c.set(_w('w'), str(w))

        for tr in tbl.findall(_w('tr')):
            trpr = tr.find(_w('trPr'))
            header = trpr is not None and trpr.find(_w('tblHeader')) is not None
            for i, tc in enumerate(tr.findall(_w('tc'))):
                tcpr = tc.find(_w('tcPr'))
                if tcpr is None:
                    tcpr = etree.Element(_w('tcPr'))
                    tc.insert(0, tcpr)
                if i < len(widths):
                    _put(tcpr, 'tcW', TCPR_ORDER, {'type': 'dxa', 'w': str(widths[i])})
                if not header:
                    continue
                _put(tcpr, 'shd', TCPR_ORDER, {'val': 'clear', 'color': 'auto', 'fill': HEAD_FILL})
                for r in tc.iter(_w('r')):
                    rpr = r.find(_w('rPr'))
                    if rpr is None:
                        rpr = etree.Element(_w('rPr'))
                        r.insert(0, rpr)
                    for tag in ['b', 'bCs']:
                        if rpr.find(_w(tag)) is None:
                            _put(rpr, tag, RPR_FIRST)
    # 表の直後に 6pt の空きを入れる（次の段落が表にくっつかないように）
    for tbl in list(root.iter(_w('tbl'))):
        gap = etree.Element(_w('p'))
        ppr = etree.SubElement(gap, _w('pPr'))
        sp = etree.SubElement(ppr, _w('spacing'))
        for k, v in {'before': '0', 'after': '0', 'line': '120', 'lineRule': 'exact'}.items():
            sp.set(_w(k), v)
        tbl.addnext(gap)
    # pandoc の出力にも順番の崩れがあるので、段落と文字の書式を並べ直す
    for tag, order in (('pPr', PPR_ORDER), ('rPr', RPR_ORDER)):
        rank = {t: i for i, t in enumerate(order)}
        for el in root.iter(_w(tag)):
            kids = [k for k in el if isinstance(k.tag, str)]
            kids.sort(key=lambda e: rank.get(etree.QName(e).localname, len(order)))
            for k in list(el):
                el.remove(k)
            el.extend(kids)
    return etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True).decode('utf-8')


def finish_docx(docx: Path, font: str, mono: str, latin: str) -> None:
    """styles.xml を差し替え、A4・余白・ページ番号を入れ、フォルダーの項目を除いて詰め直す。"""
    tmp = docx.with_suffix('.tmp.docx')
    with zipfile.ZipFile(docx) as zin, zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            if item.filename.endswith('/'):
                continue
            data = zin.read(item.filename)
            if item.filename == 'word/styles.xml':
                data = normalize_order(edit_styles(data.decode('utf-8'), font, mono, latin)).encode('utf-8')
            elif item.filename == 'word/document.xml':
                s = data.decode('utf-8')
                s = re.sub(r'<w:sectPr\s*/>|<w:sectPr\b.*?</w:sectPr>', '', s, flags=re.S)
                s = direct_table_format(s)
                s = s.replace('</w:body>', SECT + '</w:body>')
                if 'xmlns:r=' not in s[:2000]:
                    s = s.replace('<w:document ', '<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ', 1)
                data = s.encode('utf-8')
            elif item.filename == 'word/_rels/document.xml.rels':
                s = data.decode('utf-8')
                s = s.replace('</Relationships>',
                              '<Relationship Id="rIdStudioMFooter" '
                              'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" '
                              'Target="footer1.xml" /></Relationships>')
                data = s.encode('utf-8')
            elif item.filename == 'word/settings.xml':
                data = normalize_settings(data.decode('utf-8')).encode('utf-8')
            elif item.filename == 'word/numbering.xml':
                s = data.decode('utf-8')
                s = re.sub(r'(<w:nsid w:val=")([0-9A-Fa-f]{1,7})(")', lambda m: m.group(1) + m.group(2).rjust(8, '0') + m.group(3), s)
                data = s.encode('utf-8')
            elif item.filename == '[Content_Types].xml':
                s = data.decode('utf-8')
                if 'Extension="png"' not in s:
                    s = s.replace('<Default ', '<Default Extension="png" ContentType="image/png" /><Default ', 1)
                s = s.replace('</Types>',
                              '<Override PartName="/word/footer1.xml" '
                              'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml" /></Types>')
                data = s.encode('utf-8')
            zout.writestr(item, data)
        zout.writestr('word/footer1.xml', FOOTER)
    tmp.replace(docx)


def build_docx(md: Path, out: Path, resource: Path, font: str, mono: str, latin: str) -> None:
    run(['pandoc', str(md), '-f', 'markdown-citations-tex_math_dollars-superscript-subscript-smart-yaml_metadata_block',
         '-t', 'docx', '-o', str(out),
         '--resource-path', str(resource), '--shift-heading-level-by=-1',
         '--metadata', 'lang=ja-JP'])
    finish_docx(out, font, mono, latin)


def has_font(name: str) -> bool:
    try:
        out = subprocess.run(['fc-list', ':family=' + name], capture_output=True, text=True).stdout
        return bool(out.strip())
    except FileNotFoundError:
        return False


def main() -> int:
    if not shutil.which('pandoc'):
        print('pandoc が見つかりません。https://pandoc.org/installing.html から入れてください', file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory() as d:
        work = Path(d)
        md = work / 'design.md'
        md.write_text(prepare_markdown(SRC.read_text(encoding='utf-8')), encoding='utf-8')
        resource = SRC.parent

        build_docx(md, OUT_DOCX, resource, font='Yu Gothic', mono='Consolas', latin='Yu Gothic')
        print('作成:', OUT_DOCX.relative_to(ROOT))

        soffice = shutil.which('soffice') or shutil.which('libreoffice')
        if not soffice:
            print('LibreOffice（soffice）が見つからないので、PDF は作りませんでした', file=sys.stderr)
            return 0
        if has_font('IPAGothic'):
            latin = 'Liberation Sans' if has_font('Liberation Sans') else 'DejaVu Sans'
            pdf_src = work / 'PLATFORM-DESIGN.docx'
            build_docx(md, pdf_src, resource, font='IPAGothic', mono='DejaVu Sans Mono', latin=latin)
        else:
            pdf_src = work / 'PLATFORM-DESIGN.docx'
            shutil.copy(OUT_DOCX, pdf_src)
        run([soffice, '--headless', '--convert-to', 'pdf', '--outdir', str(work), str(pdf_src)],
            stdout=subprocess.DEVNULL)
        shutil.copy(work / 'PLATFORM-DESIGN.pdf', OUT_PDF)
        print('作成:', OUT_PDF.relative_to(ROOT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
