# 3D ワーカーの同梱ビルド（workers-pack）

形状ワーカー（OCCT）とメッシュワーカー（Gmsh）を、Python ごと 1 つのフォルダー（zip）にまとめ、macOS（Apple Silicon）と Windows（x64）で
STEP → 形状 → メッシュ → CalculiX を実際に解いて確かめる手順（`docs/DESKTOP.md` 8 番の続き）。実験 4（`docs/EXPERIMENT-4.md`）の Mac での手作業を、GitHub Actions で再現できる形にしたもの。
ccx の同梱（`docs/CCX-BUILD.md`）と同じ流儀で作る。Engine への組み込みとアプリへの同梱は次の作業。

## 誰が・いつ・どう実行するか

- 実行する人: リポジトリの管理者。ワーカー・wheel の版・組み立て手順を直したときだけ
- 実行の方法: GitHub の Actions で `build-workers` を手動実行（`workflow_dispatch`）。開発中は `workers/**` を変えて push すると動く（`push` のトリガーは開発用。main に入れる前に消す）
- 流れ: `build-ccx`（ccx の成果物）→ OS ごとに `build-pack.sh` → ccx を展開 → 同梱の Python で `plate_check.py` → 要約と成果物
- 成果物: `workers-macos-arm64`・`workers-windows-x64`（zip）、`plate_check-<os>`（`plate_check.json` と `manifest.json`）。ジョブの要約に、大きさと時間の表が出る

## 同梱物の形

```
workers-pack/
  python/                python-build-standalone 3.12.11（pip などは削除）
  shape-site/            cadquery-ocp-novtk, cadquery-ocp-proxy, numpy
  mesh-site/             gmsh（libgmsh は mesh-site/lib/）, numpy    ← GPL。別フォルダー
  scripts/               shape_worker.py, shape_lib.py, mesh_worker.py, mesh_lib.py（workers/ からコピー）
  THIRD-PARTY-LICENSES/workers/   ライセンス文、SOURCE.txt、WHEELS.txt（実際に使った wheel の SHA-256）
  manifest.json          版と、各フォルダー・部品ごとの大きさ [bytes]
```

呼び方（Engine が後で使う）は `workers/README.md`。形状は `PYTHONPATH=shape-site`、メッシュは `PYTHONPATH=mesh-site`。

## 作り方（workers/build/）

| ファイル | 役割 |
|---|---|
| `versions.env` | python-build-standalone の版・URL・SHA-256、wheel の版。`TODO` のままの SHA-256 は、実際の値を表示してわざと失敗する |
| `fetch.sh` | 取得と SHA-256 の検証（`desktop/tools/ccx/fetch.sh` と同じ流儀） |
| `build-pack.sh` | 取得 → 検証 → 展開 → wheel を取得して固定 → `--no-deps` で `shape-site`・`mesh-site` に別々に入れる → 不要物の削除 → スクリプトとライセンス文をコピー → 動作確認 → manifest → zip |
| `wheel_data.py` | `pip install --target` が捨てる wheel の `data/lib`（gmsh の libgmsh）を `mesh-site/lib/` に取り出す |
| `manifest.py`・`zip_pack.py` | `manifest.json` と zip（Windows の Git Bash には `zip` がないので全 OS で Python。リンクと実行権限を保つ） |

- 手元の Linux でも動く: `WORKERS_PLATFORM=linux-x64 bash workers/build/build-pack.sh <作業フォルダー>`（確認用。Python は未 strip で約 320 MB と大きい）
- 削るもの: `__pycache__`・`*.pyc`・`*.pyi`・`tests`/`test` フォルダー、pip・setuptools、`idlelib`・`turtledemo`・`ensurepip`、Python の `config-*`・`include`・`share`、numpy の起動スクリプト。**削ったあとに** OCP と gmsh を読み込み、`plate_check.py` を通して、壊れていないことを確かめる
- `.pyc` を消すので、初回の import は少し遅い。署名した `.app` の中に `.pyc` を書かないよう、実行時は `PYTHONDONTWRITEBYTECODE=1` にする
- macOS: 実行ファイルの隣の dylib をそのまま読み込める形で使う。動かないときは `WORKERS_RESIGN=1` で ad-hoc 署名をやり直せる（実機の確認結果は下の表）
- Windows のパス: `build-pack.sh` の中で `cygpath` を使い、bash 用（`/d/a/_temp`）と Windows のプログラム用（`D:/a/_temp`）を使い分ける

## 最初の実行の注意

1. `versions.env` の Python の SHA-256 は、配布元の `SHA256SUMS`（`python-build-standalone` の 20250902 のリリース）の値を書いてある。食い違ったときはビルドが止まり、実際の値を表示する
2. wheel は PyPI から `--only-binary=:all:` で取る。macOS・Windows の wheel（`cadquery-ocp-novtk` の `win_amd64`、`gmsh` など）が PyPI にない版だと、取得の段で止まる（その場合は版を確かめる）
3. SHA-256 つきの wheel の一覧は、同梱物の `THIRD-PARTY-LICENSES/workers/WHEELS.txt` と `manifest.json` に出る。`--require-hashes` での固定は未（OS ごとに wheel が違うため）

## 検証の中身（workers/tools/plate_check.py）

