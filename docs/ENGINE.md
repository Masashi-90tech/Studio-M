# Studio M Engine（PC 上の本計算エンジン）

Studio M Lite はブラウザの中で動く 2D の解析で、答えがすぐ出ます。その代わり、格子の細かさや物理モデルには限りがあります。
**Studio M Engine** は、この PC の上で動く小さな Node.js のサーバーです。Studio M の画面から形と条件を受け取り、
実績のある解析ソフト（強度は CalculiX、流れは OpenFOAM）を**別プロセスとして**走らせて、結果を画面に返します。
画面では Lite の結果と「Lite ⇄ 本計算」で切り替え、代表値を並べて比べられます。

```
ブラウザ（Studio M）  ──HTTP + 合言葉──▶  Studio M Engine  ──別プロセス──▶  CalculiX / OpenFOAM
  127.0.0.1 のこの PC だけ                   127.0.0.1:47800                     （GPL。同梱しない）
```

## 起動

Node.js 22 以上が必要です（追加の npm パッケージは要りません）。

```bash
npm run engine            # ビルドして起動（dist-engine/main.js）
npm run engine:dev        # 開発用（vite-node でそのまま実行）
npm run engine -- --port 47801 --max-jobs 2 --keep
```

起動すると、URL と**合言葉**が画面に出ます。合言葉は起動のたびに作り直され、`~/.studio-m/engine-token` にも保存されます（自分だけが読める権限）。

| オプション | 意味 |
|---|---|
| `--port <番号>` | 待ち受けるポート（既定 47800） |
| `--max-jobs <数>` | 同時に走らせる計算の数（既定 1）。待っている計算は順番に走ります |
| `--keep` | 終了時に一時フォルダ（`<一時フォルダ>/studio-m-engine/<id>`）を消さない。入力ファイルを確かめたいときに |
| `--ttl-hours <時間>` | 終わった計算を覚えておく時間（既定 24） |
| `--timeout-min <分>` | 1 つのコマンドの時間切れ（既定 60） |

## Studio M につなぐ

1. エンジンを起動する
2. **ダウンロードした HTML**（リリースの `index.html`）か、開発版（`npm run dev`）で Studio M を開く
3. ヘッダーの ⚙（設定）→「PCのエンジン」に、URL と合言葉を貼り付けて「接続を確認」を押す
4. `✓ CalculiX 2.21` のように、見つかったエンジンが並ぶ
5. 強度（片持ち梁など）や流れ（円柱のカルマン渦など）を開くと、結果の下に「本計算で解く（CalculiX）」が出る

URL と合言葉は、このブラウザの localStorage にだけ保存されます。

> claude.ai に公開した Studio M（Artifact）からは、ブラウザの制限（CSP）で PC のエンジンに届きません。設定欄にもその旨が出ます。

## 見つからないときは: 入れ方

エンジンは、PC に**直接入っているコマンド**（native）を先に探し、なければ **Docker のイメージ**（手元に pull 済みのもの）を使います。

### Ubuntu / Debian

```bash
sudo apt install calculix-ccx            # CalculiX（ccx）
sudo apt install openfoam                # OpenFOAM（Debian/Ubuntu の版。古い）
# openfoam.com の最新版を使うなら公式の apt リポジトリを追加する: https://www.openfoam.com/download/
# Debian/Ubuntu のパッケージでは WM_PROJECT_DIR=/usr/share/openfoam の設定が必要なことがある
```

### Docker（Linux・macOS・Windows 共通で、いちばん手軽）

```bash
docker pull opencfd/openfoam-default:2406     # OpenFOAM
```

エンジンは `docker run --rm -v <作業フォルダ>:/work -w /work ... <イメージ> <コマンド>` で実行します（`--network none` なので、計算ソフトは外に通信しません）。
CalculiX の Docker イメージは今のところ使っていません（Linux は apt、Windows は WSL2 の中で apt）。

### Windows

- **WSL2（Ubuntu）**の中に Node.js と上の apt のパッケージを入れ、WSL の中で `npm run engine` を起動する（Windows のブラウザから `http://127.0.0.1:47800` で届く）
- または **Docker Desktop** を入れて OpenFOAM のイメージを使う

### macOS

- **Docker Desktop**（または colima）を入れ、OpenFOAM のイメージを使う
- CalculiX は Homebrew にもあるが（`brew install calculix-ccx` など、版に注意）、まずは Docker 経由が確実

