#!/usr/bin/env bash
# P2 kriteria 7: throughput dengan 3 instance >= 2,0x throughput dengan 1 instance.
#   ./tests/p2/07-throughput.sh                 # VUS=300 DURATION=60s RATIO_MIN=2.0
# Beban loop tertutup (tanpa jeda) pada Service aggregator, dijalankan sekali untuk 1 replika dan sekali untuk
# 3 replika. Hasil bergantung pada kapasitas node; catat spesifikasi node di laporan.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/k6-run.sh"
need kubectl python3
VUS="${VUS:-300}"; DURATION="${DURATION:-60s}"; RATIO_MIN="${RATIO_MIN:-2.0}"

register_restore "kubectl -n $NS scale deploy/aggregator --replicas=3"
set_env_temp aggregator RATE_LIMIT_PER_SEC=1000000
k6_netpol

run_case() {  # run_case <replika>  -> mencetak rps_ok
  local n="$1" job="k6-p2-throughput-$1"
  k scale deploy/aggregator --replicas="$n" >/dev/null; k rollout status deploy/aggregator --timeout=300s >/dev/null
  sleep 15   # beri waktu Service/EndpointSlice stabil
  k6_start "$job" throughput.js "VUS=$VUS" "DURATION=$DURATION"
  k6_wait_running "$job" 900 >/dev/null || { echo 0; return; }
  k6_wait_done "$job" 900 >/dev/null
  local s; s=$(k6_summary "$job"); [ -z "$s" ] && s='{}'
  echo "$s" > "$RESULTS_DIR/summary_${n}_replika.json"
  json_get "$s" "d.get('rps_ok', 0)" 2>/dev/null || echo 0
}

log "Satu instance"; r1=$(run_case 1); info "1 instance: $r1 permintaan sukses/detik"
log "Tiga instance"; r3=$(run_case 3); info "3 instance: $r3 permintaan sukses/detik"
ratio=$(python3 -c "r1=float('$r1' or 0); r3=float('$r3' or 0); print(round(r3/r1, 2) if r1 else 0)")
info "rasio 3 instance / 1 instance = ${ratio}x (batas ${RATIO_MIN}x)"
echo "1 replika: $r1 rps | 3 replika: $r3 rps | rasio: $ratio" > "$RESULTS_DIR/ringkasan.txt"
python3 -c "import sys; sys.exit(0 if float('$ratio') >= float('$RATIO_MIN') else 1)" && ok "throughput 3 instance = ${ratio}x throughput 1 instance (>= ${RATIO_MIN}x)" || bad "rasio ${ratio}x di bawah ${RATIO_MIN}x"
[ -n "${CLEANUP:-}" ] && k6_cleanup
finish
