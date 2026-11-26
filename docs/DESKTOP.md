# Studio M Pro（インストール版）の方針

2026-10-26 に決めた方針（2026-10-30 に名前を「Studio M Pro」に決定）。実装は v0.6 として、新しいセッションで進める。

2026-11-13 追記: v0.6 から 3D に入ることにした。v0.6 は「Studio M Pro」と「3D の土台（STEP の読み込み、3D ビューア、名前付き選択、メッシュ）」の 2 つからなる。3D の設計と決定事項は `docs/PLATFORM-DESIGN.md`（特に 14 章）。

2026-11-13 追記: v0.6 はまず Mac（Apple Silicon）で作り、一通り動いてから Windows に広げる。Mac には CalculiX と OpenFOAM の公式のネイティブ配布がないので、その導入経路（Homebrew・自前のビルド・OpenFOAM.app・Docker）を最初に確かめる。Windows 機（Ryzen 7 7800X3D、32 GB）は、そのあと大きめの計算用に足す。

## 版の分け方

| 版 | 中身 | 使う場面 |
|---|---|---|
| **Studio M Lite** | 今のブラウザ版。HTML 1 枚、公開リンクでも動く。本計算は外部の Studio M Engine につないだときだけ | ちょっと試す、スマホで見る、人に見せる |
| **Studio M Pro** | Mac・Windows にインストールするアプリ。Studio M Engine と CalculiX を内蔵 | 普段の設計・解析・本計算 |

画面のコードは 1 つ（`src/`）。Pro はそれを包んでエンジンを足すだけで、機能を分岐させない。Lite を直せば Pro も直る。

ブラウザ版（Lite）にエンジンを内蔵できない理由: CalculiX・OpenFOAM は PC で直接動く実行ファイルで、ブラウザはページから実行ファイルを起動できない。CalculiX を WebAssembly に移す道は理屈の上ではあるが、Fortran の変換が難しく、OpenFOAM は規模的に現実的でない。

名前のメモ: 画面のモード「かんたん／標準／プロ」は今の名前のまま使う（2026-11-01 決定）。Pro 版と紛らわしいと感じたら、モード名の変更（例: プロ → 詳細）を改めて検討する。

## 対象

- 開発: Mac
- 利用: Mac と Windows の両方
- 対象 OS: macOS（Apple Silicon。Intel は必要になったら）、Windows 10/11（x64）

## 決めたこと

| 項目 | 決定 | 理由 |
|---|---|---|
| アプリの土台 | **Electron** | Studio M Engine が Node.js 製なので、アプリの中でそのまま動く。Tauri は軽いが、Node.js を別に同梱する手間が増える |
| エンジンの動かし方 | アプリの main プロセスで Studio M Engine を動かし、画面とはアプリ内の通信（IPC）でつなぐ。合言葉の入力は不要 | 利用者の手間をなくす。外部（Lite や CLI）から使う HTTP サーバーは設定でオンにできるようにする |
| CalculiX | **同梱する**（OS ごとに GitHub Actions でビルド） | 小さい（数十 MB）。強度・熱・塑性の本計算がインストール直後から使える |
| OpenFOAM | **同梱しない。「エンジン追加パック」として任意で入れる** | 1〜2 GB と大きく、Linux 中心のソフト。Windows は WSL2、Mac は OpenFOAM.app（gerlero/openfoam-app。macOS 15 以降の Apple Silicon）を使う案内と自動判定をアプリに入れる。Docker（opencfd のイメージ）は代案（2026-11-19、実証実験 4 の結果。`docs/EXPERIMENT-4.md`） |
| 更新 | GitHub Releases から自動更新 | 新しい版を出したら、アプリが自分で更新する |
| 署名 | 最初は署名なし（自分用） | 起動時に「発行元が不明」の警告が出るが、自分用なら問題ない。配布を広げるときに Apple Developer Program（年額）と Windows のコード署名を検討する |
| プロジェクトの保存 | ファイルとして開く・保存する（`.studiom.json`）。OS のファイルダイアログ、最近使ったファイル、自動保存。3D の形やメッシュを入れるときは 1 つのフォルダー（`<名前>.studiom/`）にする案がある（`docs/PLATFORM-DESIGN.md` 6 章）。v0.6 の中で決める | ブラウザの localStorage に頼らない |

## GPL のソフトを同梱するときの約束

