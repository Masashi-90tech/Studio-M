#!/usr/bin/env bash
# 同梱物（payload）を build/payload/ に組み立て、部品ごとのサイズを build/parts/bundle.json に記録する。
#
#   ./build-bundle.sh [--install] [--python <移動できる Python のフォルダー>] [--python-url <URL>] [--skip-novtk]
#
#   --install        ccx が入っていなければ入れる（Mac は brew、Linux は apt-get）
#   --python <dir>   既存の移動できる Python（bin/python3 を持つフォルダー）を使う
#   --python-url     python-build-standalone の tar.gz の URL を差し替える（既定は下の固定の版）
#   --skip-novtk     vtk なしの変種を作らない
#
# Mac では python-build-standalone の CPython 3.12 を GitHub からダウンロードする。
# Linux の試走では、システムの python3.12 の venv（--copies）で代わりにする（Python 本体のサイズは参考値）。
set -euo pipefail
KIT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
. "$KIT_DIR/lib/common.sh"

# 固定する版
PBS_TAG="20250902"
PBS_PY="3.12.11"
PBS_URL_DEFAULT="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/cpython-${PBS_PY}+${PBS_TAG}-aarch64-apple-darwin-install_only_stripped.tar.gz"
OCP_VER="8.0.1.1.0"
GMSH_VER="4.15.2"

INSTALL=0; PY_DIR=""; PBS_URL="$PBS_URL_DEFAULT"; NOVTK=1
while [ $# -gt 0 ]; do
  case "$1" in
    --install) INSTALL=1 ;;
    --python) shift; PY_DIR="${1:-}"; [ -n "$PY_DIR" ] || fail "--python にフォルダーを指定してください" ;;
    --python-url) shift; PBS_URL="${1:-}" ;;
    --skip-novtk) NOVTK=0 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) fail "知らない引数です: $1" ;;
  esac
  shift
done

OUT="$PARTS_DIR/bundle.json"
PAYLOAD="$BUILD_DIR/payload"
VARIANTS="$BUILD_DIR/variants"
DOWNLOADS="$KIT_DIR/downloads"
rm -f "$OUT"
rm -rf "$PAYLOAD" "$VARIANTS"
mkdir -p "$PAYLOAD/runtime" "$PAYLOAD/workers/shape" "$PAYLOAD/workers/mesh" "$PAYLOAD/workers/common" "$PAYLOAD/engines" "$PAYLOAD/pipeline" "$VARIANTS" "$DOWNLOADS"

rec_str "$OUT" platform "$OS_NAME"
rec_str "$OUT" arch "$ARCH_NAME"
rec_str "$OUT" built_at "$(date +%Y-%m-%dT%H:%M:%S%z)"
rec_str "$OUT" versions.cadquery_ocp "$OCP_VER"
rec_str "$OUT" versions.gmsh "$GMSH_VER"
rec_str "$OUT" versions.python_build_standalone "$PBS_TAG / $PBS_PY"

# ---------- 1. Python 本体 ----------
say "[1/6] Python 本体を用意します"
t0=$(now_ms)
if [ -n "$PY_DIR" ]; then
  [ -x "$PY_DIR/bin/python3" ] || fail "$PY_DIR/bin/python3 が見つかりません。--python には bin/python3 を持つ、移動できる Python のフォルダーを指定してください"
  cp -R "$PY_DIR" "$PAYLOAD/runtime/python"
  rec_str "$OUT" python_source "指定されたフォルダー: $PY_DIR"
