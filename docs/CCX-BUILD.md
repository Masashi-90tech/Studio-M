# CalculiX（ccx）の同梱ビルド

Studio M Pro に入れる ccx を、公式のソースから GitHub Actions で作る手順（`docs/DESKTOP.md` 4 番の残り）。
Homebrew の ccx には頼らない（実験 4 の手順を製品版にしたもの。`docs/EXPERIMENT-4.md`）。

## 誰が・いつ・どう実行するか

- 実行する人: リポジトリの管理者。CalculiX の版を上げたとき、またはビルド手順を直したときだけ
- 実行の方法: GitHub の Actions で `build-ccx` を手動実行（`workflow_dispatch`）、または `ccx-v2.23` のように `ccx-v` で始まるタグを push する
- 流れ: `build-macos.sh`（Windows は `build-windows.sh`）→ `bundle.py` → `smoke.mjs` → `ccx-macos-arm64.zip`（`ccx-windows-x64.zip`）をアップロード
- 成果物の置き場: ワークフローの成果物を、Release（`ccx-v2.23` など）の添付に上げる。アプリのビルドは、その zip を `desktop` の同梱フォルダーに展開して使う（`ccx/ccx_<版>` と `ccx/lib/`、隣に `THIRD-PARTY-LICENSES/ccx/`）

## 版の上げ方

1. `desktop/tools/ccx/versions.env` の `CCX_VERSION`・URL・`CCX_SHA256` を直す。SHA-256 は取得して書く（公式は公開していない。`TODO` のままだと、ビルドは実際の値を表示してわざと失敗する）
2. `THIRD-PARTY-LICENSES/ccx/SOURCE.txt` の版と SHA-256、`docs/oss-ledger.json` を揃える
3. Actions を実行し、`smoke.mjs` が合格することを確かめる

## 検証の中身（smoke.mjs）

日本語と空白を含む一時フォルダーで片持ち梁を解き、先端のたわみが理論値 PL³/3EI と 2% 以内であること、`CCX_NPROC_EQUATION_SOLVER=1` で 5 回走らせて毎回同じ値になることを確かめる（SPOOLES の並列実行が時々間違った答えを出したため）。

## GPL の約束

- ccx（GPL-2.0）は**別の実行ファイル**として同梱し、Studio M（MIT）とはコマンドとファイルでだけやり取りする。リンクしない
- ライセンス文（`THIRD-PARTY-LICENSES/ccx/GPL-2.0.txt`）と依存の一覧を同梱する
- ソースの入手先と SHA-256 を `SOURCE.txt` に書く。アプリの「このアプリについて」にも同じ入手先を書く（アプリ側の作業は未）
- ビルドに使ったパッチ（`desktop/tools/ccx/patches/`）はリポジトリに残す

## 検証済みと未検証（2026-11-20 時点）

GitHub Actions の `build-ccx` を、ブランチを指定して 10 回実行して直した（1 回目〜9 回目は、環境づくり・古い C/Fortran のコードを新しい gcc でビルドするための修正・Windows のパス形式の修正）。10 回目で macOS・Windows の両方が最後まで通った。

| 項目 | 状態 |
|---|---|
| macOS arm64 のビルド → `bundle.py`（dylib の集め・書き換え・署名）→ `smoke.mjs`（片持ち梁、日本語・空白のパス、5 回の再現性）→ zip | **Actions で成功**（`ccx-macos-arm64.zip` 13.4 MB） |
| Windows x64（MSYS2 mingw-w64）のビルド → DLL の集め → `smoke.mjs` → zip | **Actions で成功**（`ccx-windows-x64.zip` 19.6 MB） |
| 自前ビルドの ccx を、Mac の実機で Studio M Engine から使う | 未確認（Actions の成果物をダウンロードして `STUDIO_M_CCX` に渡して試す） |
| Windows の実機での動作 | 未確認 |
| ソースの SHA-256（ccx・SPOOLES） | 記入済み。公式は SHA-256 を公開していないため、2026-11-20 に Actions の 2 つのランナーで取得して一致した値を記録した（以後の改ざん検出用） |
| `GPL-2.0.txt` | Debian の `common-licenses/GPL-2` から取った。公式の LICENSE と照らして確かめる |
| 依存のライセンス表記（`DEPENDENCIES.md`） | 要確認の印がついたものがある |