- CalculiX（GPL-2.0）は**別の実行ファイル**として同梱し、Studio M（MIT）とはコマンドとファイルでだけやり取りする（リンクしない）
- アプリにライセンス文を同梱し、使った版のソースの入手先を「このアプリについて」と `docs/oss-ledger.json` に書く
- ビルドに使った CalculiX のソースと手順をリポジトリ（または Release の添付）に残す
- OSS 台帳には使い方 `bundled-separate-program`（同梱するが別プログラム）を足して記録する
- 同梱するもののライセンスは、採用時に公式の LICENSE で確かめ直す

## 次のセッションでの進め方（v0.6）

1. `CLAUDE.md`・`docs/ROADMAP.md`・この文書・`docs/ENGINE.md`・`docs/PLATFORM-DESIGN.md`（14 章の決定事項から）を読む
2. Electron の雛形（`desktop/`）: 画面の読み込み、main プロセスで Studio M Engine を起動、IPC での接続、ファイルの開く・保存
   - 2026-11-19 雛形は作成済み（`desktop/`、起動は `npm run desktop:build` → `npm run desktop:start`）。Mac・Windows の実機での確認と、ファイルのダイアログ・IPC の実操作は未確認（Linux の xvfb で、画面の読み込みと Engine の起動までは確認）。画面側が開発用に `window.studioM` を作っているため、Pro の公開名は `window.studioMPro` にした
3. 画面側: 「PCのエンジン」設定を、Pro では自動接続にする（Lite との分岐は接続方法の層だけに閉じ込め、解析の種類では分岐しない）
   - 2026-11-20 作成済み: Pro（`window.studioMPro` がある）では、画面が合言葉なしでアプリ内のエンジンに自動接続する（`src/ui/engine-ipc.ts` が IPC を fetch の形に包み、`engine-client` にそのまま渡す。`EngineSession.mode` が `pro`/`lite`。起動後に自動で `connect()`、設定（⚙）の「PCのエンジン」は URL・合言葉の欄を出さず、検出結果と「もう一度検出する」だけ）。ファイルの開く・保存も Pro では OS のダイアログ（`src/ui/pro-files.ts`。2 回目からの保存は上書き、「名前を付けて保存」を追加。Lite は今までどおり）。「このアプリについて」（`desktop/src/about.ts`・`main.ts`。Mac はアプリメニュー、Windows はヘルプ。同梱の CalculiX の版・GPL-2.0・ソースの入手先・ライセンス文のフォルダー）。Linux の xvfb 上の Electron で、設定の「PCのエンジン」に自動接続の表示と検出結果が出て、合言葉の欄がないことを確認。**未確認**: Mac・Windows の実機での操作、ファイルのダイアログの実操作（開く・上書き保存）、「このアプリについて」の実表示、同梱の ccx がある状態での画面からの本計算
   - 2026-11-23 **Mac（M1）の実機で、画面から片持ち梁の本計算ができた**（Actions の `build-desktop` で作った dmg。合言葉なしで自動接続し、同梱の ccx を使う）。ファイルのダイアログの実操作と「このアプリについて」の実表示、Windows の実機は未確認
4. CalculiX の同梱: Mac と Windows のビルド手順、GitHub Actions での自動ビルド、ライセンス文の同梱
   - 2026-11-20 Mac（M1）の実機で、`STUDIO_M_CCX=/opt/homebrew/bin/ccx_2.23` を渡したエンジン経由の本計算が通った（片持ち梁のたわみが梁理論の 10% 以内、約 0.3 秒。日本語・空白のパスでも同じ。Homebrew の ccx であり、自前ビルドの同梱版ではない）。
   - 2026-11-19 Engine 側の受け口は作成済み（`commandPaths`・`STUDIO_M_CCX`、`desktop/src/bundled-tools.ts` が `resources/ccx`（開発中は `STUDIO_M_BUNDLED_DIR/ccx`）から ccx を探して渡す）。ビルドと同梱は未
   - 2026-11-20 ccx の自前ビルドが GitHub Actions（`build-ccx`、手順は `docs/CCX-BUILD.md`）で macOS arm64・Windows x64 とも最後まで通り、成果物（`ccx-macos-arm64.zip` 13.4 MB・`ccx-windows-x64.zip` 19.6 MB）で片持ち梁の確認も通った。残り: 自前ビルドの ccx を Mac の実機で試すこと、Windows の実機での確認、`GPL-2.0.txt` を公式の LICENSE と照らすこと、アプリの「このアプリについて」へのソース入手先の表示
