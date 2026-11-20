#!/usr/bin/env bash
# macOS arm64 で CalculiX（ccx）を公式ソースからビルドする（GitHub の macos-14 ランナー向け）。
#   使い方: build-macos.sh <作業フォルダー>   → <作業フォルダー>/ccx_<版> ができる
# Homebrew の ccx には頼らない。使うのは Homebrew の gcc（gfortran・OpenMP）、openblas、arpack-ng だけ。
# 状態: 手順は実験 4（docs/EXPERIMENT-4.md）と costerwi/homebrew-calculix を参考に書いた。Actions 上では未実行。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/versions.env"
. "$HERE/fetch.sh"

WORK="${1:?使い方: build-macos.sh <作業フォルダー>}"
mkdir -p "$WORK"; WORK="$(cd "$WORK" && pwd -P)"

brew install gcc openblas arpack
BREW="$(brew --prefix)"
GCC_MAJOR="$(ls "$BREW/bin" | sed -n 's/^gcc-\([0-9][0-9]*\)$/\1/p' | sort -n | tail -1)"
[ -n "$GCC_MAJOR" ] || { echo "エラー: Homebrew の gcc が見つかりません。brew install gcc を確認してください" >&2; exit 1; }
CC="gcc-$GCC_MAJOR"; FC="gfortran-$GCC_MAJOR"

# 1. ソースの取得と検証
fetch_verified "$WORK/ccx.tar.bz2" "$CCX_SHA256" "$CCX_URL" "$CCX_URL_FALLBACK"
fetch_verified "$WORK/spooles.tgz" "$SPOOLES_SHA256" "$SPOOLES_URL"
rm -rf "$WORK/src"; mkdir -p "$WORK/src/SPOOLES.2.2"
tar -xjf "$WORK/ccx.tar.bz2" -C "$WORK/src"
tar -xzf "$WORK/spooles.tgz" -C "$WORK/src/SPOOLES.2.2"
CCX_SRC="$(ls -d "$WORK"/src/*/ccx_*/src | head -1)"
[ -d "$CCX_SRC" ] || { echo "エラー: ccx のソースの場所が分かりません（${WORK}/src を確認）" >&2; exit 1; }

# 2. SPOOLES（静的ライブラリ。MT 版も作る）
(
  cd "$WORK/src/SPOOLES.2.2"
  sed -i '' -E "s|^ *CC *=.*|  CC = $CC|; s|^ *OPTLEVEL *=.*|  OPTLEVEL = -O2|" Make.inc
  make lib
  (cd MT/src && make -f makeGlobalLib)
)

# 3. ccx（Makefile は sed で差し替える）
(
  cd "$CCX_SRC"
  sed -E \
    -e "s|@SPOOLES@|$WORK/src/SPOOLES.2.2|g" -e "s|@ARCH@|Darwin|g" -e "s|@CC@|$CC|g" -e "s|@FC@|$FC|g" \
    "$HERE/patches/ccx-makefile.sed" > "$WORK/ccx-makefile.sed"
  sed -i '' -E -f "$WORK/ccx-makefile.sed" Makefile
  sed -i '' -E "s|^LIBS *=.*|LIBS = $WORK/src/SPOOLES.2.2/spooles.a -L$BREW/lib -L$BREW/opt/openblas/lib -larpack -lopenblas -lpthread -lm|" Makefile
  make -j"$(sysctl -n hw.ncpu)" ccx_${CCX_VERSION}
  cp "ccx_${CCX_VERSION}" "$WORK/ccx_${CCX_VERSION}"
)
echo "できました: $WORK/ccx_${CCX_VERSION}"
