# Studio M 開発ルール

人も AI エージェントも、このルールに沿って作業する。目的は、個別のモジュールを直しても
メイン画面（ハーネス）が壊れないようにすることと、OSS のライセンスを後から追えるようにすること。

## コマンド

```bash
npm run check       # 型チェック + テスト + ライセンス確認（コミット前に必ず通す）
npm test            # テストだけ
npm run licenses    # OSS 台帳と依存パッケージの突き合わせ
npm run test:engines  # PC に入っている CalculiX・OpenFOAM を実際に動かす結合テスト（STUDIO_M_ENGINE_TESTS=1。npm run check では飛ばす）
npm run engine      # Studio M Engine（PC 上の計算サーバー）を起動
npm run build:artifact  # 単一 HTML（dist/index.html）と Artifact 用 HTML を作る
npm run engine      # PC 上の Studio M Engine を起動（本計算。docs/ENGINE.md）
```

## 層と依存の向き

依存は下の層にだけ向ける。上の層を import しない。

| 層 | 場所 | 中身 | 禁止 |
|---|---|---|---|
| 1. 契約 | `src/core/types.ts` | 全モジュール共通の型 | 実装を書かない |
| 2. コア | `src/core/` | 材料、格子化、自動格子、解析の名前（`analyses.ts`）、プロジェクトの既定値 | DOM・UI の import |
| 3. ソルバー | `src/solvers/` | 解析エンジン。`Project` と `Raster` を受け取り `Solver` を返す | DOM・UI・export・workbench の import |
| 4. 出力 | `src/export/` | Excel など | UI・workbench の import |
| 5. ワークベンチ | `src/workbench/` | 解析 1 つ分のまとめ（ソルバー・パネル・判定・プリセット・数学の窓）と登録表 | 画面（シェル）側からの逆向きの import |
| 5. 学び | `src/learn/` | 数学の窓（式の提供者・部品）、レッスン、進み具合の保存。ワークベンチと同じ層の機能モジュール | `src/core` だけ import してよい（ソルバー・workbench・ui は import しない。テストは除く）。画面から見えるのは `src/learn` の入口と、ワークベンチ経由の `math.loadProvider` |
| 5. 基板 | `src/pcb/` | KiCad 基板の取り込み（v0.4）: ファイルの読み取り、部品の発熱ライブラリ、熱プロジェクトの組み立て、取り込みダイアログ。ワークベンチと同じ層の機能モジュール | `src/core` だけ import してよい（ソルバー・workbench は import しない。DOM を触るのはダイアログとプレビューだけで、そこは `src/ui/dom`・`src/ui/format` も可。テストは除く）。画面（シェル）は `src/pcb` を**遅延 import か `import type` だけ**で読む（`src/ui/pcb-open.ts` が入口。`src/workbench/shell.test.ts` と `src/pcb/layers.test.ts` が確かめる） |
| 5. 3D モデル | `src/mesh3d/` | 3D モデル（STL・OBJ）の取り込み（v0.6）: ファイルの読み取り、メッシュの整理・水密性の確認、断面（平面で切って 2D の輪にする）、断面からプロジェクトの組み立て、WebGL の 3D ビューア、取り込みダイアログ。ワークベンチと同じ層の機能モジュール | `src/core` だけ import してよい（ソルバー・workbench は import しない。外部のライブラリ（three.js など）も使わない。DOM・WebGL を触るのはダイアログ・ビューア・断面プレビューだけで、そこは `src/ui/dom`・`src/ui/format` も可。テストは除く）。画面（シェル）は `src/mesh3d` を**遅延 import か `import type` だけ**で読む（`src/ui/mesh-open.ts` が入口。`src/workbench/shell.test.ts` と `src/mesh3d/layers.test.ts` が確かめる） |
| 5. 3D 解析 | `src/sim3d/` | 3D モデルをそのまま解く（v0.6）: 3D の検討（`Study3D`）の画面、面を選んで条件を置く、3D の結果表示（表面の色・断面）。ワークベンチと同じ層の機能モジュール。2D の画面とは別の全画面で開く | `src/core` と、`src/mesh3d` のビューア・カメラ・読み取りだけ import してよい。ソルバーは**遅延 import**（`import('../solvers/heat3d')` など）。DOM を触る部品は `src/ui/dom`・`src/ui/format`・`src/ui/colormap`・`src/ui/lazy` も可（テストは除く）。画面（シェル）は `src/sim3d` を**遅延 import か `import type` だけ**で読む（`src/ui/sim3d-open.ts` が入口）。契約は `src/core/types.ts` の 3D の型と `src/core/grid3d.ts`（Lite とエンジンが同じ格子を使う） |
| 6. 画面 | `src/ui/`、`src/main.ts` | 表示と操作（ハーネス） | ソルバー・解析ごとのモジュール内部への直接アクセス（`src/workbench` の登録表経由のみ） |
| 別プロセス. エンジン | `engine/` | Studio M Engine（PC 上の Node.js サーバー）。`server/`（HTTP・ジョブ・ctx.run）と `adapters/<名前>/`（CalculiX・OpenFOAM などの変換役）。ブラウザとは `src/core/engine-protocol.ts`・`engine-wire.ts` の型だけでやり取りする | `src/core` だけ import してよい（`src/ui`・`src/workbench`・`src/solvers` は import しない。テストは除く）。アダプターは自分で `spawn` せず、必ず `ctx.run` を使う。GPL の解析ソフトは別プロセスとして呼ぶだけで、同梱・リンクしない |