5. OpenFOAM 追加パックの判定と案内（Mac は OpenFOAM.app、Windows は WSL2 / Docker）
   - 2026-11-19 Engine 側は作成済み（`engine/server/openfoam-app.ts` が `/Applications/OpenFOAM-v*.app` を探し、`commandLaunchers` で `-c "…"` のラッパー経由で起動。見つからないときの案内は `engine/adapters/openfoam/guide.ts` が OS・CPU ごとに出し分ける）。**2026-11-20 Mac（M1）の実機で確認済み**（`STUDIO_M_ENGINE_TESTS=1 npx vitest run engine/server/engine-e2e.test.ts`。OpenFOAM v2606 を検出し、ラッパー経由で円柱まわりの短い流れが約 6 秒で解けた。zsh のラッパーは作業フォルダーを保つ）。この確認で、OpenFOAM は作業フォルダーのパスに日本語・空白があると止まる（`fileName::stripInvalid()`）ことが分かり、Engine が英数字だけの場所に自動で逃がす（`engine/server/work-root.ts`、`STUDIO_M_WORK_ROOT`）ようにした。Windows の WSL2 の自動判定と、画面での案内の表示は未
6. インストーラー（Mac: dmg、Windows: exe）と自動更新を GitHub Actions で作る
   - 2026-11-20 作成済み（未実行）: `desktop/electron-builder.yml`（electron-builder 26.18.0。Mac は arm64 の dmg＋ad-hoc 署名、Windows は x64 の nsis）、`.github/workflows/build-desktop.yml`（`build-ccx` を呼んで ccx を同梱 → ビルド → `--selftest` → 成果物。`pro-v*` のタグで Release に添付）、更新の通知（`desktop/src/update-check.ts`。署名なしで Mac の自動更新ができないため、新しい版を知らせてダウンロードページを開く方式。署名を取ったら electron-updater へ）。パッケージ後の画面は `resources/web/index.html`
   - 2026-11-20 **Actions（`build-desktop`）で macOS・Windows とも最後まで通った**: dmg 134.5 MB・exe 135.6 MB。開発用の push トリガーは消した（タグ `pro-v*` か手動で動かす。新しいワークフローは main に入るまで手動で呼べない）。更新の通知は、リリースの一覧から `pro-v` のタグを選ぶ形にした（Lite・ccx のリリースが最新でも見つかる）
   - 2026-11-20 **Mac（M1）の実機で、Actions の成果物の dmg からインストールしたアプリが起動した**（署名なしのため、初回は「システム設定 → プライバシーとセキュリティ → このまま開く」か `xattr -dr com.apple.quarantine` が要る。macOS 15 以降は右クリック→開くが使えない）
   - 未確認: Windows の実機でのインストールと起動（SmartScreen の警告）、更新の通知の実動作（`pro-v` の Release を作ってから）、Windows の SmartScreen の警告
7. Mac と Windows で、インストール直後に片持ち梁を CalculiX で本計算できることを確かめる
   - 2026-11-20 `--selftest`（`desktop/src/selftest.ts`・`selftest-logic.ts`）を作成。ウィンドウなしで Engine を起動し、同梱の ccx で片持ち梁を本計算して JSON と終了コード（0 / 1）を返す。ccx がないときは「同梱の ccx が見つかりません」で終了コード 1（Linux の xvfb で確認）。Actions で作ったアプリに対して実行する手順を `build-desktop.yml` に入れた（未実行）。Mac・Windows の実機での確認は未
   - 2026-11-20 **Actions で、作った直後のアプリ（インストーラーの中身）の `--selftest` が macOS・Windows とも合格**: 同梱の ccx で、先端のたわみが梁理論との差 0.99%（Windows のログで確認）、反力が荷重と一致。実機（インストーラーから入れたアプリ）での確認は未

続けて 3D の土台（詳しくは `docs/ROADMAP.md` の v0.6 と、`docs/PLATFORM-DESIGN.md` の 3・5・6・12 章）:

8. 実証実験 4: 形状ワーカー（Python と OCCT）・Gmsh・CalculiX をアプリに同梱し、配布サイズと起動時間を測る。Python を使うかの最終判断はここで行う。日本語のユーザー名で動くかも確かめる
9. 形状ワーカー（STEP・STL、面の番号と署名、単位の確定）と 3D ビューア、名前付き選択
10. メッシュワーカー（Gmsh。GPL の別プログラムとしてフォルダーを分ける）と、CalculiX アダプターの 3D 対応
11. 実証実験 1: STEP の円孔のある平板と片持ち梁を、取り込みから 3D の結果表示まで一続きで動かす。SolidCraft で作った STEP で、面の数・面積・体積が一致するかも確かめる

## セッションの使い方

- このセッション（2026-10-24〜26）は方針を決める場所にした。実装は区切りごとに新しいセッションで行う
- 新しいセッションは、まずこの文書と `CLAUDE.md` を読んでから始める
