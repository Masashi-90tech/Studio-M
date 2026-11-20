#!/usr/bin/env bash
# 未検証。最初の Actions の実行で直す（MSYS2 の mingw-w64 で書いただけで、実機でも Actions でも動かしていない）。
# Windows x64 で CalculiX（ccx）を公式ソースからビルドする（GitHub の windows-latest ＋ MSYS2 MINGW64 向け）。
#   使い方（MSYS2 MINGW64 の bash で）: build-windows.sh <作業フォルダー>   → <作業フォルダー>/ccx_<版>.exe ができる
# 直すときの目安: Makefile の差し替え（patches/ccx-makefile.sed）、SPOOLES の Make.inc、-fallow-argument-mismatch、
#                 リンクの順番（-larpack -lopenblas）。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/versions.env"
. "$HERE/fetch.sh"

WORK="${1:?使い方: build-windows.sh <作業フォルダー>}"
mkdir -p "$WORK"; WORK="$(cd "$WORK" && pwd -P)"

pacman -S --needed --noconfirm make tar bzip2 curl \
  mingw-w64-x86_64-gcc mingw-w64-x86_64-gcc-fortran mingw-w64-x86_64-openblas mingw-w64-x86_64-arpack
CC=gcc; FC=gfortran

fetch_verified "$WORK/ccx.tar.bz2" "$CCX_SHA256" "$CCX_URL" "$CCX_URL_FALLBACK"
fetch_verified "$WORK/spooles.tgz" "$SPOOLES_SHA256" "$SPOOLES_URL"
rm -rf "$WORK/src"; mkdir -p "$WORK/src/SPOOLES.2.2"
tar -xjf "$WORK/ccx.tar.bz2" -C "$WORK/src"
tar -xzf "$WORK/spooles.tgz" -C "$WORK/src/SPOOLES.2.2"
CCX_SRC="$(ls -d "$WORK"/src/*/ccx_*/src | head -1)"
[ -d "$CCX_SRC" ] || { echo "エラー: ccx のソースの場所が分かりません（${WORK}/src を確認）" >&2; exit 1; }

(
  cd "$WORK/src/SPOOLES.2.2"
  sed -i -E "s|^ *CC *=.*|  CC = $CC|; s|^ *OPTLEVEL *=.*|  OPTLEVEL = -O2 -Wno-error=int-conversion -Wno-error=implicit-function-declaration -Wno-error=incompatible-pointer-types -Wno-error=implicit-int|" Make.inc
  # SPOOLES 2.2 は古い C で、新しい gcc（14 以降）は IVinit(n, NULL) などの暗黙変換をエラーにする。
  # NULL は整数としては 0 なので、意味を変えずに 0 に書き換え、残りの同種のエラーも出さないようにする
  sed -i -E "s|IVinit\(([A-Za-z_]+), NULL\)|IVinit(\1, 0)|g" ETree/src/transform.c
  make lib
  (cd MT/src && make -f makeGlobalLib)
)

(
  cd "$CCX_SRC"
  sed -E \
    -e "s|@SPOOLES@|$WORK/src/SPOOLES.2.2|g" -e "s|@ARCH@|Linux|g" -e "s|@CC@|$CC|g" -e "s|@FC@|$FC|g" \
    "$HERE/patches/ccx-makefile.sed" > "$WORK/ccx-makefile.sed"
  sed -i -E -f "$WORK/ccx-makefile.sed" Makefile
  # ccx_2.23.c の冒頭の _set_output_format(_TWO_DIGIT_EXPONENT);（指数を 2 桁にする設定）は、mingw の stdio.h の宣言と衝突する。結果の値には影響しないので消す
  sed -i -E '/^[[:space:]]*_set_output_format\(_TWO_DIGIT_EXPONENT\);/d' ccx_*.c
  # 公式の Makefile の LIBS は「LIBS = \」から続く複数行で、さらに make の依存ファイルとしても使われる。
  # 1 行だけ置き換えると残りの行が壊れて「missing separator」になるので、続きの行ごと置き換え、依存ファイルからは外す
  LIBS_LINE="LIBS = $WORK/src/SPOOLES.2.2/spooles.a -larpack -lopenblas -lpthread -lm" perl -0pi -e 's/^LIBS[ \t]*=(?:[^\n]*\\\n)*[^\n]*\n/$ENV{LIBS_LINE}\n/m' Makefile
  perl -0pi -e 's/(\$\(OCCXMAIN\)\s+ccx_[0-9.]+\.a)\s+\$\(LIBS\)/$1/' Makefile
  make -j"$(nproc)" ccx_${CCX_VERSION}
  cp "ccx_${CCX_VERSION}.exe" "$WORK/ccx_${CCX_VERSION}.exe" 2>/dev/null || cp "ccx_${CCX_VERSION}" "$WORK/ccx_${CCX_VERSION}.exe"
)
echo "できました: $WORK/ccx_${CCX_VERSION}.exe"
