#!/usr/bin/env bash
# ファイルを取得して SHA-256 を検証する。source して fetch_verified を呼ぶ（desktop/tools/ccx/fetch.sh と同じ流儀）。
#   fetch_verified <保存先> <期待する SHA-256> <URL> [予備の URL...]
# 期待値が TODO（未確認）のときは、実際の値を表示して失敗する（検証なしでビルドを通さない）。

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch_verified() {
  local dest="$1" expected="$2"; shift 2
  local url ok=0
  for url in "$@"; do
    if curl -fsSL --retry 3 -o "$dest" "$url"; then ok=1; break; fi
    echo "取得できませんでした: $url" >&2
  done
  if [ "$ok" != 1 ]; then
    echo "エラー: $(basename "$dest") を取得できません。ネットワークと versions.env の URL（版・タグ）を確認してください" >&2
    return 1
  fi
  local actual; actual="$(sha256_of "$dest")"
  if [ "$expected" = "TODO" ]; then
    echo "エラー: $(basename "$dest") の SHA-256 が未確認（TODO）です。取得できた実際の値は ${actual} です。" >&2
    echo "  配布元の値と照らして versions.env に書き込んでから、もう一度実行してください" >&2
    return 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "エラー: $(basename "$dest") の SHA-256 が違います（期待 ${expected}、実際 ${actual}）。改ざんか版の違いの可能性があります" >&2
    return 1
  fi
}
