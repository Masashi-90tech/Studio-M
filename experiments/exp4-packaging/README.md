# 実証実験 4 の計測キット

`docs/EXPERIMENT-4.md` の問い（Mac にエンジンごと配れるか）の数値を、Mac で 1 つのコマンドにまとめて測るためのキットです。
Studio M 本体のコードではありません（`src/`・`engine/` は触りません。テストと CI の対象外。ルートの `package.json` にも依存を足していません）。

## 前提（Apple Silicon の Mac）

- macOS 15 以降（OpenFOAM.app の条件）
- Homebrew（https://brew.sh/）。`brew` が PATH にあること
- Xcode Command Line Tools（`xcode-select --install`。`otool`・`install_name_tool`・`codesign` が要ります）
- Node.js 22 以上（`brew install node@22`）
- リポジトリのルートで `npm install` と `npm run build:engine` を済ませておく（既存のエンジンの検出と、アプリの中のエンジンの応答時間を測るため。なくても動きますが、その項目は「測れなかった」になります）
- ネットワーク（PyPI・npm レジストリ・GitHub Releases・Docker Hub）
- 空き容量の目安: 約 15 GB（同梱物 約 1.5 GB、Electron と .app と zip・dmg で数 GB、`--install` で brew の CalculiX と OpenFOAM、Docker のイメージが加わる）

## 実行

```bash
cd experiments/exp4-packaging

./run-all.sh              # 入っているものを検出して測るだけ（PC には何も入れない）
./run-all.sh --install    # brew の CalculiX・OpenFOAM、Docker のイメージも実際に入れて測る
```

`--install` を付けない限り、`brew install` や `docker pull` は行いません。ただし `build-bundle.sh` は、`ccx` が見つからないときだけ `--install` で入れます（付けなければ止まって、入れ方を表示します）。

所要時間の目安（回線と Mac による）: `--install` なしで 15〜30 分（Electron とライブラリのダウンロードが大半）。`--install` ありだと、CalculiX の tap（ソースからのビルド）に 10〜30 分、OpenFOAM に数分〜数十分、Docker のイメージの pull に数分が加わります。

個別に実行することもできます。

| スクリプト | 内容 |
|---|---|
| `install-paths.sh [--install]` | 導入経路ごとの、入っているか・版・ディスク使用量・導入の時間・小さな計算（ccx の片持ち梁、OpenFOAM の cavity）。既存のエンジンの検出結果 |
| `build-bundle.sh [--install] [--python <dir>] [--python-url <URL>] [--skip-novtk]` | 同梱物を `build/payload/` に組み立て、部品ごとのサイズを記録 |
| `pipeline/run-pipeline.mjs --payload <dir> --work <dir>` | 同梱物だけで、STEP → 形状ワーカー → Gmsh → CalculiX → 応力集中係数 |
| `measure-app.sh` | 最小の Electron アプリ（`desktop-probe/`）を `.app` にして、サイズと起動時間を測る（Mac 専用） |
| `summarize.mjs` | `build/parts/` の JSON を `results/` の JSON と Markdown にまとめる |

Mac 以外（Linux）で `run-all.sh` を実行すると、Electron の段は飛ばして、その旨を表に書きます。Linux の試走の結果は `results/linux-dryrun-example.md` にあります（Python 本体のサイズは参考値。Mac の実測ではありません）。

### 同梱するもの（版は固定）

| 部品 | 版 | 入れ方 |
|---|---|---|
| Python | python-build-standalone 3.12.11（`20250902`、aarch64-apple-darwin、install_only_stripped） | GitHub Releases からダウンロード。`--python <dir>` で手元の移動できる Python に差し替え可（3.12 のこと）。URL が古くなっていたら `--python-url` で差し替え |
| 形状ワーカー | cadquery-ocp 8.0.1.1.0（vtk 込み）+ numpy | pip（wheel のみ）。変種として vtk に依存しない `cadquery-ocp-novtk`（同じ版の別パッケージ）も作って、`import OCP` と STEP の読み書きが通るか記録。cadquery-ocp から vtk だけを外す（`--no-deps`）やり方は、Linux でも Mac でも動かなかった |
| メッシュワーカー | gmsh 4.15.2 + numpy | pip（GPL のため形状とは別フォルダー）。共有ライブラリは wheel から取り出して `workers/mesh/lib` に置く |
| CalculiX | brew の ccx（costerwi の tap） | `ccx` と、使う dylib を集めて `@executable_path/../lib/` に書き換え、ad-hoc 署名をやり直す（`lib/bundle_ccx.py`） |
| Electron | 45.2.2（公開から 2 週間以上たった版） / @electron/packager 20.3.0 | `desktop-probe/` の npm install |

## 出力の見方

`results/<ホスト名>-<日時>.json`（全データ）と `.md`（`docs/EXPERIMENT-4.md` の「結果」にそのまま貼れる表）ができます。

