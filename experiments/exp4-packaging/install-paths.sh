#!/usr/bin/env bash
# 導入経路ごとの測定: 入っているか・版・ディスク使用量・（--install のとき）導入にかかった時間・
# 小さな計算が通るか・その時間。結果は build/parts/install-paths.json に出す。
#
#   ./install-paths.sh            入っているものを検出して測るだけ（PC には何も入れない）
#   ./install-paths.sh --install  入っていない経路は brew install / docker pull で入れてから測る
set -euo pipefail
KIT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
. "$KIT_DIR/lib/common.sh"

INSTALL=0
for a in "$@"; do
  case "$a" in
    --install) INSTALL=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) fail "知らない引数です: $a（使えるのは --install だけです）" ;;
  esac
done

OUT="$PARTS_DIR/install-paths.json"
rm -f "$OUT"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/exp4-install.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

rec_str "$OUT" platform "$OS_NAME"
rec_str "$OUT" arch "$ARCH_NAME"
rec_str "$OUT" install_mode "$([ "$INSTALL" = 1 ] && echo install || echo detect-only)"
rec_str "$OUT" measured_at "$(date +%Y-%m-%dT%H:%M:%S%z)"

HAVE_BREW=0
if command -v brew >/dev/null 2>&1; then HAVE_BREW=1; fi

# ---------- CalculiX の小さな計算（片持ち梁） ----------
# $1=ccx の実行ファイル  $2=JSON のキー
smoke_ccx() {
  local ccx="$1" key="$2" d="$WORK/beam-$2" t0 t1 res
  mkdir -p "$d"
  node "$KIT_DIR/lib/beam.mjs" write "$d"
  t0=$(now_ms)
  if (cd "$d" && "$ccx" -i beam >ccx.log 2>&1); then
    t1=$(now_ms)
    if res=$(node "$KIT_DIR/lib/beam.mjs" parse "$d" 2>/dev/null); then
      rec "$OUT" "$key.smoke" "$res"
      rec "$OUT" "$key.smoke.ok" true
    else
      rec "$OUT" "$key.smoke.ok" false
      rec_str "$OUT" "$key.smoke.note" "ccx は終わりましたが結果ファイル（beam.dat）を読めませんでした"
    fi
    rec "$OUT" "$key.smoke.seconds" "$(node -e "console.log(($t1-$t0)/1000)")"
  else
    rec "$OUT" "$key.smoke.ok" false
    rec_str "$OUT" "$key.smoke.note" "ccx が失敗しました。$(tail -n 3 "$d/ccx.log" 2>/dev/null | tr '\n' ' ')"
  fi
}

# ---------- OpenFOAM の小さな計算（cavity: blockMesh + icoFoam） ----------
FOAM_SCRIPT='set -e; cp -r "$FOAM_TUTORIALS/incompressible/icoFoam/cavity/cavity" case; cd case; blockMesh > ../blockMesh.log 2>&1; icoFoam > ../icoFoam.log 2>&1'

# $1=OpenFOAM.app  $2=JSON のキー
smoke_foam_app() {
  local app="$1" key="$2" etc d t0 t1 style=""
  etc="$app/Contents/Resources/etc/openfoam"
  d="$WORK/cavity-$2"; mkdir -p "$d"
  if [ ! -e "$etc" ]; then
    rec "$OUT" "$key.smoke.ok" false
    rec_str "$OUT" "$key.smoke.note" "$etc が見つかりません。OpenFOAM.app の作りが想定と違います（README の「要確認」を参照）"
    return 0
  fi
  t0=$(now_ms)
  # 方式 A: 付属の openfoam スクリプトに -c でコマンドを渡す
  if (cd "$d" && bash "$etc" -c "$FOAM_SCRIPT" >run.log 2>&1) && grep -q '^End' "$d/icoFoam.log" 2>/dev/null; then
    style="openfoam -c"
  else
    # 方式 B: 環境ファイルを読み込んでから実行する
    rm -rf "$d/case"
    if (cd "$d" && bash -c "source \"$etc\"; $FOAM_SCRIPT" >run2.log 2>&1) && grep -q '^End' "$d/icoFoam.log" 2>/dev/null; then
      style="source etc/openfoam"
    fi
  fi
  t1=$(now_ms)
  if [ -n "$style" ]; then
    rec "$OUT" "$key.smoke.ok" true
    rec_str "$OUT" "$key.smoke.style" "$style"
  else
    rec "$OUT" "$key.smoke.ok" false
    rec_str "$OUT" "$key.smoke.note" "cavity が通りませんでした。$d の run.log を確認してください（測定後は消えるので、必要なら WORK を残して再実行）"
  fi
  rec "$OUT" "$key.smoke.seconds" "$(node -e "console.log(($t1-$t0)/1000)")"
}

find_foam_app() {
  local p
  for p in /Applications/OpenFOAM-v*.app "$HOME"/Applications/OpenFOAM-v*.app; do
    if [ -d "$p" ]; then echo "$p"; return 0; fi
  done
  return 1
}