`src/learn` は画面（ハーネス）から**使うときに遅延 import** する（数学の窓を開く・「学ぶ」を開く）。式の提供者（`MathProvider`）だけは、解析ごとのワークベンチが `math.loadProvider`（`() => import('../../learn/providers/<kind>')`）で公開し、画面は `loadMathProvider(kind)`（`src/workbench/registry.ts`）で引く。ワークベンチが learn から使ってよいのは型（`import type`）だけ。

学習機能（数学の窓・学ぶ）は、設定（⚙）の「学習機能を表示する」で出し入れする（既定は OFF、閲覧者ごとに保存。`src/ui/learn-pref.ts`）。OFF のあいだは `src/learn` の部品を読み込まない。`src/learn` を読み込む `import()` は、必ず `loadWhenEnabled`（`learn-pref.ts`）を通す。

結果ボックスの下に解析ごとの追加表示（熱の部品ごとの一覧など）を足したいときは、ワークベンチの任意項目 `ui.loadResultsExtra`（`PanelFactory` を遅延 import で返す）を使う。画面は `createPanelSlot` の `results` で差し込むだけで、解析の種類を見分けない。

ワークベンチのパネルは `src/ui/` の部品（`dom`・`panel-kit`・`easy-kit`・`format` など）を使ってよい。逆に画面のシェルは、解析の種類を `if (kind === 'em')` のように見分けない（`src/workbench/shell.test.ts` が確かめる）。

`src/ui/engine-*.ts`（PC のエンジンへの接続）は画面のシェルなので、解析の種類を見分けない。どの解析にエンジンがあるかは、サーバーが返す `EngineStatus.capabilities` を見て決める。通信（`engine-client.ts`）は fetch だけで DOM に触れず、読み込みは `engine-open.ts`（軽い入口）から遅延 import する。合言葉は閲覧者ごとの localStorage にだけ保存する。

## モジュールの約束

