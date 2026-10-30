# Studio M Pro（インストール版）の方針

2026-10-26 に決めた方針（2026-10-30 に名前を「Studio M Pro」に決定）。実装は v0.6 として、新しいセッションで進める。

## 版の分け方

| 版 | 中身 | 使う場面 |
|---|---|---|
| **Studio M Lite** | 今のブラウザ版。HTML 1 枚、公開リンクでも動く。本計算は外部の Studio M Engine につないだときだけ | ちょっと試す、スマホで見る、人に見せる |
| **Studio M Pro** | Mac・Windows にインストールするアプリ。Studio M Engine と CalculiX を内蔵 | 普段の設計・解析・本計算 |

画面のコードは 1 つ（`src/`）。Pro はそれを包んでエンジンを足すだけで、機能を分岐させない。Lite を直せば Pro も直る。

ブラウザ版（Lite）にエンジンを内蔵できない理由: CalculiX・OpenFOAM は PC で直接動く実行ファイルで、ブラウザはページから実行ファイルを起動できない。CalculiX を WebAssembly に移す道は理屈の上ではあるが、Fortran の変換が難しく、OpenFOAM は規模的に現実的でない。

名前のメモ: 画面のモード「かんたん／標準／プロ」と「Pro 版」が紛らわしいので、モード名の変更（例: プロ → 詳細）を検討中。

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
| OpenFOAM | **同梱しない。「エンジン追加パック」として任意で入れる** | 1〜2 GB と大きく、Linux 中心のソフト。Windows は WSL2、Mac は Docker（opencfd のイメージ）を使う案内と自動判定をアプリに入れる |
| 更新 | GitHub Releases から自動更新 | 新しい版を出したら、アプリが自分で更新する |
| 署名 | 最初は署名なし（自分用） | 起動時に「発行元が不明」の警告が出るが、自分用なら問題ない。配布を広げるときに Apple Developer Program（年額）と Windows のコード署名を検討する |
| プロジェクトの保存 | ファイルとして開く・保存する（`.studiom.json`）。OS のファイルダイアログ、最近使ったファイル、自動保存 | ブラウザの localStorage に頼らない |

## GPL のソフトを同梱するときの約束

- CalculiX（GPL-2.0）は**別の実行ファイル**として同梱し、Studio M（MIT）とはコマンドとファイルでだけやり取りする（リンクしない）
- アプリにライセンス文を同梱し、使った版のソースの入手先を「このアプリについて」と `docs/oss-ledger.json` に書く
- ビルドに使った CalculiX のソースと手順をリポジトリ（または Release の添付）に残す
- OSS 台帳には使い方 `bundled-separate-program`（同梱するが別プログラム）を足して記録する
- 同梱するもののライセンスは、採用時に公式の LICENSE で確かめ直す

## 次のセッションでの進め方（v0.6）

1. `CLAUDE.md`・`docs/ROADMAP.md`・この文書・`docs/ENGINE.md` を読む
2. Electron の雛形（`desktop/`）: 画面の読み込み、main プロセスで Studio M Engine を起動、IPC での接続、ファイルの開く・保存
3. 画面側: 「PCのエンジン」設定を、Pro では自動接続にする（Lite との分岐は接続方法の層だけに閉じ込め、解析の種類では分岐しない）
4. CalculiX の同梱: Mac と Windows のビルド手順、GitHub Actions での自動ビルド、ライセンス文の同梱
5. OpenFOAM 追加パックの判定と案内（WSL2 / Docker）
6. インストーラー（Mac: dmg、Windows: exe）と自動更新を GitHub Actions で作る
7. Mac と Windows で、インストール直後に片持ち梁を CalculiX で本計算できることを確かめる

## セッションの使い方

- このセッション（2026-10-24〜26）は方針を決める場所にした。実装は区切りごとに新しいセッションで行う
- 新しいセッションは、まずこの文書と `CLAUDE.md` を読んでから始める
