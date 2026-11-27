# ジョブの要約（workers/tools/step_summary.py）のテスト。
import json

import step_summary as S



def test_render_with_everything_and_with_nothing():
    manifest = {'sizes': {'python': 44_000_000, 'shape-site': 230_000_000, 'mesh-site': 90_000_000, 'scripts': 40_000,
                          'THIRD-PARTY-LICENSES': 100_000, 'total': 364_140_000},
                'parts': {'shape-site': [{'name': 'OCP', 'bytes': 150_000_000}], 'mesh-site': []},
                'python': {'version': '3.12.11'}, 'shapeSite': {'numpy': '2.5.5'}, 'meshSite': {'gmsh': '4.15.2'}}
    stages = {'shapeMakeSec': 6.0, 'ocpImportSec': 5.9, 'totalSec': 9.0}
    run = lambda label, ok: {'label': label, 'kt': 3.14, 'reactionN': -50000.0, 'loadN': 50000.0, 'stages': stages,
                             'checks': [{'name': 'x', 'ok': ok, 'value': 1, 'expected': 2}]}
    check = {'ok': False, 'ccx': {'version': 'Version 2.23'}, 'packPython': '3.12.11', 'platform': 'p',
             'runs': [run('cold', True), run('warm', False)], 'errors': [],
             'japanesePath': {'ok': False, 'error': '失敗した'}, 'warnings': ['警告文']}
    md = S.render('テスト', manifest, 123_000_000, check)
    assert '364.1 MB' in md and '| zip | 123.0 MB |' in md and 'OCP 150.0 MB' in md
    assert '| cold | warm |' in md and '不合格' in md and '**失敗**' in md and '警告: 警告文' in md and '6.00 s' in md
    empty = S.render('テスト', None, None, None)
    assert 'manifest.json がありません' in empty and 'plate_check.json）がありません' in empty
    json.dumps(check)
