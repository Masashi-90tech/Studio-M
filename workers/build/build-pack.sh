#!/usr/bin/env bash
# 3D ワーカーの同梱物（workers-pack）を組み立てる。手順は docs/WORKERS-BUILD.md。
#   使い方: build-pack.sh <作業フォルダー>
#   できるもの: <作業フォルダー>/workers-pack/（同梱物）と <作業フォルダー>/workers-<プラットフォーム>.zip
#   プラットフォーム: macos-arm64 / windows-x64（既定は実行している OS から決める）。手元の Linux の確認用に
#   WORKERS_PLATFORM=linux-x64 も使える。macOS ランナーと、Windows の Git Bash（shell: bash）で動く。
#
# 出力の形（Engine が後でこの形を前提に呼ぶ。workers/README.md）:
#   workers-pack/
#     python/                python-build-standalone（実行環境）
#     shape-site/            cadquery-ocp-novtk・cadquery-ocp-proxy・numpy
#     mesh-site/             gmsh・numpy（GPL。形状側と別フォルダー）
#     scripts/               shape_worker.py・shape_lib.py・mesh_worker.py・mesh_lib.py
#     THIRD-PARTY-LICENSES/workers/   ライセンス文・SOURCE.txt・WHEELS.txt
#     manifest.json          版と大きさ [bytes]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
. "$HERE/versions.env"
. "$HERE/fetch.sh"

# ---- Windows（Git Bash）ではパスの形を使い分ける: bash 用は /d/a/…、Windows のプログラム（python.exe）には D:/a/… ----
if command -v cygpath >/dev/null 2>&1; then
  to_bash() { cygpath -u "$1"; }
  to_native() { cygpath -m "$1"; }
else
  to_bash() { printf '%s\n' "$1"; }
  to_native() { printf '%s\n' "$1"; }
fi

PLATFORM="${WORKERS_PLATFORM:-}"
if [ -z "$PLATFORM" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PLATFORM=macos-arm64 ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM=windows-x64 ;;
    Linux-x86_64) PLATFORM=linux-x64 ;;
    *) echo "エラー: この OS・CPU（$(uname -s) $(uname -m)）は対象外です。macOS（Apple Silicon）か Windows（x64）で実行してください" >&2; exit 1 ;;
  esac
fi
case "$PLATFORM" in
  macos-arm64)  PBS_FILE="$PBS_MACOS_ARM64_FILE";  PBS_SHA="$PBS_MACOS_ARM64_SHA256";  PY_REL="python/bin/python3"; LIB_REL="python/lib/python3.12" ;;
  windows-x64)  PBS_FILE="$PBS_WINDOWS_X64_FILE";  PBS_SHA="$PBS_WINDOWS_X64_SHA256";  PY_REL="python/python.exe";  LIB_REL="python/Lib" ;;
  linux-x64)    PBS_FILE="$PBS_LINUX_X64_FILE";    PBS_SHA="$PBS_LINUX_X64_SHA256";    PY_REL="python/bin/python3"; LIB_REL="python/lib/python3.12" ;;
  *) echo "エラー: WORKERS_PLATFORM=$PLATFORM は使えません（macos-arm64 / windows-x64 / linux-x64）" >&2; exit 1 ;;
esac

WORK_ARG="${1:?使い方: build-pack.sh <作業フォルダー>}"
mkdir -p "$(to_bash "$WORK_ARG")"
WORK="$(cd "$(to_bash "$WORK_ARG")" && pwd -P)"
PACK="$WORK/workers-pack"
PY="$PACK/$PY_REL"
SITE_STD="$PACK/$LIB_REL/site-packages"

echo "== プラットフォーム: ${PLATFORM}（Python ${PBS_PYTHON_VERSION}）"

# ---- 0. wheel の版が requirements と揃っているか ----
check_pin() { # <ファイル> <名前> <版>
  grep -Eq "^$2==$3([[:space:]]|$)" "$1" || {
    echo "エラー: $1 に $2==$3 がありません。workers/build/versions.env の版と workers/requirements-*.txt を揃えてください" >&2; exit 1; }
}
check_pin "$REPO/workers/requirements-shape.txt" cadquery-ocp-novtk "$OCP_NOVTK_VERSION"
check_pin "$REPO/workers/requirements-shape.txt" cadquery-ocp-proxy "$OCP_PROXY_VERSION"
check_pin "$REPO/workers/requirements-shape.txt" numpy "$NUMPY_VERSION"
check_pin "$REPO/workers/requirements-mesh.txt" gmsh "$GMSH_VERSION"
check_pin "$REPO/workers/requirements-mesh.txt" numpy "$NUMPY_VERSION"