- **モジュール同士は `src/core/types.ts` の型だけでやり取りする。** 新しいやり取りが必要なら、まず契約に型を足す
- **引数はオプションオブジェクトで渡す。** 位置引数を増やしたり並べ替えたりしない。項目を足すときは省略可能（`?`）にして、省略時は今までと同じ動きにする
- **既存の項目の意味や単位を変えない。** 変えるときは新しい名前の項目を足し、古いものは段階的に廃止する
- **解析 1 つ = ワークベンチ 1 つ。** 解析ごとの知識（ソルバー、設定・かんたん・プロのパネル、判定、プリセット、注意書き、表示の癖）は `src/workbench/modules/<kind>.ts` に集め、画面は `listWorkbenches()` / `getWorkbench(kind)` の登録表だけを見る。契約は `src/workbench/types.ts`
- **各モジュールの入口は 1 か所。** ソルバーは `loadSolverFactory(kind)` / `createSolver({ kind, project, raster })`（`src/workbench/registry.ts`）だけを画面から呼ぶ。`src/solvers/index.ts` はテスト・スクリプト用の同期版で、画面は使わない
- **重いモジュールは遅延 import する**（`import()`）。ソルバー、解析ごとのパネル、Excel 出力、画像取り込み、プロ用ツール、将来の CAD エンジン（WASM）など。モジュールファイルは `() => import(...)` で配線するだけにして軽く保つ。読み込みが遅いときの表示と失敗時の日本語メッセージは `src/ui/lazy.ts`（`withLoading`）を使う。単一 HTML のビルドでは 1 ファイルにまとめられるが、デスクトップ版や Pages 版では必要なときだけ読み込まれる
- **テストを付ける。** 純粋な関数は単体テスト。ソルバーは理論値や手計算との照合テスト。契約を満たしているか（必須のフィールド、単位、mask の長さ、判定の形）は `src/workbench/contract.test.ts` が登録済みの全ワークベンチに対して自動で確かめる
- **外部エンジン（SolidCraft、OCCT、OpenFOAM など）は変換層越しに使う。** 外部の型を Studio M の中に漏らさない。バージョンを固定する

### エンジンのアダプターを足すには

1. `engine/adapters/<名前>/index.ts` で `EngineAdapter`（`engine/types.ts`）を export する。サーバーが起動時に自動で拾う（登録表の編集は要らない）
2. 実行は `ctx.run(コマンド名, 引数の配列)` だけ。シェルを通さない。ファイルは `ctx.workDir` の中だけに書き、プロジェクトの文字列をコマンドやファイル名に使わない
3. 失敗は、何が起きてどうすれば直るかを書いた日本語の Error にする（そのまま画面に出る）
4. 解析ソフトを `docs/oss-ledger.json` に `separate-process` で記録する。詳しくは `docs/ENGINE.md`
5. 契約（`engine-protocol.ts`・`engine/types.ts`）を変えるときは、項目を省略可能で足す（ブラウザとエンジンの版が違っても動くように）

### 新しい解析を足すには

1. `src/core/types.ts` の `AnalysisKind` と、必要な設定の型を足し（省略可能に）、`src/core/analyses.ts` に名前と並び順を足す
2. `src/solvers/<kind>.ts` にソルバーを書く（`SolverFactory`）。理論値との照合テストを付ける
3. `src/workbench/modules/<kind>.ts` を作る。必須は `kind`・`label`・`shortHint`・`order`・`loadSolver`。パネル（`src/workbench/panels/<kind>.ts`）、判定（`src/workbench/verdicts/<kind>.ts`）、`hints`、`presets` などは必要なものだけ足す
4. `src/workbench/index.ts` の登録の並びに足す
5. `npm run check` を通す。契約テストと画面の分岐チェックは、登録した時点で自動で対象になる（先頭の `presets` のプリセットで検査されるので、プリセットを 1 つ付ける）

## OSS とライセンス

- 依存を追加・更新したら、**`docs/oss-ledger.json` に記録して `npm run licenses` を通す**
- 記録する項目: 名前、役割、ライセンス、使い方（bundled / dev / installed / separate-process / file-format / planned / reference）、商用利用、義務、出典、確認日
- GPL / AGPL のものは Studio M に組み込まない。別プロセスかファイル連携でだけ使う
- 参考にしただけのプロジェクトも `reference` として記録する（後で自分の OSS を公開するときの再調査用）
- 詳しくは `docs/OSS.md`

## 文章とコメント

- 画面の文言・コメントは日本語。周りのコードの書き方に合わせる
- 利用者向けの警告は、何が起きていて、どうすれば直るかを書く
