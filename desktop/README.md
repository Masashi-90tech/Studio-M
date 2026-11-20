# desktop/（Studio M Pro の雛形）

Electron で画面（`dist/index.html`）を包み、main プロセスで Studio M Engine を動かす。詳しい方針は `docs/DESKTOP.md`。

```bash
cd desktop && npm install      # 初回だけ。Electron 本体（約 100 MB）が入る
cd .. && npm run desktop:build # 画面と desktop/dist/ をビルド
npm run desktop:start          # 起動
npm run desktop:typecheck      # main.ts・preload.ts の型検査（上の npm install のあと）
```

- 開発用: 環境変数 `STUDIO_M_DESKTOP_URL`（例: `npm run dev` の URL）を付けて起動すると、その画面を読み込む
- 画面には `window.studioMPro`（`src/api.ts`）だけが見える。合言葉は main の外に出ない
- `npm run check` は Electron なしで通る（`main.ts`・`preload.ts` 以外だけ型検査・テストする）

## インストーラー（dmg・exe）

作り方: GitHub の Actions で `build-desktop` を実行する（`workflow_dispatch`、または `pro-v0.6.0` のように `pro-v` で始まるタグを push）。`build-ccx` で ccx を作り、同梱し、作ったアプリを `--selftest` で確かめてから、成果物（`Studio-M-Pro-<版>-mac-arm64.dmg`・`Studio-M-Pro-<版>-win-x64.exe`）を上げる。タグのときは Release にも添付する（タグと `desktop/package.json` の `version` が違うと失敗する）。設定は `electron-builder.yml`。ローカルの確認は `npm run desktop:pack`（`desktop/release/` に展開済みのアプリができる。ccx は `desktop/build/payload/ccx` に置いたときだけ同梱される）。

- Mac: dmg を開いて、Studio M Pro を Applications にドラッグする。署名は ad-hoc（証明書なし）なので、ダウンロードした直後は「開発元を確認できない」と出ることがある。**右クリック（Control+クリック）→「開く」→「開く」** で 1 回開けば、以後は普通に起動する。それでも開けないときは、システム設定 → プライバシーとセキュリティ の「このまま開く」を押す
- Windows: exe を実行する。署名がないので SmartScreen が「WindowsによってPCが保護されました」と出る。**「詳細情報」→「実行」** で進める。インストール先は選べる（管理者権限は不要）

## 自己診断（--selftest）

インストール直後に、同梱の ccx で片持ち梁を本計算できるかを確かめる。ウィンドウは開かない。

```bash
"/Applications/Studio M Pro.app/Contents/MacOS/Studio M Pro" --selftest --out selftest.json
```

Windows は `"Studio M Pro.exe" --selftest --out selftest.json`（コンソールに出ないので `--out` を使う）。結果は JSON（各検査の合否と数値、ccx の場所、Engine の版、OS）で、終了コードは合格 0・失敗 1。検査は「CalculiX が使える」「本計算が終わる」「先端のたわみが梁理論（PL³/3EI）と 5% 以内」「反力が荷重と釣り合う」。失敗の理由は日本語で出る。

## 更新の通知

署名のない Mac では自動更新ができないので、新しい版の「通知」だけにしている。起動して画面を表示したあとに 1 回、メニュー「ヘルプ → 更新を確認…」で手動でも、GitHub の最新 Release（`pro-v<版>` のタグ）を調べて、今の版より新しければ「ダウンロードページを開きますか？」と出す（`src/update-check.ts`。送るのは `User-Agent: Studio-M-Pro` だけ）。ダウンロードして入れ直すと更新できる。署名（Apple Developer Program・Windows のコード署名）を取ったら、electron-updater による本物の自動更新へ移る。
