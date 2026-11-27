# workers/: 形状ワーカーとメッシュワーカー（Python）

STEP を読んで面の一覧を返す**形状ワーカー**と、名前つきの選択から 2 次の四面体メッシュ（CalculiX の `.inp`、メッシュだけ）を作る**メッシュワーカー**。
どちらも別プロセスとして呼ばれ、結果は**標準出力の最後の行に JSON 1 つ**で返す（失敗は `{"ok":false,"error":"日本語の理由"}` で終了コード 1）。長さはすべて**メートル**。
設計は `docs/PLATFORM-DESIGN.md`（3・5・6 章）、試作と測定は `docs/EXPERIMENT-4.md`。同梱物の組み立てと検証は `docs/WORKERS-BUILD.md`。Engine への組み込みと、アプリへの同梱は次の作業。

## GPL の分け方

| フォルダー | 使うもの | ライセンス |
|---|---|---|
| `shape/` | cadquery-ocp-novtk（OCCT）、numpy | Apache-2.0（OCCT は LGPL-2.1 + 例外） |
| `mesh/` | gmsh、numpy | **GPL-2.0-or-later** |

Gmsh を import してよいのは `mesh/` だけ。`shape/` は gmsh を、`mesh/` は OCP を import しない。環境（site-packages）も分ける。両者の受け渡しはファイル（JSON・STEP・`.inp`）だけ。

## 入れ方（Python 3.12）

```bash
python3.12 -m venv <形状用の場所> && <形状用の場所>/bin/pip install -r workers/requirements-shape.txt
python3.12 -m venv <メッシュ用の場所> && <メッシュ用の場所>/bin/pip install -r workers/requirements-mesh.txt
# Linux の gmsh は libGLU.so.1 が要る: apt-get install -y libglu1-mesa
```

## 形状ワーカー

```bash
python shape/shape_worker.py inspect --step /abs/plate.step [--length-unit mm]
python shape/shape_worker.py make-test-plate --out /abs/plate.step      # 400×100×10 mm、直径 20 mm の円孔
```

`inspect` の JSON: `ok, tool, toolVersion, sourceUnit, toMeters, hash（STEP の SHA-256）, bbox, volume, area, solidCount, faces[], timings`。
`faces[]` は `id（F1…。種類→重心→面積の順で振る。同じファイルなら同じ ID）, type, area, centroid, bbox, neighbors, signature`。
単位は STEP の中の長さの単位を OCCT から読む。読めないときは `--length-unit` が必須。ファイルの単位と指定が食い違うときはエラー。

## メッシュワーカー

```bash
python mesh/mesh_worker.py mesh --step /abs/plate.step --selections /abs/selections.json \
    --out /abs/job.inp --report /abs/report.json [--size 0.01] [--order 2] [--min-size ...]
```

`selections.json`: `{"selections":[{"name":"FIXED","faceIds":["F2"]}], "faces":[inspect の faces]}`。名前は `[A-Z][A-Z0-9_]*`。
`.inp` は `*NODE`・`*ELEMENT, TYPE=C3D10`・`*NSET`（選択ごと）・`*ELSET, ELSET=EALL` だけ（材料・境界条件・ステップは Engine が足す）。
レポート: `nodes, elements, meshUnit("m"), bbox, quality(minSICN の最小・平均・悪い要素の数), selections[](nodeCount と面積の照合), warnings, timings`。
Gmsh には STEP をメートルで読ませる（`Geometry.OCCTargetUnit = "M"`。T は 1 つ）。

## 同梱物からの呼び方（Engine が使う形）

`workers/build/build-pack.sh` が作る `workers-pack/`（Python・`shape-site/`・`mesh-site/`・`scripts/`）を使うときは、同梱の Python に `PYTHONPATH` を 1 つだけ渡す。
Python は `python/bin/python3`（Windows は `python/python.exe`）。形状は `shape-site`、メッシュは `mesh-site` を、**別々のプロセスで**指す。

```bash
PYTHONPATH=<pack>/shape-site <pack>/python/bin/python3 <pack>/scripts/shape_worker.py inspect --step /abs/plate.step
PYTHONPATH=<pack>/mesh-site  <pack>/python/bin/python3 <pack>/scripts/mesh_worker.py mesh --step ... --selections ... --out ... --report ...
```

環境変数は `PYTHONNOUSERSITE=1`・`PYTHONDONTWRITEBYTECODE=1`（署名した `.app` の中に `.pyc` を書かない）・`PYTHONUTF8=1` を付け、`PYTHONHOME` は外す。
検証の例は `workers/tools/plate_check.py`（同じ呼び方で、STEP から応力集中係数まで通す）。

## テスト

```bash
cd workers && python -m pytest tests     # OCP・gmsh が入っていなければ実物のテストは skip。ccx があれば計算まで通す
```

ルートの `npm test`（vitest）には混ぜない。pytest は `workers/` で別に動かす（CI への追加は後で）。
`tests/test_plate_lib.py`・`test_build_tools.py`・`test_step_summary.py` は標準ライブラリだけで走る（検証・組み立て用スクリプトの純粋な部分）。
