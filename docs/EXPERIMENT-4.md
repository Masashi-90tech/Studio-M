# 実証実験 4: Mac（Apple Silicon）にエンジンごと配れるか

2026-11-18 に始めた。問いと合格の条件は `docs/PLATFORM-DESIGN.md` の 12 章。v0.6 はまず Mac で進める（`docs/DESKTOP.md`）。

## 問い

1. CalculiX と OpenFOAM を、Apple Silicon の Mac にどの経路で入れられるか
2. Electron に形状ワーカー（Python と OCCT）・Gmsh・CalculiX を入れたとき、配布サイズと起動時間はどれくらいか
3. 日本語や空白を含むパス（ユーザー名）で動くか
4. 以上をもとに、Python のワーカーを採用するか（`docs/PLATFORM-DESIGN.md` 14 章の決定 2）

## 事前の調査（2026-11-18、Linux のコンテナから）

【事実】は配布元の公開情報で確かめたもの、【仮説】は Mac での実測待ち。

### CalculiX

| 経路 | 内容 | 判断 |
|---|---|---|
| Homebrew の第三者の tap | `brew install costerwi/homebrew-calculix/calculix-ccx`。ccx 2.22、SPOOLES のマルチスレッド版と arpack-ng を使う。作者が M2 で確かめたと書いている【事実】。homebrew-core には入っていない【事実】 | **第一候補**。ソースからビルドする formula なので、gcc（gfortran）が入る【仮説】 |
| 自前のビルド | 公式のソースと Makefile。GitHub Actions の macOS arm64 ランナーでビルドして同梱する | 同梱の本命。上の tap のビルド手順を参考にする |
| MacPorts | 2022 年にポートの提案があるが、取り込まれたかは未確認 | 見送る |

同梱するには、ccx と、それが使う Homebrew の dylib（libgfortran・libquadmath・libgcc_s・arpack・OpenBLAS など）を一緒にコピーし、読み込み先を `@executable_path/../lib` に書き換える。Apple Silicon では、書き換えた実行ファイルに署名（自分用なら ad-hoc の `codesign -s -`）をし直さないと起動しない【事実: arm64 の macOS の仕様】。

### OpenFOAM

| 経路 | 内容 | サイズ | 判断 |
|---|---|---|---|
| OpenFOAM.app（gerlero/openfoam-app） | v2606・v2512 のネイティブのビルド。`brew install gerlero/openfoam/openfoam@2606`、または `openfoam2606-app.zip` を手で入れる。macOS 15 以降、Apple Silicon だけ（Intel は 2.1.2 で終了）。GPL-3.0【事実】 | 実測待ち | **第一候補**。Docker が要らず、ネイティブで速い【仮説】 |
| Docker（opencfd/openfoam-default） | 2406〜2512 に arm64 のイメージがある（圧縮で約 380 MB）【事実: Docker Hub】。既存の OpenFOAM アダプターは 2406 のイメージで動作確認済み | 約 380 MB（圧縮） + Docker Desktop | 代替。Docker Desktop の導入とメモリの割り当てが利用者の負担になる |
| 自前のビルド | openfoam.com の v2506 から Homebrew での macOS 対応が入った【事実】 | — | 見送る（保守が重い） |

OpenFOAM.app は `…/OpenFOAM-v2606.app/Contents/Resources/etc/openfoam` で環境を読み込んだシェルを開く【事実】。既存のアダプターは「bashrc を読み込んだ状態で起動する」前提なので、このラッパー経由で呼べるかを確かめる。

### 形状ワーカーとメッシュワーカー（Python の部品）

PyPI に、予備確認と同じ版の macOS arm64 の wheel がある【事実】。

| パッケージ | 版 | wheel（圧縮） | 備考 |
|---|---|---|---|
| cadquery-ocp | 8.0.1.1.0 | 63 MB（cp312） | `vtk==9.6.2` と `cadquery-ocp-proxy` に依存する |
| vtk | 9.6.2 | 約 100 MB | OCP が依存する。外せるかを確かめる（外せれば大きく減る） |
| gmsh | 4.15.2 | 36 MB | GPL-2.0-or-later。メッシュワーカーとしてフォルダーを分ける |
| numpy | 2.x | 6〜11 MB | |

Python 本体は python-build-standalone（Astral が配る、移動できる CPython）を使う案で測る。

## 測り方

キット: `experiments/exp4-packaging/`（アプリのコードではない。テストと CI の対象外）。Mac で 1 つのコマンドを実行すると、`results/` に JSON と Markdown の表ができる。手順はキットの README。

測る項目:

