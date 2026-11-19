#!/usr/bin/env bash
# CalculiX の結果が実行ごとにずれる問題の切り分け。
#   ./diag-ccx.sh <作業フォルダー（job.inp と mesh.inp が入っている run1 など）> [回数]
# 同じ入力で ccx だけを、スレッド数（1・2・4）を変えて繰り返し実行し、反力の合計と応力集中係数を並べる。
# 入力が毎回同じなのに値が変わるなら、ccx の並列実行（またはライブラリ）が原因。
set -euo pipefail
KIT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
. "$KIT_DIR/lib/common.sh"
SRC="${1:-}"; N="${2:-3}"
[ -n "$SRC" ] && [ -f "$SRC/job.inp" ] || fail "使い方: ./diag-ccx.sh <job.inp のあるフォルダー> [回数]（例: build/work-n1/run1）"
SRC="$(cd "$SRC" && pwd -P)"
PAYLOAD="$BUILD_DIR/payload"
CCX="$PAYLOAD/engines/calculix/bin/ccx"; LIB="$PAYLOAD/engines/calculix/lib"
PY="$PAYLOAD/runtime/python/bin/python3"
[ -x "$CCX" ] || fail "同梱の ccx がありません（$CCX）。先に ./run-all.sh を実行してください"
for t in 1 2 4; do
  for i in $(seq 1 "$N"); do
    D="$(mktemp -d "${TMPDIR:-/tmp}/ccxdiag.XXXXXX")"
    cp "$SRC"/job.inp "$SRC"/mesh.inp "$D"/ 2>/dev/null || cp "$SRC"/job.inp "$D"/
    if is_mac; then export DYLD_FALLBACK_LIBRARY_PATH="$LIB"; else export LD_LIBRARY_PATH="$LIB"; fi
    (cd "$D" && OMP_NUM_THREADS="$t" CCX_NPROC_RESULTS=1 "$CCX" -i job >ccx.log 2>&1) || { echo "threads=$t #$i: ccx が失敗"; tail -n 3 "$D/ccx.log"; continue; }
    out="$(PYTHONNOUSERSITE=1 PYTHONPATH="$PAYLOAD/workers/shape/site-packages" "$PY" "$PAYLOAD/workers/common/ccx_tool.py" post --dir "$D" --job job 2>&1 | tail -n 1)"
    echo "threads=$t #$i: $out" | cut -c1-230
    rm -rf "$D"
  done
done