# ---- 1. Python の取得・検証・展開 ----
rm -rf "$PACK" "$WORK/wheels"; mkdir -p "$PACK" "$WORK/dl"
PBS_URL="${PBS_BASE_URL}/${PBS_FILE//+/%2B}"
fetch_verified "$WORK/dl/$PBS_FILE.tmp" "$PBS_SHA" "$PBS_URL"
tar -xzf "$WORK/dl/$PBS_FILE.tmp" -C "$PACK"
[ -x "$PY" ] || { echo "エラー: 展開した Python が見つかりません（${PY}）。tar の中身の形が変わっていないか確認してください" >&2; exit 1; }

export PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_INPUT=1 PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 PYTHONUTF8=1
unset PYTHONHOME PYTHONPATH || true
PYV="$("$PY" -c 'import platform;print(platform.python_version())')"
[ "$PYV" = "$PBS_PYTHON_VERSION" ] || { echo "エラー: 展開した Python の版が $PYV で、期待（${PBS_PYTHON_VERSION}）と違います" >&2; exit 1; }

# ---- 2. wheel を取得して固定し、--no-deps で別々のフォルダーに入れる ----
install_group() { # <名前> <requirements> <入れる先>
  local group="$1" req="$2" site="$3"
  mkdir -p "$WORK/wheels/$group" "$site"
  "$PY" -m pip download --no-deps --only-binary=:all: -d "$(to_native "$WORK/wheels/$group")" -r "$(to_native "$req")"
  "$PY" -m pip install --no-deps --only-binary=:all: --no-index --find-links "$(to_native "$WORK/wheels/$group")" \
    --target "$(to_native "$site")" -r "$(to_native "$req")"
  rm -rf "$site/bin" "$site/Scripts" "$site/include" "$site/share"   # numpy の f2py などの起動用スクリプト、ヘッダー、文書（要らない）
  local w
  for w in "$WORK/wheels/$group"/*.whl; do
    # pip は --target のとき、wheel の data/lib（gmsh の libgmsh など）を捨てる。site の中へ自分で取り出す
    "$PY" "$(to_native "$HERE/wheel_data.py")" "$(to_native "$w")" "$(to_native "$site")"
    printf '%s\t%s\t%s\n' "$group" "$(basename "$w")" "$(sha256_of "$w")" >> "$WORK/wheels.tsv"
  done
}
: > "$WORK/wheels.tsv"
install_group shape "$REPO/workers/requirements-shape.txt" "$PACK/shape-site"
install_group mesh "$REPO/workers/requirements-mesh.txt" "$PACK/mesh-site"

# GPL の約束: Gmsh は mesh-site だけ。形状側に入っていたら止める
if ls "$PACK/shape-site" | grep -qi '^gmsh'; then
  echo "エラー: shape-site に gmsh が入っています。GPL の Gmsh は mesh-site にだけ入れてください（workers/requirements-shape.txt を確認）" >&2; exit 1
fi

# ---- 3. 不要物の削除（削っても動くことは、下の確認と plate_check.py で確かめる） ----
prune_tree() { # <フォルダー>: キャッシュ・テスト・型定義
  find "$1" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
  find "$1" -type d \( -name tests -o -name test \) -prune -exec rm -rf {} + 2>/dev/null || true
  find "$1" -type f \( -name '*.pyi' -o -name '*.pyc' \) -delete 2>/dev/null || true
}
before_py=$("$PY" -c "import os,sys;print(sum(os.lstat(os.path.join(r,f)).st_size for r,_,fs in os.walk(sys.argv[1]) for f in fs))" "$(to_native "$PACK/python")")
prune_tree "$PACK/shape-site"
prune_tree "$PACK/mesh-site"
# pip 自体と、インストールの道具（実行時には使わない。ここから先は pip を使わない）
rm -rf "$SITE_STD"/pip "$SITE_STD"/pip-*.dist-info "$SITE_STD"/setuptools "$SITE_STD"/setuptools-*.dist-info \
       "$SITE_STD"/pkg_resources "$SITE_STD"/_distutils_hack "$SITE_STD"/wheel "$SITE_STD"/wheel-*.dist-info
rm -rf "$PACK/$LIB_REL"/idlelib "$PACK/$LIB_REL"/turtledemo "$PACK/$LIB_REL"/ensurepip "$PACK/$LIB_REL"/config-3.12-*
prune_tree "$PACK/$LIB_REL"
rm -f "$PACK"/python/bin/pip* "$PACK"/python/bin/idle* "$PACK"/python/bin/2to3* "$PACK"/python/bin/pydoc* "$PACK"/python/bin/*-config 2>/dev/null || true
rm -rf "$PACK/python/Scripts" "$PACK/python/include" "$PACK/python/share" "$PACK/python/libs" 2>/dev/null || true
after_py=$("$PY" -c "import os,sys;print(sum(os.lstat(os.path.join(r,f)).st_size for r,_,fs in os.walk(sys.argv[1]) for f in fs))" "$(to_native "$PACK/python")")
echo "== Python 本体: $before_py → $after_py bytes（削除後）"

# macOS: 実行ファイルの隣の dylib をそのまま読み込める形で動くはず。動かないときだけ WORKERS_RESIGN=1 で ad-hoc 署名をやり直す
# （同梱物は署名なしの .app に入るので、起動できることを下の確認と plate_check.py で実際に動かして確かめる）
if [ "$PLATFORM" = macos-arm64 ] && [ "${WORKERS_RESIGN:-0}" = 1 ]; then
  echo "== ad-hoc 署名をやり直します"
  find "$PACK" \( -name '*.so' -o -name '*.dylib' -o -path '*/python/bin/python3.12' \) -type f -exec codesign --force -s - {} \;
fi

# ---- 4. ワーカーのスクリプトとライセンス文 ----
mkdir -p "$PACK/scripts" "$PACK/THIRD-PARTY-LICENSES/workers"
cp "$REPO/workers/shape/shape_worker.py" "$REPO/workers/shape/shape_lib.py" \
   "$REPO/workers/mesh/mesh_worker.py" "$REPO/workers/mesh/mesh_lib.py" "$PACK/scripts/"
cp "$REPO"/THIRD-PARTY-LICENSES/workers/*.txt "$PACK/THIRD-PARTY-LICENSES/workers/"
# 実際に同梱した Python・numpy のライセンス文も、同梱物から取って入れる（版が上がっても追える）
[ -f "$PACK/$LIB_REL/LICENSE.txt" ] && cp "$PACK/$LIB_REL/LICENSE.txt" "$PACK/THIRD-PARTY-LICENSES/workers/Python-LICENSE.txt"
for d in "$PACK"/shape-site/numpy-*.dist-info; do
  [ -f "$d/licenses/LICENSE.txt" ] && cp "$d/licenses/LICENSE.txt" "$PACK/THIRD-PARTY-LICENSES/workers/numpy-LICENSE.txt"
done
{
  echo "実際に同梱した wheel の SHA-256（${PLATFORM}。PyPI の配布物。この実行で取得したもの）"
  echo "グループ  ファイル  SHA-256"
  tr '\t' ' ' < "$WORK/wheels.tsv"
  echo "Python: $PBS_FILE  $PBS_SHA"
} > "$PACK/THIRD-PARTY-LICENSES/workers/WHEELS.txt"

# ---- 5. 削ったあとでも動くことの確認（OCP・gmsh を読み込めること、Gmsh が形状側にないこと） ----
SHAPE_SITE_N="$(to_native "$PACK/shape-site")"; MESH_SITE_N="$(to_native "$PACK/mesh-site")"
PYTHONPATH="$SHAPE_SITE_N" "$PY" -c "import OCP, numpy; from OCP.STEPControl import STEPControl_Reader; print('形状側 OK: OCP, numpy', numpy.__version__)" \
  || { echo "エラー: 形状側（shape-site）で OCP を読み込めません。不要物の削除で壊れた可能性があります（build-pack.sh の prune を確認）" >&2; exit 1; }
PYTHONPATH="$MESH_SITE_N" "$PY" -c "import gmsh, numpy; gmsh.initialize(); gmsh.finalize(); print('メッシュ側 OK: gmsh', gmsh.__version__, 'numpy', numpy.__version__)" \
  || { echo "エラー: メッシュ側（mesh-site）で gmsh を読み込めません。不要物の削除で壊れたか、OS のライブラリが足りない可能性があります（Linux は libGLU.so.1）" >&2; exit 1; }
PYTHONPATH="$SHAPE_SITE_N" "$PY" -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('gmsh') is None else 1)" \
  || { echo "エラー: 形状側から gmsh が見えます。GPL の Gmsh は別フォルダーにだけ置いてください" >&2; exit 1; }
PYTHONPATH="$MESH_SITE_N" "$PY" -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('OCP') is None else 1)" \
  || { echo "エラー: メッシュ側から OCP が見えます。メッシュ側は gmsh と numpy だけにしてください" >&2; exit 1; }

# ---- 6. manifest.json と zip ----
COMMIT="${GITHUB_SHA:-$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)}"
"$PY" "$(to_native "$HERE/manifest.py")" --pack "$(to_native "$PACK")" --platform "$PLATFORM" --workers-version "$WORKERS_VERSION" \
  --python-version "$PBS_PYTHON_VERSION" --wheels "$(to_native "$WORK/wheels.tsv")" --commit "$COMMIT"
ZIP="$WORK/workers-$PLATFORM.zip"
rm -f "$ZIP"
"$PY" "$(to_native "$HERE/zip_pack.py")" "$(to_native "$PACK")" "$(to_native "$ZIP")"
echo "== できました: $PACK"
echo "== zip: $ZIP"
