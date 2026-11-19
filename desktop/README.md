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