elif is_mac; then
  [ "$ARCH_NAME" = "arm64" ] || say "注意: Apple Silicon（arm64）ではありません。aarch64 の Python は動きません"
  TARBALL="$DOWNLOADS/$(basename "$PBS_URL")"
  if [ ! -f "$TARBALL" ]; then
    need_cmd curl "macOS には最初から入っているはずです。"
    say "  ダウンロード: $PBS_URL"
    if ! curl -fL --retry 2 -o "$TARBALL.part" "$PBS_URL"; then
      rm -f "$TARBALL.part"
      fail "python-build-standalone をダウンロードできませんでした。https://github.com/astral-sh/python-build-standalone/releases で cpython-3.12.* の aarch64-apple-darwin-install_only_stripped.tar.gz を探し、--python-url <URL> に指定するか、展開した python フォルダーを --python <フォルダー> で渡してください"
    fi
    mv "$TARBALL.part" "$TARBALL"
  fi
  tar -xzf "$TARBALL" -C "$PAYLOAD/runtime"   # 中身は python/ という 1 つのフォルダー
  [ -x "$PAYLOAD/runtime/python/bin/python3" ] || fail "展開したのに runtime/python/bin/python3 がありません。tar.gz の中身を確認してください"
  rec_str "$OUT" python_source "python-build-standalone（$PBS_URL）"
else
  SYS_PY=""
  for c in /usr/bin/python3.12 python3.12 python3; do
    if command -v "$c" >/dev/null 2>&1 && [ "$("$c" -c 'import sys;print("%d.%d"%sys.version_info[:2])')" = "3.12" ]; then SYS_PY="$c"; break; fi
  done
  [ -n "$SYS_PY" ] || fail "Python 3.12 が見つかりません（cadquery-ocp 8.0.1.1.0 の wheel は 3.12 用）。apt-get install -y python3.12 python3.12-venv を実行してください"
  "$SYS_PY" -m venv --copies "$PAYLOAD/runtime/python" || fail "venv を作れません。apt-get install -y python3.12-venv を実行してください"
  rec_str "$OUT" python_source "試走用: システムの $SYS_PY の venv（--copies）。Python 本体のサイズは参考値（標準ライブラリはシステム側にある）"
fi
PY="$PAYLOAD/runtime/python/bin/python3"
"$PY" -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version' || fail "同梱する Python が 3.12 ではありません。cadquery-ocp の wheel は 3.12 用です"
rec_str "$OUT" python_version "$("$PY" -c 'import sys;print(sys.version.split()[0])')"
rec "$OUT" seconds.python_runtime "$(node -e "console.log(($(now_ms)-$t0)/1000)")"

# pip の共通の引数: wheel だけ（ソースからのビルドをさせない）
pip_install() { "$PY" -m pip install --disable-pip-version-check --only-binary=:all: --quiet "$@"; }

# ---------- 2. 形状ワーカー（OCP）の site-packages ----------
say "[2/6] 形状ワーカー: cadquery-ocp==$OCP_VER と numpy（vtk 込み）"
SHAPE_SP="$PAYLOAD/workers/shape/site-packages"
t0=$(now_ms)
pip_install --target "$SHAPE_SP" "cadquery-ocp==$OCP_VER" numpy || fail "cadquery-ocp を入れられません。ネットワークと、Python が 3.12 であることを確認してください"
rec "$OUT" seconds.shape_site_packages "$(node -e "console.log(($(now_ms)-$t0)/1000)")"

if [ "$NOVTK" = 1 ]; then
  say "      変種: vtk を除いた版（--no-deps）"
  NOVTK_SP="$VARIANTS/shape-novtk/site-packages"
  pip_install --target "$NOVTK_SP" --no-deps "cadquery-ocp==$OCP_VER" "cadquery-ocp-proxy==$OCP_VER" || fail "vtk なしの変種を入れられません（--skip-novtk で飛ばせます）"
  pip_install --target "$NOVTK_SP" numpy
fi

