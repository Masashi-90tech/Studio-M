#!/usr/bin/env bash
# 実証実験 4 の測定を 1 回で行う。結果は results/<ホスト名>-<日時>.json と .md に出る。
#
#   ./run-all.sh [--install] [--skip-install-paths]
#
#   --install   入っていない導入経路（brew の CalculiX・OpenFOAM、Docker のイメージ）と ccx を実際に入れて測る。
#               付けないと、入っているものを検出して測るだけ（PC には何も入れない）
#   BUNDLE_ARGS="--python <dir> --skip-novtk" のように環境変数で build-bundle.sh の追加引数を渡せる
set -euo pipefail
KIT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
. "$KIT_DIR/lib/common.sh"

INSTALL_FLAG=""; SKIP_IP=0
for a in "$@"; do
  case "$a" in
    --install) INSTALL_FLAG="--install" ;;
    --skip-install-paths) SKIP_IP=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) fail "知らない引数です: $a" ;;
  esac
done

HOST="$(hostname -s 2>/dev/null || hostname)"
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="${HOST}-${STAMP}"
rm -rf "$PARTS_DIR"; mkdir -p "$PARTS_DIR" "$RESULTS_DIR"
STEPS="$PARTS_DIR/steps.json"
run_step() { # $1=名前  残り=コマンド。失敗しても次へ進み、結果に失敗と書く
  local name="$1"; shift
  say ""; say "=== $name ==="
  if "$@"; then rec_str "$STEPS" "$name" ok; else rec_str "$STEPS" "$name" "失敗"; say "（$name は失敗しました。続きを実行します）"; return 1; fi
}

FAILED=0
if [ "$SKIP_IP" = 0 ]; then
  run_step "導入経路" "$KIT_DIR/install-paths.sh" $INSTALL_FLAG || true
fi
# shellcheck disable=SC2086
run_step "同梱物のビルド" "$KIT_DIR/build-bundle.sh" $INSTALL_FLAG ${BUNDLE_ARGS:-} || FAILED=1

PAYLOAD="$BUILD_DIR/payload"
if [ -d "$PAYLOAD" ] && [ "$FAILED" = 0 ]; then
  run_step "一連の処理（通常のパス）" node "$KIT_DIR/pipeline/run-pipeline.mjs" --payload "$PAYLOAD" --work "$BUILD_DIR/work" --json "$PARTS_DIR/pipeline-normal.json" || FAILED=1
  # 日本語と空白を含むパス: 同梱物を別名（シンボリックリンク）で呼び、作業フォルダーも日本語にする
  JP="$BUILD_DIR/日本語 テスト"
  rm -rf "$JP"; mkdir -p "$JP"
  ln -s "$PAYLOAD" "$JP/同梱物 payload"
  run_step "一連の処理（日本語・空白のパス）" node "$KIT_DIR/pipeline/run-pipeline.mjs" --payload "$JP/同梱物 payload" --work "$JP/作業 フォルダ" --json "$PARTS_DIR/pipeline-japanese.json" || FAILED=1
fi

if is_mac && [ "$FAILED" = 0 ]; then
  run_step "Electron アプリ" "$KIT_DIR/measure-app.sh" || FAILED=1
elif is_mac; then
  rec "$PARTS_DIR/app.json" skipped true
  rec_str "$PARTS_DIR/app.json" reason "前の段（同梱物のビルドか一連の処理）が失敗したため、Electron の段は飛ばしました。上のエラーを直してから実行し直してください"
  say ""; say "=== Electron アプリ: 前の段が失敗したので飛ばします ==="
else
  rec "$PARTS_DIR/app.json" skipped true
  rec_str "$PARTS_DIR/app.json" reason "Mac 以外（${OS_NAME}）のため、Electron の段（.app の作成・起動時間・日本語パス・quarantine）は飛ばしました。Linux の試走の結果は参考値です"
  say ""; say "=== Electron アプリ: Mac 以外なので飛ばします ==="
fi

say ""
node "$KIT_DIR/summarize.mjs" --parts "$PARTS_DIR" --out "$RESULTS_DIR" --name "$NAME"
say "結果: $RESULTS_DIR/$NAME.md（docs/EXPERIMENT-4.md の「結果」に貼れます）"
exit "$FAILED"