同梱の Python で実行する（標準ライブラリだけ）。400 × 100 × 10 mm・穴径 20 mm の平板を `make-test-plate` で作り、`inspect` → 選択（x=0 の面を `FIXED`、x=L の面を `LOAD`）→ `mesh`（C3D10、要素 0.01 m）→ 材料・境界条件・荷重・静解析を足した `.inp` → `ccx`（`CCX_NPROC_EQUATION_SOLVER=1`）→ 応力集中係数。

- 荷重は合計 50000 N（公称応力 50 MPa）。`LOAD` 面の節点の x 方向の変位を `*EQUATION` で 1 つの節点に束ね、その節点に合計荷重を掛ける（節点ごとの等分は 2 次の四面体では不釣り合い）。`FIXED` 面は 3 方向を拘束する（実験 4 と同じ）
- 係数は、積分点の σ_xx の最大 ÷ 公称応力。**公称応力は総断面（幅 × 厚み）で割る**。3.149 は総断面基準の値で、正味断面（（幅 − 穴径）× 厚み）で割ると近似式は 2.519 になる。JSON には正味断面基準の値も残す
- 合格の条件（全部検査して `plate_check.json` に書く。1 つでも落ちたら終了コード 1）: 係数が 3.149 の 3% 以内、反力が荷重と 1% 以内、`FIXED`・`LOAD` の面積の照合が 1% 以内、bbox が 0.4 × 0.1 × 0.01 m（形状ワーカーとメッシュの両方）
- 1 回目（コールド）と 2 回目（ウォーム）を流し、各段（OCP の初回 import、読み込み、メッシュ、ccx）の時間を JSON に入れる
- 日本語と空白を含む作業フォルダー（`<temp>/Studio M テスト/`）でも 1 回流し、同じ値になるか確かめる。**失敗しても全体は止めず、警告として要約に出す**（OpenFOAM は英数字だけのパスでないと動かないため、ccx・Gmsh・OCP がどうかを実機で確かめる）
- `.frd` は不正な UTF-8 に耐える（CalculiX が見出しに入力のパスを日本語の途中で切るため。実験 4）

## GPL の約束

- Gmsh（GPL-2.0-or-later）は `mesh-site/` の別フォルダー・別プロセスのメッシュワーカーだけが使う。`shape-site/` に入れず、メッシュワーカーは OCP を読み込まない。両者のやり取りはファイル（JSON・STEP・`.inp`）だけ。`build-pack.sh` が、形状側から gmsh が見えないこと・メッシュ側から OCP が見えないことを検査する
- OCCT（LGPL-2.1 + 例外条項）は共有ライブラリとして `shape-site/` に置き、差し替えられる形のままにする
- ライセンス文とソースの入手先は `THIRD-PARTY-LICENSES/workers/`（`SOURCE.txt`・`GMSH-NOTICE.txt`・`OCCT-NOTICE.txt`・`GPL-2.0.txt`・`LGPL-2.1.txt`・`Python-LICENSE.txt`・`numpy-LICENSE.txt`）。台帳は `docs/oss-ledger.json`（`bundled-separate-program` と `bundled`）
- 商用配布は予定しない（2026-11-13 の決定）。Gmsh を閉じたソースのソフトに組み込むなら商用ライセンスが要る（`docs/OSS.md`）

## 検証済みと未検証（2026-11-27 時点）

| 項目 | 状態 |
|---|---|
| Linux（x86_64、Python 3.12.11、apt の ccx 2.21）で `build-pack.sh` → 同梱物の Python で `plate_check.py` | 手元で確認済み。係数 3.153（近似式との差 0.13%）、反力 50000 N、日本語と空白のパスでも同じ値。同梱物は 900 MB（Python 323 MB・shape-site 439 MB・mesh-site 138 MB）、zip 228 MB。この確認で、`pip install --target` が libgmsh を捨てることを見つけて `wheel_data.py` を足した |
| macOS arm64 の `build-workers`（組み立て・動作確認・平板の検証） | **Actions で成功**（2026-11-27、6 回目の修正のあと 2 回目）。組み立て 24 秒、zip 112.5 MB。平板の応力集中係数 **3.1306**（目安 3.149 との差 0.58%）、反力 50,000 N、1 回の計算（形状 → メッシュ → ccx）はコールド 4.2 秒・ウォーム 3.3 秒 |
| Windows x64 の `build-workers` | **Actions で成功**（同上）。組み立て 65 秒、zip 139.1 MB。平板の応力集中係数 **3.1494**（差 0.01%）、反力 50,000 N、コールド・ウォームとも 5.2 秒 |
| 大きさ（部品ごと・zip）と起動時間（初回の OCP の import、各段） | zip は上のとおり。部品ごとの大きさと各段の時間は、成果物 `plate_check-<os>` の `plate_check.json`・`manifest.json` と、ジョブの要約にある（Linux の参考値: 展開後 900 MB、zip 228 MB） |
| 日本語と空白を含む作業フォルダー（macOS・Windows） | Linux では同じ値で通った。macOS・Windows の結果は `plate_check.json` に入っている（警告扱い。未集計） |
| 署名なしの `.app` の中で、同梱の Python・dylib が起動できること | 未確認（実験 4 では `.app` の中でも動いた。Actions の成果物は `.app` に入れる前の形） |
| OCCT の例外条項の全文の同梱 | 未（wheel にライセンス文が入っていないため、入手先だけ記載。配布を広げる前に追加する） |
| Python 3.13 以降・Intel の Mac・Linux 向けの配布 | 対象外 |