# ---------- 3. メッシュワーカー（Gmsh）の site-packages ----------
say "[3/6] メッシュワーカー: gmsh==$GMSH_VER と numpy（GPL のため形状とは別フォルダー）"
MESH_SP="$PAYLOAD/workers/mesh/site-packages"
t0=$(now_ms)
pip_install --target "$MESH_SP" "gmsh==$GMSH_VER" numpy || fail "gmsh を入れられません"
# gmsh の wheel は共有ライブラリを data/lib に持ち、pip --target では落ちてしまうので、wheel から取り出して
# workers/mesh/lib に置く（gmsh.py は site-packages の親の lib を探す）
GMSH_DL="$BUILD_DIR/gmsh-wheel"; rm -rf "$GMSH_DL"; mkdir -p "$GMSH_DL"
"$PY" -m pip download --disable-pip-version-check --only-binary=:all: --no-deps --quiet -d "$GMSH_DL" "gmsh==$GMSH_VER"
"$PY" - "$GMSH_DL" "$PAYLOAD/workers/mesh/lib" <<'PYEOF'
import glob, os, shutil, sys, zipfile
dl, dest = sys.argv[1], sys.argv[2]
os.makedirs(dest, exist_ok=True)
whl = glob.glob(os.path.join(dl, 'gmsh-*.whl'))[0]
n = 0
with zipfile.ZipFile(whl) as z:
    for m in z.namelist():
        base = os.path.basename(m)
        if '.data/data/lib/' in m and base.startswith('libgmsh'):
            with z.open(m) as s, open(os.path.join(dest, base), 'wb') as d:
                shutil.copyfileobj(s, d)
            os.chmod(os.path.join(dest, base), 0o755)
            n += 1
if n == 0:
    sys.exit('wheel に libgmsh が見つかりません')
PYEOF
rm -rf "$GMSH_DL"
rec "$OUT" seconds.mesh_site_packages "$(node -e "console.log(($(now_ms)-$t0)/1000)")"

# ---------- 4. CalculiX（ccx と共有ライブラリ） ----------
say "[4/6] CalculiX を集めます"
CCX_SRC=""
if is_mac; then
  if command -v brew >/dev/null 2>&1 && [ -x "$(brew --prefix)/bin/ccx" ]; then CCX_SRC="$(brew --prefix)/bin/ccx"
  elif command -v ccx >/dev/null 2>&1; then CCX_SRC="$(command -v ccx)"; fi
  if [ -z "$CCX_SRC" ] && [ "$INSTALL" = 1 ]; then
    need_cmd brew "https://brew.sh/ から Homebrew を入れてください。"
    say "  brew install costerwi/calculix/calculix-ccx を実行します（ソースからのビルドで時間がかかります）"
    brew install costerwi/calculix/calculix-ccx
    CCX_SRC="$(brew --prefix)/bin/ccx"
  fi
  [ -n "$CCX_SRC" ] || fail "ccx が見つかりません。./build-bundle.sh --install を付けるか、brew install costerwi/calculix/calculix-ccx を実行してください"
else
  if command -v ccx >/dev/null 2>&1; then CCX_SRC="$(command -v ccx)"
  elif [ "$INSTALL" = 1 ]; then
    say "  apt-get install -y calculix-ccx を実行します"
    if [ "$(id -u)" = 0 ]; then apt-get install -y calculix-ccx; else sudo apt-get install -y calculix-ccx; fi
    CCX_SRC="$(command -v ccx)"
  fi
  [ -n "$CCX_SRC" ] || fail "ccx が見つかりません。./build-bundle.sh --install を付けるか、apt-get install -y calculix-ccx を実行してください"
fi
rec_str "$OUT" ccx_source "$CCX_SRC"
"$PY" "$KIT_DIR/lib/bundle_ccx.py" --ccx "$CCX_SRC" --out "$PAYLOAD/engines/calculix" >"$BUILD_DIR/bundle_ccx.log" || { tail -n 5 "$BUILD_DIR/bundle_ccx.log" >&2; fail "ccx の依存ライブラリの収集に失敗しました"; }

# ---------- 5. スクリプトの配置・不要物の削除・サイズ ----------
say "[5/6] スクリプトを置き、不要物を消してサイズを測ります"
cp "$KIT_DIR/pipeline/shape_worker.py" "$PAYLOAD/workers/shape/"
cp "$KIT_DIR/pipeline/mesh_worker.py" "$PAYLOAD/workers/mesh/"
cp "$KIT_DIR/pipeline/ccx_tool.py" "$PAYLOAD/workers/common/"
cp "$KIT_DIR/pipeline/run-pipeline.mjs" "$PAYLOAD/pipeline/"