- 導入経路ごとの、入るか・かかった時間・ディスク使用量・版・小さな計算が通るか（ccx の片持ち梁、OpenFOAM の cavity）
- 既存の Studio M Engine がそれぞれを検出するか（`EngineStatus.engines`）
- 同梱物の部品ごとのサイズ（Electron、Python 本体、OCP、vtk、gmsh、ccx と dylib）、`.app` の合計、zip に固めたサイズ
- 起動時間: アプリの起動から画面表示まで、アプリ内のエンジンが応答するまで、形状ワーカーの初回（OCP の import と STEP の読み込み）、メッシュ、ccx の計算。初回（コールド）と 2 回目以降（ウォーム）を分ける
- 日本語と空白を含むパス（`~/Studio M テスト/`）にアプリと作業フォルダーを置いて、同じ一連の処理が通るか
- ダウンロードしたことにした（quarantine の属性を付けた）署名なしのアプリが、どう止められるか

合格の目安（PLATFORM-DESIGN の 12 章を Mac 向けに具体化）:

- インストール直後（追加の導入なし）に、STEP → 形状ワーカー → Gmsh → CalculiX が通り、円孔のある平板の応力集中係数が 3.149 の 3% 以内
- 日本語と空白を含むパスで同じ結果になる
- 配布サイズと起動時間を記録できる（数値そのものは合否にしない。Python 採用の判断材料にする）

## 結果

2026-11-19、MacBook Air（Apple M1、8 コア、16 GB、macOS 27.0.0、Node.js 24.14.0）で `experiments/exp4-packaging/run-all.sh` を実行した。キットの手順は `experiments/exp4-packaging/README.md`。

### 導入経路

| 経路 | 結果 |
|---|---|
| CalculiX: Homebrew の tap（`costerwi/calculix/calculix-ccx`） | 入った。版は 2.23（予備確認は 2.21）。実行ファイルの名前は `ccx_2.23`（`ccx` ではない）。本体 0.12 GB、依存を含めて 0.81 GB。梁の理論値との差 0.20%、0.1 秒 |
| OpenFOAM: OpenFOAM.app（brew で `gerlero/openfoam/openfoam@2606` を入れると `/Applications/OpenFOAM-v2606.app` に入る） | 入った。1.11 GB。**cavity（blockMesh と icoFoam）は通らなかった**。ログ（`run.log`）を残していないので原因は未確認（下の「残った問い」） |
| OpenFOAM: Docker | 測っていない（この Mac に Docker がない） |
| 既存の Studio M Engine の検出 | calculix・openfoam とも「使えない」。`ccx` や OpenFOAM のコマンドが PATH にないため。Pro ではアプリが同梱の ccx の場所を教える必要がある |

### 同梱物のサイズ（不要物を消したあと）

| 部品 | サイズ |
|---|---|
| Python 本体（python-build-standalone 3.12.11） | 44 MB |
| 形状ワーカー（cadquery-ocp 8.0.1.1.0 と numpy） | 0.85 GB。うち vtk が 0.57 GB、OCP が 0.22 GB |
| メッシュワーカー（gmsh 4.15.2 と numpy） | 13 MB + Gmsh の共有ライブラリ 79 MB |
| CalculiX（ccx 5 MB + 共有ライブラリ 26 MB） | 31 MB |
| 同梱物の合計 | 1.02 GB |
| Electron 45.2.2 を含めた `.app` | 1.35 GB（Electron 本体 0.25 GB、同梱物 1.11 GB） |
| zip（ditto）／dmg | 0.35 GB／0.42 GB |

vtk を外すだけで 0.57 GB 減る。`cadquery-ocp` から vtk だけを外す（`--no-deps`）やり方は、Mac でも動かなかった（`libvtkWrappingPythonCore` を読めない）。同じ版の別パッケージ `cadquery-ocp-novtk`（Mac arm64 の wheel あり、63 MB）は、Linux で import と STEP の読み書きが通り、サイズは 1.18 GB から 0.42 GB になった。Mac での確認はまだ（次の実行で行う）。

### 起動時間と一連の処理

| 項目 | コールド | ウォーム |
|---|---|---|
| アプリの起動（app ready／画面表示／エンジン応答） | 0.16 s／0.41 s／0.28 s | 0.05 s／0.25 s／0.14 s |
| 一連の処理（形状／メッシュ／ccx） | 0.7〜0.9 s／0.5〜1.5 s／1.3〜4.5 s | 0.7 s／0.45 s／1.25 s |
| アプリの起動から結果まで（全体） | 10.2 s | 6.1 s |
| 初めて OCP を読み込んだとき | 21.1 s（形状ワーカーの確認の 1 回目） | 0.5〜0.6 s |

- 平板の応力集中係数は 3.138（近似式 3.149 との差 0.33%）。通常のパス、日本語と空白を含むパス（`~/Studio M テスト/`）、アプリの中のどれでも同じ値になり、**合格の目安に入った**
- 「全体 6.1 s」のうち、形状・メッシュ・ccx の合計は約 2.4 s で、残り約 3.7 s の内訳は測っていない
- 初めて OCP を読み込むのに 21 秒かかった理由は確かめていない。インストール直後の大量のライブラリを macOS が初めて確かめる時間かもしれない（仮説）。2 回目以降は 0.5〜0.6 s

