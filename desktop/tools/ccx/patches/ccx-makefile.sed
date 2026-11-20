# ccx_2.23/src/Makefile の差し替え（sed -E -f で適用）。build-*.sh が @SPOOLES@ などを置き換えてから使う。
# -w: 古いコードの警告でログが埋まり、本当のエラーが見えなくなるので警告は出さない。
# -Wno-error=return-mismatch: void 関数での return NULL;（readnewmesh.c）など、gcc 14 以降でエラーになる古い書き方を許す
# ARCH は Linux にする（ccx.h は ARCH が Linux などの既知の名前のときだけ FORTRAN マクロ（関数名の末尾に _）を定義する。gfortran は macOS・Windows でも同じ規則）
# 公式の Makefile は ../../../SPOOLES.2.2 と ARPACK を相対パスで決め打ちにしている。
s|^CFLAGS *=.*|CFLAGS = -w -O2 -I@SPOOLES@ -DARCH="@ARCH@" -DSPOOLES -DARPACK -DMATRIXSTORAGE -DNETWORKOUT -DUSE_MT=1 -Wno-error=int-conversion -Wno-error=implicit-function-declaration -Wno-error=incompatible-pointer-types -Wno-error=implicit-int -Wno-error=return-mismatch|
# -cpp: .f は既定では前処理されず、move.f の「#ifdef（Intel Fortran 用の use ifport）」が効かずに止まるため
s|^FFLAGS *=.*|FFLAGS = -w -O2 -cpp -fopenmp -fallow-argument-mismatch|
s|^CC *=.*|CC = @CC@|
s|^FC *=.*|FC = @FC@|