1. 導入経路: 経路ごとの入っているか・版・ディスク・導入の時間・小さな計算。ccx の片持ち梁は、先端のたわみを梁の理論値 PL³/(3EI) と比べた差も出ます
2. 同梱物のサイズ: 部品ごとに、不要物（`__pycache__`・tests・型スタブなど）を消す前後。`.app` の合計と、zip・dmg
3. 一連の処理の時間: 1 回目（コールド）と 2 回目（ウォーム）。応力集中係数（積分点）と、文献の近似式 3.149 との差。**3% 以内が合格**
4. Electron: 起動（app ready・画面表示・同梱エンジンの応答）と、アプリの中での各段の時間。ビルドした場所と `~/Studio M テスト/` の 2 通り。quarantine 付きの `spctl` の結果
5. 合格の目安のまとめ

注意:

- 「コールド」は、ビルドや起動の直後の 1 回目という意味です（OS のファイルキャッシュは捨てていません）。Mac では 1 回目に Gatekeeper・XProtect の検査が入るぶん遅くなります
- 節点値の応力集中係数は外挿のため高めに出ます。合否は、`probe_structure.py` と同じ積分点の値で判定します
- 同梱の Python は `PYTHONDONTWRITEBYTECODE=1` で動かします（署名した .app の中に .pyc を書かないため）。そのぶん import は毎回少し遅くなります
- CalculiX は、出力の見出しに入力のパスを入れ、長いと日本語の文字の途中で切ります（`.frd` が不正な UTF-8 になる）。`ccx_tool.py` は読めない所を置き換えて読みます

## 日本語のユーザー名で試す手順（手動）

`run-all.sh` の中の日本語パスの測定は、`~/Studio M テスト/` という日本語と空白を含むフォルダーにアプリと作業フォルダーを置くものです。ユーザー名そのものが日本語の場合（ホームが `/Users/山田` など）は、テスト用のユーザーを作って試します。管理者権限が要るので手動です。

```bash
# 1. 日本語名のテスト用ユーザーを作る（パスワードは自分で決める）
sudo sysadminctl -addUser テスト太郎 -fullName "テスト 太郎" -password "（任意）" -home /Users/テスト太郎
# 2. そのユーザーに切り替える（ログアウトして、またはファストユーザスイッチで）
# 3. このリポジトリを読める場所に置くか、キット一式をコピーして、そのユーザーで実行する
cd /path/to/Studio-M/experiments/exp4-packaging && ./run-all.sh
# 4. 結果の md の「4. Electron アプリ」と「3. 一連の処理」を確認する
```

Homebrew はユーザーごとの環境ではなく共有なので、そのユーザーでも `brew` が使えることを先に確認してください。

## 署名なしのアプリを開く（手動）

`measure-app.sh` は、quarantine の属性を付けたコピー（`~/Studio M テスト/検疫つき/Studio M Probe.app`）を `spctl -a -vv` で調べるだけで、起動はしません。実際の表示は次の手順で確かめます。

1. Finder で上のコピーをダブルクリックする → 「開けません」などの表示が出るか、そのまま開くかを記録する
2. 止められたら、システム設定 → プライバシーとセキュリティ → 「このまま開く」が出るか確認する
3. `xattr -d com.apple.quarantine <アプリ>` で属性を消すと開く（利用者向けの案内にするかは別に判断する）

## 後片付け

```bash
rm -rf build downloads desktop-probe/out desktop-probe/node_modules results/*-2*   # 生成物（linux-dryrun-example.md は残す）
rm -rf ~/"Studio M テスト"                                                         # 日本語パスの測定用コピー
rm -rf "$(brew --prefix)"/Cellar/calculix-ccx                                      # --install で入れたものを消す場合
brew uninstall calculix-ccx 'openfoam@2606'; docker rmi opencfd/openfoam-default:2406
sudo sysadminctl -deleteUser テスト太郎                                            # 日本語名のテスト用ユーザー
```

`results/` の下の `.json` と `.md` は `.gitignore` で除外されています。残したい結果は `docs/EXPERIMENT-4.md` に貼ってください。

## 要確認（Mac で初めて分かること）

- python-build-standalone の URL（`20250902` のタグ）は、GitHub に届かない環境で書いたため、実在を確かめていません。404 のときは `--python-url` で差し替えてください
- OpenFOAM.app の `etc/openfoam` の使い方（`openfoam -c "コマンド"` か、`source` か）は両方試し、通ったほうを結果に書きます
- `brew install gerlero/openfoam/openfoam@2606` が入れる場所と形（formula か cask か、`/Applications` のどこか）
- ccx の dylib の書き換え（`bundle_ccx.py`）は Mac で初めて動きます。失敗したときは `build/bundle_ccx.log` と、`otool -L build/payload/engines/calculix/bin/ccx` を見てください
- vtk なしの変種は Linux では動きませんでした（OCP が `libvtkWrappingPythonCore` を読むため）。Mac でも同じかを記録します