measure() { # $1=キー（before / after）
  local k="$1"
  rec "$OUT" "sizes_kb.$k.python_runtime" "$(du_kb "$PAYLOAD/runtime/python")"
  rec "$OUT" "sizes_kb.$k.shape_site_packages" "$(du_kb "$SHAPE_SP")"
  rec "$OUT" "sizes_kb.$k.mesh_site_packages" "$(du_kb "$MESH_SP")"
  rec "$OUT" "sizes_kb.$k.gmsh_lib" "$(du_kb "$PAYLOAD/workers/mesh/lib")"
  rec "$OUT" "sizes_kb.$k.ccx_bin" "$(du_kb "$PAYLOAD/engines/calculix/bin")"
  rec "$OUT" "sizes_kb.$k.ccx_lib" "$(du_kb "$PAYLOAD/engines/calculix/lib")"
  local ocp=0 vtk=0 f
  for f in "$SHAPE_SP"/OCP "$SHAPE_SP"/cadquery_ocp* "$SHAPE_SP"/OCP-*; do [ -e "$f" ] && ocp=$((ocp + $(du_kb "$f"))); done
  for f in "$SHAPE_SP"/vtk*; do [ -e "$f" ] && vtk=$((vtk + $(du_kb "$f"))); done
  rec "$OUT" "sizes_kb.$k.ocp_packages" "$ocp"
  rec "$OUT" "sizes_kb.$k.vtk_packages" "$vtk"
  rec "$OUT" "sizes_kb.$k.numpy_in_mesh" "$(du_kb "$MESH_SP/numpy")"
  if [ "$NOVTK" = 1 ]; then rec "$OUT" "sizes_kb.$k.shape_site_packages_novtk" "$(du_kb "$NOVTK_SP")"; fi
  rec "$OUT" "sizes_kb.$k.payload_total" "$(du_kb "$PAYLOAD")"
}
rec "$OUT" shape_site_packages_top "$(node "$KIT_DIR/lib/sizes.mjs" "$SHAPE_SP" 8)"
measure before

prune() { # $1=フォルダー: キャッシュ・テスト・型スタブ・ヘッダーなど実行に要らないものを消す
  find "$1" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
  find "$1" -type d \( -name tests -o -name test \) -prune -exec rm -rf {} + 2>/dev/null || true
  find "$1" -type f \( -name '*.pyi' -o -name '*.pyc' \) -exec rm -f {} + 2>/dev/null || true
  rm -rf "$1/bin" "$1/include" "$1/share" 2>/dev/null || true
}
prune "$SHAPE_SP"; prune "$MESH_SP"
if [ "$NOVTK" = 1 ]; then prune "$NOVTK_SP"; fi
# Python 本体のテストと GUI 部品（venv では何も消えない）
rm -rf "$PAYLOAD"/runtime/python/lib/python3.12/{test,idlelib,tkinter,turtledemo,ensurepip} 2>/dev/null || true
find "$PAYLOAD/runtime/python" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
measure after

node "$KIT_DIR/lib/third-party.mjs" "$PAYLOAD" >/dev/null

# ---------- 6. 動作確認: 形状ワーカーの 2 つの版（vtk あり・なし）で import と STEP の読み書きが通るか ----------
say "[6/6] 形状ワーカーの確認（vtk あり・なし）"
check_shape() { # $1=キー  $2=site-packages
  local k="$1" sp="$2" log="$BUILD_DIR/shape-check-$1.log" line
  if PYTHONPATH="$sp" PYTHONNOUSERSITE=1 "$PY" "$PAYLOAD/workers/shape/shape_worker.py" --out "$BUILD_DIR/shape-check-$k.step" >"$log" 2>&1; then
    line="$(grep '^{' "$log" | tail -n 1)"
    rec "$OUT" "variants.$k.ok" true
    rec "$OUT" "variants.$k.result" "$line"
  else
    rec "$OUT" "variants.$k.ok" false
    rec_str "$OUT" "variants.$k.note" "$(tail -n 3 "$log" | tr '\n' ' ')"
  fi
}
check_shape with_vtk "$SHAPE_SP"
if [ "$NOVTK" = 1 ]; then check_shape without_vtk "$NOVTK_SP"; fi
rm -f "$BUILD_DIR"/shape-check-*.step

say "同梱物ができました: $PAYLOAD（合計 $(du_kb "$PAYLOAD") KB）"
