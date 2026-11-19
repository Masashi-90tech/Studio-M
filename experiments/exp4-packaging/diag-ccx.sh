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
[ -x "$CCX" ] || fail "同梱の ccx がありません（${CCX}）。先に ./run-all.sh を実行してください"
THREADS_LIST="${THREADS_LIST:-1 2 4}"   # 例: THREADS_LIST="1 4" ./diag-ccx.sh <フォルダー> 30
SUMMARY="$(mktemp "${TMPDIR:-/tmp}/ccxdiag-summary.XXXXXX")"
for t in $THREADS_LIST; do
  for i in $(seq 1 "$N"); do
    D="$(mktemp -d "${TMPDIR:-/tmp}/ccxdiag.XXXXXX")"
    cp "$SRC"/job.inp "$SRC"/mesh.inp "$D"/ 2>/dev/null || cp "$SRC"/job.inp "$D"/
    if is_mac; then export DYLD_FALLBACK_LIBRARY_PATH="$LIB"; else export LD_LIBRARY_PATH="$LIB"; fi
    t0=$(now_ms)
    # EQ_THREADS を指定すると、連立方程式を解く部分（SPOOLES）のスレッド数だけを別にする（例: EQ_THREADS=1 THREADS_LIST=4）
    (cd "$D" && env OMP_NUM_THREADS="$t" CCX_NPROC_RESULTS=1 CCX_NPROC_EQUATION_SOLVER="${EQ_THREADS:-$t}" "$CCX" -i job >ccx.log 2>&1) || { echo "threads=$t #$i: ccx が失敗"; tail -n 3 "$D/ccx.log"; continue; }
    out="$(PYTHONNOUSERSITE=1 PYTHONPATH="$PAYLOAD/workers/shape/site-packages" "$PY" "$PAYLOAD/workers/common/ccx_tool.py" post --dir "$D" --job job 2>&1 | tail -n 1)"
    if [ "$N" -le 5 ]; then echo "threads=$t #$i: $out" | cut -c1-230; fi
    echo "$t $(( $(now_ms) - t0 )) $(printf '%s' "$out" | python3 -c 'import sys,json
try:
  j=json.loads(sys.stdin.read()); print("%.1f"%j["reaction_N"])
except Exception: print("読めない")')" >>"$SUMMARY"
    rm -rf "$D"
  done
done

echo ""
echo "=== まとめ（スレッド数ごとの、反力 [N] の値と回数。正しい値は約 51434 N。2 種類以上あれば実行ごとに変わっている）==="
awk '{k=$1" "$3; n[k]++; ms[k]+=$2} END{for(k in n){split(k,a," "); printf "  threads=%s  反力=%s N  %d 回（平均 %.2f 秒）\n", a[1], a[2], n[k], ms[k]/n[k]/1000}}' "$SUMMARY" | sort
rm -f "$SUMMARY"
