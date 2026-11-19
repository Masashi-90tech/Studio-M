# ccx_2.23/src/Makefile の差し替え（sed -E -f で適用）。build-*.sh が @SPOOLES@ などを置き換えてから使う。
# 公式の Makefile は ../../../SPOOLES.2.2 と ARPACK を相対パスで決め打ちにしている。
s|^CFLAGS *=.*|CFLAGS = -Wall -O2 -I@SPOOLES@ -DARCH="@ARCH@" -DSPOOLES -DARPACK -DMATRIXSTORAGE -DNETWORKOUT -DUSE_MT=1|
s|^FFLAGS *=.*|FFLAGS = -Wall -O2 -fopenmp -fallow-argument-mismatch|
s|^CC *=.*|CC = @CC@|
s|^FC *=.*|FC = @FC@|
