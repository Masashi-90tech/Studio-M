# CalculiX（ccx）の同梱ビルド

Studio M Pro に入れる ccx を、公式のソースから GitHub Actions で作る手順（`docs/DESKTOP.md` 4 番の残り）。
Homebrew の ccx には頼らない（実験 4 の手順を製品版にしたもの。`docs/EXPERIMENT-4.md`）。

## 誰が・いつ・どう実行するか

- 実行する人: リポジトリの管理者。CalculiX の版を上げたとき、またはビルド手順を直したときだけ
- 実行の方法: GitHub の Actions で `build-ccx` を手動実行（`workflow_dispatch`）、または `ccx-v2.23` のように `ccx-v` で始まるタグを push する
- 流れ: `build-macos.sh`（Windows は `build-windows.sh`）→ `bundle.py` → `smoke.mjs` → `ccx-macos-arm64.zip`（`ccx-windows-x64.zip`）をアップロード
- 成果物の置き場: ワークフローの成果物を、Release（`ccx-v2.23` など）の添付に上げる。アプリのビルドは、その zip を `desktop` の同梱フォルダーに展開して使う（`ccx/ccx_<版>` と `ccx/lib/`、隣に `THIRD-PARTY-LICENSES/ccx/`）

## 版の上げ方

1. `desktop/tools/ccx/versions.env` の `CCX_VERSION`・URL・`CCX_SHA256` を直す。SHA-256 は公式の値と照らして書く（`TODO` のままだと、ビルドは実際の値を表示してわざと失敗する）
2. `THIRD-PARTY-LICENSES/ccx/SOURCE.txt` の版と SHA-256、`docs/oss-ledger.json` を揃える
3. Actions を実行し、`smoke.mjs` が合格することを確かめる

## 検証の中身（smoke.mjs）

日本語と空白を含む一時フォルダーで片持ち梁を解き、先端のたわみが理論値 PL³/3EI と 2% 以内であること、`CCX_NPROC_EQUATION_SOLVER=1` で 5 回走らせて毎回同じ値になることを確かめる（SPOOLES の並列実行が時々間違った答えを出したため）。

## GPL の約束

- ccx（GPL-2.0）は**別の実行ファイル**として同梱し、Studio M（MIT）とはコマンドとファイルでだけやり取りする。リンクしない
- ライセンス文（`THIRD-PARTY-LICENSES/ccx/GPL-2.0.txt`）と依存の一覧を同梱する
- ソースの入手先と SHA-256 を `SOURCE.txt` に書く。アプリの「このアプリについて」にも同じ入手先を書く（アプリ側の作業は未）
- ビルドに使ったパッチ（`desktop/tools/ccx/patches/`）はリポジトリに残す

## 検証済みと未検証（2026-11-19 時点）

| 項目 | 状態 |
|---|---|
| `bundle.py` の macOS の手順（dylib の集め方・書き換え・署名） | 実験 4 の `bundle_ccx.py` で Mac 上で動作確認済み。製品用に整えた版は未実行 |
| `smoke.mjs` の純粋な部分 | Linux でテスト済み。偽の ccx での一連の流れも確認 |
| `build-macos.sh`（ソースからのビルド） | 未実行。SPOOLES の `Make.inc`、ccx の Makefile の差し替え（sed）は、最初の Actions で直す前提 |
| `build-windows.sh`・Windows のジョブ | 未検証（実機でも Actions でも未実行） |
| ソースの SHA-256 | 未確認（`TODO`）。ネットワークのある環境で取得して書く |
| `GPL-2.0.txt` | Debian の `common-licenses/GPL-2` から取った。公式の LICENSE と照らして確かめる |
| 依存のライセンス表記（`DEPENDENCIES.md`） | 要確認の印がついたものがある |