### CalculiX が時々間違った答えを出した

通常の一連の処理で、反力が 60292 N（差 213%）と 74954 N（差 2026%）になることが 2 回あった（正しくは 51434 N）。同じ入力で ccx だけを繰り返し実行して調べた。

| 設定 | 回数 | 正しい値 | 間違った値 |
|---|---|---|---|
| スレッド 1（全体） | 30 | 30 | 0 |
| スレッド 4（全体） | 30 | 28 | 2（52061 N・69821 N） |
| 連立方程式を解く部分（SPOOLES、`CCX_NPROC_EQUATION_SOLVER`）だけ 1、残り 4 | 60 | 60 | 0 |

原因は、連立方程式を解く部分の並列実行。入力は毎回同じで、日本語のパスとは関係ない。予備確認の 10.7% のずれと、Linux の試走の 8% のずれも、同じ原因の可能性が高い（未確認）。解く部分だけ 1 スレッドにすると正しく、速さも落ちなかった（平均 1.42 秒。全体を 1 スレッドにすると約 2.3 秒）。キットは、この設定を既定にした。

### 日本語と空白を含むパス

通る。ただし CalculiX は、結果ファイルの見出しに入力のパスを書き、日本語の文字の途中で切る。結果ファイル（`.frd`）が不正な UTF-8 になり、そのまま読むと後処理が落ちる。読めない文字を置き換えて読む対策を入れた（`ccx_tool.py`）。アプリでも同じ対策か、作業フォルダーを英数字だけにする対策が要る。macOS のユーザー名が日本語の場合は、測っていない。

### 署名なしのアプリ

`spctl -a -vv` は「code has no resources but signature indicates they must be present」と返した。署名は ad-hoc（Electron 本体のリンカーによるもの）で、アプリの中身（Resources）が封印されていない。Gatekeeper が実際に何と表示するかは、手で開いて確かめていない（README の「署名なしのアプリを開く」の手順）。

## 判断

| 問い | 判断 |
|---|---|
| CalculiX の同梱 | **同梱する**。Homebrew で入れた ccx 2.23 と依存のライブラリを集め、`@executable_path` に書き換えて ad-hoc で署名し直す方法で、31 MB。アプリの中でも動いた。実行時は連立方程式を解く部分を 1 スレッドにする。力の釣り合いの検算を必須にする。製品版では、Homebrew に頼らず GitHub Actions で自前のビルドにする（依存のライセンス文の同梱もここで行う） |
| Python のワーカー | **採用する**。条件は、vtk を使わない `cadquery-ocp-novtk` に切り替えること（Mac での動作は次の実行で確かめる）。切り替えれば、`.app` は約 0.8 GB、dmg は約 0.2〜0.3 GB の見込み（推定）。起動は 6 秒ほど、初回は読み込みに 20 秒かかる場合があるので、初回は進み具合を表示する |
| OpenFOAM の入れ方 | **未決**。OpenFOAM.app はインストールできたが cavity が通っていない。原因を調べてから決める。それまでは「追加パック。OpenFOAM.app を第一候補、Docker を代案」とする |
| アプリの署名 | 自分用の間は署名なしでよいが、配布を広げる前に Gatekeeper の実際の挙動を確かめる |

## 残った問い（次にやること）

1. キットを `cadquery-ocp-novtk` で Mac で流し直し、`import OCP` が通ること、vtk なしの `.app` のサイズを測る
2. OpenFOAM.app の cavity が通らない原因（`run.log`）。`WORK` を残して再実行する
3. 署名なしのアプリを手で開いたときの macOS の表示
4. Studio M Engine から同梱の ccx を使えるようにする（アダプターに、検出と実行で別の場所の ccx を渡す方法が要る）
5. アプリの中でエンジンを動かしたときの起動時間（`dist-engine/` を作って `.app` に入れる）
6. 日本語のユーザー名の Mac での動作、Intel の Mac、Windows
7. Docker 経路の測定

## 出典

- [costerwi/homebrew-calculix](https://github.com/costerwi/homebrew-calculix)、[CalculiX の掲示板の告知](https://calculix.discourse.group/t/homebrew-packages-for-ccx-and-cgx-for-macos/2729)
- [gerlero/openfoam-app](https://github.com/gerlero/openfoam-app)
- [Docker Hub: opencfd/openfoam-default](https://hub.docker.com/r/opencfd/openfoam-default)
- [OpenFOAM v2506 のリリース](https://www.openfoam.com/node/624)
- PyPI: [cadquery-ocp 8.0.1.1.0](https://pypi.org/project/cadquery-ocp/8.0.1.1.0/)、[gmsh 4.15.2](https://pypi.org/project/gmsh/4.15.2/)、[vtk](https://pypi.org/project/vtk/)
