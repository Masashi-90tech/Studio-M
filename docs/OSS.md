# OSS 台帳の使い方

Studio M が使っている・使う予定・参考にした OSS は、すべて `docs/oss-ledger.json` に記録する。
目的は 3 つ。

1. 配布物に、組み込んではいけないライセンス（GPL / AGPL など）が入らないようにする
2. 商用利用や再配布を考えたとき、何を確認すればよいかがすぐ分かるようにする
3. 将来 Studio M や別のものを OSS として公開するとき、調べ直しを最小限にする

## 確認の流れ

```bash
npm run licenses
```

- `package.json` の直接の依存が、すべて台帳に載っているかを確認する
- 配布物に入りうる依存（`devDependencies` 以外。依存の依存も含む）のライセンスを、台帳の `policy` と照らし合わせる
- 問題があれば一覧を出して失敗する。`npm run check` にも含まれている

## 使い方の種類（usage）

| 値 | 意味 |
|---|---|
| bundled | 配布物（ブラウザのバンドルなど）に含まれる |
| dev | 開発・ビルド時だけ使う |
| installed | node_modules には入るが配布物には含まれない（`shipped: false`） |
| separate-process | 別プロセスとして呼び出す |
| file-format | ファイル形式だけでつながる |
| planned | 採用予定。組み込む前に再調査する |
| reference | 参考にしただけ。コードは使っていない |

## ライセンスの扱い（policy）

- **組み込んでよい**: MIT、ISC、BSD、Apache-2.0、0BSD、Unlicense、Zlib など
- **条件付き**: LGPL、MPL。動的リンクや差し替え可能な形など、条件を満たすときだけ組み込む
- **組み込まない**: GPL、AGPL、SSPL。別プロセスかファイル連携でだけ使う
- **デュアルライセンス**: 許可された側を選び、`chosen` に記録する（例: jszip は MIT を選択）

## 記録の例

```json
{
  "name": "SolidCraft",
  "role": "3D CAD エンジン（主力）",
  "license": "MIT OR Apache-2.0",
  "usage": "planned",
  "commercial": "ok",
  "obligations": ["Apache-2.0 を選ぶ場合は NOTICE の保持"],
  "source": "https://github.com/bherbruck/solidcraft",
  "checked": "2026-10-25",
  "notes": "開発初期。変換層越しに使い、バージョンを固定する"
}
```

台帳のライセンス情報は調べた時点のもの。採用・公開・商用利用の前には、各プロジェクトの公式の LICENSE を改めて確認する。