## 安全のしくみ

- **127.0.0.1 だけで待ち受けます。** 同じネットワークの他の PC からは届きません
- 起動のたびに作る**合言葉**（Bearer トークン）がないと、`GET /status` の最小限の情報以外は答えません
- 接続元は、`file://` で開いた HTML（Origin `null`）と `http://localhost` / `http://127.0.0.1` のページだけ許します。Host ヘッダーも確かめます（DNS リバインディング対策）
- 画面から受け取るのは JSON の「解析の種類・エンジン・プロジェクト・オプション」だけです。ファイルのパスや実行するコマンドは**受け取りません**（コマンドはアダプターが決め、シェルを通さず引数の配列で実行）
- 本文は 20 MB まで。配るファイルは、アダプターが一覧に挙げた名前だけ（作業フォルダの外へは出られません）
- 合言葉は他の人に教えないでください。PC を共有している場合は、使い終わったらエンジンを止めてください

## 通信の要約（プロトコル）

型は `src/core/engine-protocol.ts`、結果の JSON の形は `src/core/engine-wire.ts`。

| 要求 | 内容 |
|---|---|
| `GET /status[?refresh=1]` | `EngineStatus`。合言葉なしだと `engines: []` の最小限の返事（`authorized: false`）。`refresh=1` でエンジンを探し直す |
| `POST /jobs` | `JobRequest`（JSON）→ `{ id }`。順番待ちに入る |
| `GET /jobs/:id` | `JobState`。`status` は queued → meshing / running / reading → done / failed / cancelled。`log` は末尾 200 行 |
| `POST /jobs/:id/cancel` | 中止（走っているソフトを子プロセスごと止める） |
| `GET /jobs/:id/files/:name` | 計算に使った入力・出力ファイル（ParaView などで開く用） |

すべての要求に `Authorization: Bearer <合言葉>` を付けます。`result`（ResultSet）の場（Float32Array / Uint8Array）は
`{ "$typed": "f32" | "u8", "length": N, "b64": "…" }` に直して送ります（JSON の数値配列より小さく、NaN も壊れません）。
失敗は `{ "error": "日本語の説明" }`（401 合言葉、403 接続元、400 検査、409 エンジンなし、413 大きすぎる、429 待ちが多い）。

## アダプターを足す

解析ソフト 1 つ = アダプター 1 つ。`engine/adapters/<名前>/index.ts` が `EngineAdapter`（`engine/types.ts`）を export すれば、
サーバーが起動時に自動で拾います（登録表への追加は要りません）。

1. `id`（`EngineId`）、`capabilities`（どの解析をどう解くか。`options` はプロモードに出る）、`dockerImage`（あれば）を決める
2. `detect(ctx)`: `ctx.probe('ccx', ['-v'])` のようにコマンドを確かめ、`EngineInfo`（見つからなければ入れ方の `note`）を返す。`probe` の `ok` は「終了コードが 0」で、0 以外でも `output`（標準出力と標準エラー）は返る（`ccx -v` は版を出して 0 以外で終わるので、`output` の中身で判断する）
3. `solve(req, ctx)`: `req.project` をソフトの入力ファイルにして `ctx.workDir` に書き、`ctx.run(コマンド名, 引数の配列)` で実行し、`ctx.progress(0〜1, 日本語のメッセージ)` で進み具合を知らせ、結果を `ResultSet`（格子は Lite と同じ nx × ny）に直して返す。ユーザーに渡すファイルは `files` に挙げる
4. 失敗は、何が起きてどうすれば直るかを書いた**日本語の Error** を投げる（そのまま画面に出る）
5. 守ること:
   - **自分で `spawn` しない。** 実行は必ず `ctx.run`（native でも Docker でも同じ書き方になり、中止・時間切れ・ログも効く）
   - ファイルは `ctx.workDir` の中だけに書く。プロジェクトの文字列（形の名前など）をコマンドやファイル名に使わない
   - 長い処理では `ctx.signal`（中止）を見る
   - `engine/` が import してよいのは `src/core` だけ
   - **GPL のソフトは別プロセスとして呼ぶだけ。Studio M に同梱・リンクしない。** `docs/oss-ledger.json` に記録する
6. テスト: 入力ファイルの組み立てや結果の読み取りは単体テスト、ソフトが入っていれば理論値との照合テスト

サーバー側のテストは、本物のソフトなしで動く偽のアダプター（`engine/server/testing.ts`）を使っています。