# ---------- 1. CalculiX: Homebrew の tap ----------
K=calculix_brew_tap
if [ "$HAVE_BREW" = 1 ]; then
  if ! brew list --formula 2>/dev/null | grep -qx 'calculix-ccx'; then
    if [ "$INSTALL" = 1 ]; then
      say "[CalculiX/tap] brew install costerwi/calculix/calculix-ccx を実行します（ソースからのビルドで 10〜30 分かかることがあります）"
      before=$(du_kb "$(brew --cellar)")
      t0=$(now_ms)
      if brew install costerwi/calculix/calculix-ccx; then
        t1=$(now_ms)
        rec "$OUT" "$K.install_seconds" "$(node -e "console.log(($t1-$t0)/1000)")"
        rec "$OUT" "$K.cellar_delta_kb" "$(( $(du_kb "$(brew --cellar)") - before ))"
      else
        rec_str "$OUT" "$K.note" "brew install に失敗しました。brew doctor の結果と、上のエラーを確認してください"
      fi
    else
      rec_str "$OUT" "$K.note" "入っていません。--install を付けると入れて測ります"
    fi
  fi
  if brew list --formula 2>/dev/null | grep -qx 'calculix-ccx'; then
    rec "$OUT" "$K.detected" true
    rec_str "$OUT" "$K.version" "$(brew list --versions calculix-ccx | awk '{print $2}')"
    rec "$OUT" "$K.keg_kb" "$(du_kb "$(brew --cellar calculix-ccx)")"
    deps_kb=0
    for dep in $(brew deps --installed calculix-ccx 2>/dev/null || true); do
      deps_kb=$(( deps_kb + $(du_kb "$(brew --cellar "$dep" 2>/dev/null || echo /nonexistent)") ))
    done
    rec "$OUT" "$K.deps_kb" "$deps_kb"
    ccx_bin="$(brew --prefix)/bin/ccx"
    if [ -x "$ccx_bin" ]; then smoke_ccx "$ccx_bin" "$K"; fi
  else
    rec "$OUT" "$K.detected" false
  fi
else
  rec "$OUT" "$K.detected" false
  rec_str "$OUT" "$K.note" "Homebrew（brew）が見つかりません。https://brew.sh/ から入れてください"
fi

# ---------- 2. CalculiX: PATH 上の ccx（apt など） ----------
K=calculix_path
if command -v ccx >/dev/null 2>&1; then
  ccx_bin="$(command -v ccx)"
  rec "$OUT" "$K.detected" true
  rec_str "$OUT" "$K.path" "$ccx_bin"
  rec_str "$OUT" "$K.version" "$( (ccx -v 2>&1 || true) | head -n 3 | tr '\n' ' ')"
  rec "$OUT" "$K.binary_kb" "$(du_kb "$ccx_bin")"
  smoke_ccx "$ccx_bin" "$K"
else
  rec "$OUT" "$K.detected" false
fi

# ---------- 3. OpenFOAM: Homebrew（gerlero/openfoam） ----------
K=openfoam_brew
if [ "$HAVE_BREW" = 1 ]; then
  if ! brew list --versions openfoam@2606 >/dev/null 2>&1; then
    if [ "$INSTALL" = 1 ]; then
      say "[OpenFOAM/brew] brew install gerlero/openfoam/openfoam@2606 を実行します（ダウンロードが大きいので時間がかかります）"
      before=$(du_kb "$(brew --cellar)")
      t0=$(now_ms)
      if brew install gerlero/openfoam/openfoam@2606; then
        t1=$(now_ms)
        rec "$OUT" "$K.install_seconds" "$(node -e "console.log(($t1-$t0)/1000)")"
        rec "$OUT" "$K.cellar_delta_kb" "$(( $(du_kb "$(brew --cellar)") - before ))"
      else
        rec_str "$OUT" "$K.note" "brew install に失敗しました（OpenFOAM.app は macOS 15 以降の Apple Silicon だけです）。上のエラーを確認してください"
      fi
    else
      rec_str "$OUT" "$K.note" "入っていません。--install を付けると入れて測ります"
    fi
  fi
  if brew list --versions openfoam@2606 >/dev/null 2>&1; then
    rec "$OUT" "$K.detected" true
    rec_str "$OUT" "$K.version" "$(brew list --versions openfoam@2606 | awk '{print $2}')"
    if app="$(find_foam_app)"; then
      rec_str "$OUT" "$K.app_path" "$app"
      rec "$OUT" "$K.app_kb" "$(du_kb "$app")"
      smoke_foam_app "$app" "$K"
    else
      rec_str "$OUT" "$K.note" "brew では入っていますが OpenFOAM-v*.app が /Applications に見つかりません"
    fi
  else
    rec "$OUT" "$K.detected" false
  fi
else
  rec "$OUT" "$K.detected" false
fi

# ---------- 4. OpenFOAM: /Applications の OpenFOAM.app（手で入れたもの） ----------
K=openfoam_app
if app="$(find_foam_app)"; then
  rec "$OUT" "$K.detected" true
  rec_str "$OUT" "$K.app_path" "$app"
  rec_str "$OUT" "$K.version" "$(basename "$app" .app)"
  rec "$OUT" "$K.app_kb" "$(du_kb "$app")"
  smoke_foam_app "$app" "$K"
