#!/usr/bin/env bash
# desktop-probe（最小の Electron アプリ）を .app にして、サイズと起動時間を測る。Mac（Apple Silicon）専用。
# 結果は build/parts/app.json に出す。build-bundle.sh のあとに実行する。
#
#   ./measure-app.sh [--launches 3]
#
# やること:
#   1. @electron/packager で .app を作る（同梱物は Contents/Resources/payload に入る）
#   2. サイズ: .app の合計と内訳、zip（ditto -c -k）、dmg（hdiutil があれば）
#   3. 実行ファイルを直接起動して、起動から各段までの時間を 3 回測る（1 回目をコールド、2 回目以降をウォーム）
#   4. ~/Studio M テスト/ に .app をコピーし、作業フォルダー ~/Studio M テスト/作業 フォルダ/ で同じ測定をする
#   5. quarantine の属性を付けたコピーの spctl -a -vv の結果だけを記録する（自動では起動しない）
set -euo pipefail
KIT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
. "$KIT_DIR/lib/common.sh"

LAUNCHES=3
while [ $# -gt 0 ]; do
  case "$1" in
    --launches) shift; LAUNCHES="${1:-3}" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) fail "知らない引数です: $1" ;;
  esac
  shift
done

OUT="$PARTS_DIR/app.json"
rm -f "$OUT"
if ! is_mac; then
  rec "$OUT" skipped true
  rec_str "$OUT" reason "Mac 以外（${OS_NAME}）なので Electron の段は飛ばしました"
  say "Mac ではないので Electron の測定は飛ばします"
  exit 0
fi
[ "$ARCH_NAME" = "arm64" ] || say "注意: Apple Silicon（arm64）ではありません（${ARCH_NAME}）。arm64 の .app は Rosetta なしでは動きません"

PAYLOAD="$BUILD_DIR/payload"
[ -d "$PAYLOAD" ] || fail "$PAYLOAD がありません。先に ./build-bundle.sh を実行してください"
PROBE="$KIT_DIR/desktop-probe"
APP_OUT="$PROBE/out"

# ---------- 1. .app を作る ----------
say "[1/5] .app を作ります（初回は Electron のダウンロードで数分かかります）"
if [ ! -d "$PROBE/node_modules/@electron/packager" ]; then
  (cd "$PROBE" && npm install --no-audit --no-fund) || fail "desktop-probe の npm install に失敗しました。Node.js 22 と、npm レジストリ・GitHub Releases（Electron 本体）に届くネットワークか確認してください"
fi
rm -rf "$APP_OUT"
EXTRA=(--extra-resource="$PAYLOAD")
if [ -f "$REPO_ROOT/dist-engine/main.js" ]; then
  EXTRA+=(--extra-resource="$REPO_ROOT/dist-engine")
else
  say "  dist-engine/ がないので、アプリの中のエンジンの測定は飛ばします（ルートで npm run build:engine を実行すると測れます）"
fi
t0=$(now_ms)
(cd "$PROBE" && npx --no-install electron-packager . "Studio M Probe" --platform=darwin --arch=arm64 --out="$APP_OUT" --overwrite "${EXTRA[@]}") || fail "electron-packager に失敗しました。上のエラーを確認してください"
rec "$OUT" seconds.package "$(node -e "console.log(($(now_ms)-$t0)/1000)")"
APP="$APP_OUT/Studio M Probe-darwin-arm64/Studio M Probe.app"
[ -d "$APP" ] || fail "$APP ができていません"
EXE="$APP/Contents/MacOS/Studio M Probe"
rec_str "$OUT" electron_version "$(node -p "require('$PROBE/package.json').devDependencies.electron")"
rec_str "$OUT" codesign "$(codesign -dv "$APP" 2>&1 | tr '\n' ' ' || true)"

