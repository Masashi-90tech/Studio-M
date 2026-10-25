# Studio M 開発ルール

人も AI エージェントも、このルールに沿って作業する。目的は、個別のモジュールを直しても
メイン画面（ハーネス）が壊れないようにすることと、OSS のライセンスを後から追えるようにすること。

## コマンド

```bash
npm run check       # 型チェック + テスト + ライセンス確認（コミット前に必ず通す）
npm test            # テストだけ
npm run licenses    # OSS 台帳と依存パッケージの突き合わせ
npm run build:artifact  # 単一 HTML（dist/index.html）と Artifact 用 HTML を作る
```

## 層と依存の向き

依存は下の層にだけ向ける。上の層を import しない。

| 層 | 場所 | 中身 | 禁止 |
|---|---|---|---|
| 1. 契約 | `src/core/types.ts` | 全モジュール共通の型 | 実装を書かない |
| 2. コア | `src/core/` | 材料、格子化、自動格子、プロジェクトの既定値 | DOM・UI の import |
| 3. ソルバー | `src/solvers/` | 解析エンジン。`Project` と `Raster` を受け取り `Solver` を返す | DOM・UI・export の import |
| 4. 出力 | `src/export/` | Excel など | UI の import |
| 5. 画面 | `src/ui/`、`src/main.ts` | 表示と操作 | ソルバー内部への直接アクセス（`createSolver` 経由のみ） |

## モジュールの約束

- **モジュール同士は `src/core/types.ts` の型だけでやり取りする。** 新しいやり取りが必要なら、まず契約に型を足す
- **引数はオプションオブジェクトで渡す。** 位置引数を増やしたり並べ替えたりしない。項目を足すときは省略可能（`?`）にして、省略時は今までと同じ動きにする
- **既存の項目の意味や単位を変えない。** 変えるときは新しい名前の項目を足し、古いものは段階的に廃止する
- **各モジュールの入口は 1 か所。** 解析なら `createSolver(kind, project, raster)` の登録表（`src/solvers/index.ts`）だけを画面から呼ぶ
- **重いモジュールは遅延 import する**（`import()`）。ソルバー、Excel 出力、画像取り込み、将来の CAD エンジン（WASM）など。単一 HTML のビルドでは 1 ファイルにまとめられるが、デスクトップ版や Pages 版では必要なときだけ読み込まれる
- **テストを付ける。** 純粋な関数は単体テスト。ソルバーは理論値や手計算との照合テスト。契約を満たしているか（必須のフィールド、単位、mask の長さ）もテストする
- **外部エンジン（SolidCraft、OCCT、OpenFOAM など）は変換層越しに使う。** 外部の型を Studio M の中に漏らさない。バージョンを固定する

## OSS とライセンス

- 依存を追加・更新したら、**`docs/oss-ledger.json` に記録して `npm run licenses` を通す**
- 記録する項目: 名前、役割、ライセンス、使い方（bundled / dev / installed / separate-process / file-format / planned / reference）、商用利用、義務、出典、確認日
- GPL / AGPL のものは Studio M に組み込まない。別プロセスかファイル連携でだけ使う
- 参考にしただけのプロジェクトも `reference` として記録する（後で自分の OSS を公開するときの再調査用）
- 詳しくは `docs/OSS.md`

## 文章とコメント

- 画面の文言・コメントは日本語。周りのコードの書き方に合わせる
- 利用者向けの警告は、何が起きていて、どうすれば直るかを書く