else
  rec "$OUT" "$K.detected" false
  rec_str "$OUT" "$K.note" "OpenFOAM-v*.app は /Applications にありません（手で入れる場合は gerlero/openfoam-app の zip を展開して置く）"
fi

# ---------- 5. OpenFOAM: Docker ----------
K=openfoam_docker
IMAGE="opencfd/openfoam-default:2406"
rec_str "$OUT" "$K.image" "$IMAGE"
if command -v docker >/dev/null 2>&1 && docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  rec "$OUT" "$K.daemon" true
  rec_str "$OUT" "$K.docker_version" "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1 && [ "$INSTALL" = 1 ]; then
    say "[OpenFOAM/Docker] docker pull $IMAGE を実行します（圧縮で約 380 MB）"
    t0=$(now_ms)
    if docker pull "$IMAGE"; then
      t1=$(now_ms)
      rec "$OUT" "$K.install_seconds" "$(node -e "console.log(($t1-$t0)/1000)")"
    else
      rec_str "$OUT" "$K.note" "docker pull に失敗しました。ネットワークと Docker のログインを確認してください"
    fi
  fi
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    rec "$OUT" "$K.detected" true
    rec "$OUT" "$K.image_kb" "$(( $(docker image inspect --format '{{.Size}}' "$IMAGE") / 1024 ))"
    d="$WORK/cavity-docker"; mkdir -p "$d"
    t0=$(now_ms)
    if docker run --rm -v "$d:/work" -w /work "$IMAGE" bash -c "$FOAM_SCRIPT" >"$d/run.log" 2>&1 && grep -q '^End' "$d/icoFoam.log" 2>/dev/null; then
      rec "$OUT" "$K.smoke.ok" true
    else
      rec "$OUT" "$K.smoke.ok" false
      rec_str "$OUT" "$K.smoke.note" "cavity が通りませんでした: $(tail -n 3 "$d/run.log" 2>/dev/null | tr '\n' ' ')"
    fi
    t1=$(now_ms)
    rec "$OUT" "$K.smoke.seconds" "$(node -e "console.log(($t1-$t0)/1000)")"
  else
    rec "$OUT" "$K.detected" false
    rec_str "$OUT" "$K.note" "イメージがありません。--install を付けると pull して測ります"
  fi
else
  rec "$OUT" "$K.detected" false
  rec "$OUT" "$K.daemon" false
  rec_str "$OUT" "$K.note" "Docker が入っていない、または起動していません（Docker Desktop を起動してください）"
fi

# ---------- 6. 既存の Studio M Engine が何を検出するか ----------
K=engine_detection
ENGINE_JS="$REPO_ROOT/dist-engine/main.js"
if [ -f "$ENGINE_JS" ] && command -v curl >/dev/null 2>&1; then
  PORT=47895
  TOKEN="exp4-measure-token-0123456789"
  # エンジンは起動のたびに ~/.studio-m/engine-token を書き換えるので、あとで元に戻す
  TOKEN_FILE="$HOME/.studio-m/engine-token"
  TOKEN_BACKUP=""
  if [ -f "$TOKEN_FILE" ]; then TOKEN_BACKUP="$WORK/engine-token.bak"; cp "$TOKEN_FILE" "$TOKEN_BACKUP"; fi
  STUDIO_M_ENGINE_TOKEN="$TOKEN" node "$ENGINE_JS" --port "$PORT" >"$WORK/engine.log" 2>&1 &
  ENGINE_PID=$!
  ok=0
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$PORT/status" >/dev/null 2>&1; then ok=1; break; fi
    sleep 0.5
  done
  if [ "$ok" = 1 ]; then
    # refresh=1 でエンジンを探し直させてから取得する
    curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/status?refresh=1" >"$WORK/status.json" 2>/dev/null || true
    if [ -s "$WORK/status.json" ]; then
      node -e '
        const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        console.log(JSON.stringify({ version: s.version, engines: s.engines, capabilities: (s.capabilities||[]).map(c => c.analysis + "/" + c.engine) }));
      ' "$WORK/status.json" >"$WORK/status-summary.json" 2>/dev/null && rec "$OUT" "$K" "$(cat "$WORK/status-summary.json")"
    else
      rec_str "$OUT" "$K.note" "状態の取得に失敗しました（合言葉が通らなかった可能性があります）"
    fi
  else
    rec_str "$OUT" "$K.note" "エンジンが $PORT 番ポートで応答しませんでした: $(tail -n 3 "$WORK/engine.log" | tr '\n' ' ')"
  fi
  kill "$ENGINE_PID" 2>/dev/null || true
  wait "$ENGINE_PID" 2>/dev/null || true
  if [ -n "$TOKEN_BACKUP" ]; then cp "$TOKEN_BACKUP" "$TOKEN_FILE"; else rm -f "$TOKEN_FILE"; fi
else
  rec_str "$OUT" "$K.note" "dist-engine/main.js がありません。リポジトリのルートで npm install && npm run build:engine を実行してからもう一度（curl も必要です）"
fi

say "導入経路の測定が終わりました: $OUT"
