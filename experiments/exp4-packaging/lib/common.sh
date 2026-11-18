# 共通の道具。各スクリプトから `. "$KIT_DIR/lib/common.sh"` で読み込む。
# macOS 付属の bash 3.2 と BSD のコマンドでも動くように、GNU 専用の書き方は使わない。

KIT_DIR="${KIT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
REPO_ROOT="$(cd "$KIT_DIR/../.." && pwd -P)"
BUILD_DIR="${BUILD_DIR:-$KIT_DIR/build}"
PARTS_DIR="$BUILD_DIR/parts"
RESULTS_DIR="${RESULTS_DIR:-$KIT_DIR/results}"
OS_NAME="$(uname -s)"   # Darwin か Linux
ARCH_NAME="$(uname -m)" # arm64 か x86_64
mkdir -p "$PARTS_DIR"

say() { printf '%s\n' "$*" >&2; }
fail() { printf 'エラー: %s\n' "$*" >&2; exit 1; }

# 現在時刻（ミリ秒）。macOS の date は %N が使えないので node で測る
now_ms() { node -e 'console.log(Date.now())'; }

# ディレクトリの使用量（KB）。GNU の du も BSD の du も -sk が通る
du_kb() {
  if [ -e "$1" ]; then du -sk "$1" 2>/dev/null | awk '{print $1}'; else echo 0; fi
}

# JSON ファイルに値を書き足す: rec <ファイル> <a.b.c> <JSON の値>、文字列は rec_str
rec() { node "$KIT_DIR/lib/rec.mjs" "$1" "$2" "$3"; }
rec_str() { node "$KIT_DIR/lib/rec.mjs" "$1" "$2" --str "$3"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "「$1」が見つかりません。$2"
}
need_cmd node "Node.js 22 以上を https://nodejs.org/ から入れてください（brew install node@22 でも可）。"

is_mac() { [ "$OS_NAME" = "Darwin" ]; }