# ---------- 2. サイズ ----------
say "[2/5] サイズを測ります"
rec "$OUT" sizes_kb.app_total "$(du_kb "$APP")"
rec "$OUT" sizes_kb.electron_frameworks "$(du_kb "$APP/Contents/Frameworks")"
rec "$OUT" sizes_kb.executable "$(du_kb "$EXE")"
rec "$OUT" sizes_kb.resources_payload "$(du_kb "$APP/Contents/Resources/payload")"
rec "$OUT" sizes_kb.resources_dist_engine "$(du_kb "$APP/Contents/Resources/dist-engine")"
rec "$OUT" sizes_kb.payload_python "$(du_kb "$APP/Contents/Resources/payload/runtime")"
rec "$OUT" sizes_kb.payload_shape_worker "$(du_kb "$APP/Contents/Resources/payload/workers/shape")"
rec "$OUT" sizes_kb.payload_mesh_worker "$(du_kb "$APP/Contents/Resources/payload/workers/mesh")"
rec "$OUT" sizes_kb.payload_calculix "$(du_kb "$APP/Contents/Resources/payload/engines")"
ZIP="$APP_OUT/probe.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
rec "$OUT" sizes_kb.zip "$(( $(node -e "console.log(require('fs').statSync(process.argv[1]).size)" "$ZIP") / 1024 ))"
if command -v hdiutil >/dev/null 2>&1; then
  DMG="$APP_OUT/probe.dmg"
  if hdiutil create -quiet -volname "Studio M Probe" -srcfolder "$APP" -ov -format UDZO "$DMG" 2>/dev/null; then
    rec "$OUT" sizes_kb.dmg "$(( $(node -e "console.log(require('fs').statSync(process.argv[1]).size)" "$DMG") / 1024 ))"
  fi
fi

# ---------- 3・4. 起動時間 ----------
# $1=.app  $2=作業フォルダー  $3=JSON のキー（scenarios.<名前>）
measure_launches() {
  local app="$1" work="$2" key="$3" exe i t0 t1 wall j
  exe="$app/Contents/MacOS/Studio M Probe"
  mkdir -p "$work"
  for i in $(seq 1 "$LAUNCHES"); do
    j="$work/measure-$i.json"
    rm -f "$j"
    t0=$(now_ms)
    "$exe" --measure --work "$work/run-$i" --out "$j" >"$work/app-$i.log" 2>&1 &
    pid=$!
    # 15 分たっても終わらなければ止める
    for _ in $(seq 1 900); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; rec_str "$OUT" "$key.launch$i.note" "15 分で終わらなかったので止めました"; fi
    wait "$pid" 2>/dev/null || true
    t1=$(now_ms)
    rec "$OUT" "$key.launch$i.wall_seconds" "$(node -e "console.log(($t1-$t0)/1000)")"
    rec_str "$OUT" "$key.launch$i.label" "$([ "$i" = 1 ] && echo cold || echo warm)"
    if [ -f "$j" ]; then
      rec "$OUT" "$key.launch$i.report" "$(cat "$j")"
    else
      rec_str "$OUT" "$key.launch$i.note" "結果の JSON ができませんでした。$(tail -n 3 "$work/app-$i.log" 2>/dev/null | tr '\n' ' ')"
    fi
  done
}

say "[3/5] ビルドした場所で起動時間を測ります（$LAUNCHES 回）"
measure_launches "$APP" "$BUILD_DIR/app-work" scenarios.build_dir

TEST_ROOT="$HOME/Studio M テスト"
say "[4/5] 日本語と空白を含む場所（${TEST_ROOT}）にコピーして測ります"
rm -rf "$TEST_ROOT/Studio M Probe.app"
mkdir -p "$TEST_ROOT/作業 フォルダ"
ditto "$APP" "$TEST_ROOT/Studio M Probe.app"
measure_launches "$TEST_ROOT/Studio M Probe.app" "$TEST_ROOT/作業 フォルダ" scenarios.japanese_path

# ---------- 5. quarantine（ダウンロードしたことにしたアプリ） ----------
say "[5/5] quarantine の属性を付けたコピーを spctl で調べます（起動はしません）"
Q_DIR="$TEST_ROOT/検疫つき"
rm -rf "$Q_DIR"; mkdir -p "$Q_DIR"
ditto "$APP" "$Q_DIR/Studio M Probe.app"
xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");Safari;" "$Q_DIR/Studio M Probe.app"
SPCTL="$(spctl -a -vv "$Q_DIR/Studio M Probe.app" 2>&1 || true)"
rec_str "$OUT" quarantine.spctl "$SPCTL"
rec_str "$OUT" quarantine.app_path "$Q_DIR/Studio M Probe.app"
say "完了: $OUT"
say "手で開く手順（Gatekeeper の実際の表示を見る）は README の「署名なしのアプリを開く」を参照してください"
