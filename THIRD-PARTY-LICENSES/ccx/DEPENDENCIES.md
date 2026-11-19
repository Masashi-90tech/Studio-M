# 同梱している ccx が使うソフトのライセンス

ccx（GPL-2.0、全文は GPL-2.0.txt）が実行時に使う共有ライブラリ、または静的にリンクしているもの。
ライセンスは採用時に各配布元の LICENSE で確かめ直すこと（確認日 2026-11-19 時点の記憶による表記を含む）。

| 名前 | 使い方 | ライセンス | 出典 |
|---|---|---|---|
| SPOOLES 2.2 | 連立方程式の解法（静的リンク） | 公開ドメインに近い独自の許諾（netlib の配布。要確認） | http://www.netlib.org/linalg/spooles/ |
| ARPACK（arpack-ng） | 固有値の解法（共有ライブラリ） | BSD-3-Clause | https://github.com/opencollab/arpack-ng |
| OpenBLAS | 線形代数（共有ライブラリ） | BSD-3-Clause | https://github.com/OpenMathLib/OpenBLAS |
| libgfortran / libquadmath / libgomp / libgcc_s | GCC のランタイム | GPL-3.0 with GCC Runtime Library Exception（libquadmath は LGPL-2.1+） | https://gcc.gnu.org/ |
| MSYS2 / mingw-w64 のランタイム（Windows のみ） | libwinpthread など | MIT / BSD 系（要確認） | https://www.msys2.org/ |
