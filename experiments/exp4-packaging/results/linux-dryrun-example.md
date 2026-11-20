## 実証実験 4 の測定結果（Linux の試走の例。Mac の実測ではない）

- 環境: linux 6.18.44-fc-v595 / x64 / Intel(R) Xeon(R) Processor @ 2.10GHz / 4 コア / メモリ 16 GB / Node v22.23.5
- 導入経路の測定: `--install` で入れて測った

### 1. 導入経路

| 経路 | 状態 | 版 | ディスク | 導入の時間 | 小さな計算 | 備考 |
| --- | --- | --- | --- | --- | --- | --- |
| CalculiX: brew（costerwi の tap） | 入っていない | — | — | — | — | Homebrew（brew）が見つかりません。https://brew.sh/ から入れてください |
| CalculiX: PATH 上の ccx | 入っている | This is Version 2.21 | 5 MB | — | 通った（0.0 s、梁の理論値との差 0.20%） |  |
| OpenFOAM: brew（gerlero/openfoam@2606） | 入っていない | — | — | — | — |  |
| OpenFOAM: /Applications の OpenFOAM.app | 入っていない | — | — | — | — | OpenFOAM-v*.app は /Applications にありません（手で入れる場合は gerlero/openfoam-app の zip を展開して置く） |
| OpenFOAM: Docker（opencfd/openfoam-default:2406） | 入っていない | — | — | — | — | Docker が入っていない、または起動していません（Docker Desktop を起動してください） |

既存の Studio M Engine の検出結果（`EngineStatus.engines`）:

| エンジン | 使える | 経路 | 備考 |
| --- | --- | --- | --- |
| calculix | はい | native |  |
| openfoam | いいえ | none | OpenFOAM（openfoam.com 版）が見つかりません。入れ方: Docker があれば opencfd/openfoam-default イメージを使えます（推奨。Windows は WSL2 上の Docker、macOS は Docker Desktop）。Ubuntu なら openfoam.com の apt リポジトリのパッケージ、または `apt install openfoam`（版が古く v1912）でも動きます。Debian/Ubuntu のパッケージでは環境変数 WM_PROJECT_DIR=/usr/share/openfoam が必要な場合があります。 |
| gmsh | いいえ | none | まだ対応していません（今後の版で対応予定） |
| elmer | いいえ | none | まだ対応していません（今後の版で対応予定） |
| openems | いいえ | none | まだ対応していません（今後の版で対応予定） |

### 2. 同梱物のサイズ（build/payload）

> 試走用: システムの /usr/bin/python3.12 の venv（--copies）。Python 本体のサイズは参考値（標準ライブラリはシステム側にある）

| 部品 | 削除前 | 削除後（不要物を消した） |
| --- | --- | --- |
| Python 本体 | 38 MB | 30 MB |
| 形状ワーカーの site-packages（OCP + vtk + numpy など） | 1.18 GB | 1.16 GB |
|   うち OCP（cadquery-ocp） | 0.43 GB | 0.43 GB |
|   うち vtk | 0.62 GB | 0.62 GB |
| 形状ワーカー: vtk なしの変種（参考。別フォルダー） | 0.48 GB | 0.47 GB |
| メッシュワーカーの site-packages（gmsh.py + numpy） | 68 MB | 44 MB |
|   Gmsh の共有ライブラリ | 88 MB | 88 MB |
| CalculiX の実行ファイル | 5 MB | 5 MB |
| CalculiX の共有ライブラリ | 16 MB | 16 MB |
| **同梱物の合計** | 1.39 GB | 1.34 GB |

形状ワーカーの確認（`import OCP` と STEP の読み書き）:

| 変種 | 結果 | import OCP | 備考 |
| --- | --- | --- | --- |
| vtk あり（標準） | 通った | 0.6 s |  |
| vtk なし（--no-deps） | **通らない** | — | エラー: OCP を読み込めません（libvtkWrappingPythonCore3.12.so: cannot open shared object file: No such file or directory）。workers/shape/site-packages に cadquery-ocp が入っているか、PYTHONPATH がそこを指しているか確認してください  |

### 3. 一連の処理（STEP → 形状ワーカー → Gmsh → CalculiX）

**通常のパス**

| 回 | 形状 | メッシュ | ccx | 合計 | OCP import | 応力集中係数（積分点） | 文献 3.149 との差 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 回目（コールド） | 0.92 s | 0.74 s | 1.58 s | 3.36 s | 0.7 s | 3.129 | 0.62% | 3% 以内 |
| 2 回目（ウォーム） | 0.85 s | 0.58 s | 1.52 s | 3.06 s | 0.6 s | 3.129 | 0.62% | 3% 以内 |

（メッシュ: 四面体 7313、節点 13961、最大寸法 10 mm。節点値の応力集中係数は 3.302（外挿のため高めに出る）。作業フォルダー: `/home/user/Studio-M/experiments/exp4-packaging/build/work/run1`）

**日本語と空白を含むパス（Mac では下の 4 章が本番）**

| 回 | 形状 | メッシュ | ccx | 合計 | OCP import | 応力集中係数（積分点） | 文献 3.149 との差 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 回目（コールド） | 0.81 s | 0.61 s | 1.60 s | 3.14 s | 0.6 s | 3.129 | 0.62% | 3% 以内 |
| 2 回目（ウォーム） | 0.78 s | 0.53 s | 1.52 s | 2.95 s | 0.6 s | 3.129 | 0.62% | 3% 以内 |

（メッシュ: 四面体 7313、節点 13961、最大寸法 10 mm。節点値の応力集中係数は 3.302（外挿のため高めに出る）。作業フォルダー: `/home/user/Studio-M/experiments/exp4-packaging/build/日本語 テスト/作業 フォルダ/run1`）

日本語・空白を含むパスと通常のパスで、応力集中係数は一致した。

### 4. Electron アプリ（desktop-probe）

飛ばしました: Mac 以外（Linux）のため、Electron の段（.app の作成・起動時間・日本語パス・quarantine）は飛ばしました。Linux の試走の結果は参考値です

### 5. 合格の目安（docs/EXPERIMENT-4.md）

| 項目 | 結果 |
| --- | --- |
| 追加の導入なしで STEP → 形状 → Gmsh → CalculiX が通り、応力集中係数が 3.149 の 3% 以内（通常のパス） | 合格 |
| 日本語と空白を含む作業フォルダーで同じ結果 | 合格（シンボリックリンク経由・作業フォルダー） |
| Mac の .app を日本語・空白のパスに置いて同じ結果 | 未測定（Mac 以外） |
| 配布サイズと起動時間の記録 | 記録した（上の表） |

