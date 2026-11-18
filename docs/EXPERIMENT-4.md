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

（Mac で測ったあとに記入する）

## 判断

（結果をもとに、CalculiX の同梱方法、OpenFOAM の入れ方、Python のワーカーの採否を書く）

## 出典

- [costerwi/homebrew-calculix](https://github.com/costerwi/homebrew-calculix)、[CalculiX の掲示板の告知](https://calculix.discourse.group/t/homebrew-packages-for-ccx-and-cgx-for-macos/2729)
- [gerlero/openfoam-app](https://github.com/gerlero/openfoam-app)
- [Docker Hub: opencfd/openfoam-default](https://hub.docker.com/r/opencfd/openfoam-default)
- [OpenFOAM v2506 のリリース](https://www.openfoam.com/node/624)
- PyPI: [cadquery-ocp 8.0.1.1.0](https://pypi.org/project/cadquery-ocp/8.0.1.1.0/)、[gmsh 4.15.2](https://pypi.org/project/gmsh/4.15.2/)、[vtk](https://pypi.org/project/vtk/)
