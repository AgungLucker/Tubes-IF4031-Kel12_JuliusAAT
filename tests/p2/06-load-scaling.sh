#!/usr/bin/env bash
# P2 kriteria 6: load testing berkelanjutan (>= 10.000 VU, >= 120 detik) sambil mengubah jumlah instance
# aggregator 3 -> 5 -> 2. Error di luar penolakan terkendali (429) harus < 1%, dan kriteria 2 tetap terpenuhi.
#
#   ./tests/p2/06-load-scaling.sh
#   VUS=10000 DURATION=180s UP=50 DOWN=110 MODE=direct|client ./tests/p2/06-load-scaling.sh
#   K6_NODE=node-c K6_MEM_REQ=2Gi K6_MEM_LIM=6Gi ./tests/p2/06-load-scaling.sh    # k6 di node ber-RAM besar
#
# UP/DOWN = detik sejak fase "sustained" dimulai. MODE=client memakai JWT lewat client-service (CLIENT=media|lapangan).
# Tidak men-deploy aplikasi; yang diubah sementara: RATE_LIMIT_PER_SEC aggregator (dipulihkan di akhir),
# jumlah replika (dipulihkan ke 3), dan Job/NetworkPolicy k6 (dihapus bila CLEANUP=1).
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/k6-run.sh"
need kubectl python3
VUS="${VUS:-10000}"; DURATION="${DURATION:-180s}"; RAMP="${RAMP:-30}"; UP="${UP:-50}"; DOWN="${DOWN:-110}"
MODE="${MODE:-direct}"; JOB=k6-p2-scaling
dsec="${DURATION%s}"
[ "$dsec" -ge 120 ] || { echo "DURATION harus >= 120s (kriteria)"; exit 2; }
[ "$DOWN" -lt "$dsec" ] || { echo "DOWN ($DOWN) harus lebih kecil dari DURATION ($dsec)"; exit 2; }

log "Persiapan: replika 3, rate limit aggregator dinaikkan agar yang diukur kapasitas, bukan pembatas per-IP"
register_restore "kubectl -n $NS scale deploy/aggregator --replicas=3"
set_env_temp aggregator RATE_LIMIT_PER_SEC=1000000
k scale deploy/aggregator --replicas=3 >/dev/null; k rollout status deploy/aggregator --timeout=300s >/dev/null
k6_netpol

env_args=("MODE=$MODE" "VUS=$VUS" "DURATION=$DURATION" "RAMP=${RAMP}s" "THINK_S=${THINK_S:-5}")
if [ "$MODE" = "client" ]; then
  read -r cid csec <<<"$(client_creds "${CLIENT:-media}")"
  env_args+=("CLIENT_ID=$cid" "CLIENT_SECRET=$csec")
fi
log "Menjalankan k6 ($VUS VU, ramp ${RAMP}s + ${DURATION} sustained, mode $MODE)"
k6_start "$JOB" aggregator-load.js "${env_args[@]}"
k6_wait_running "$JOB" 900 || { bad "pod k6 tidak sempat Running (image k6 lambat ditarik, atau memori node kurang)"; finish; exit 1; }

TL="$RESULTS_DIR/timeline.txt"; : > "$TL"
snap() { echo "$(date +%T) $1" | tee -a "$TL"; k get pods -l app=aggregator -o wide --no-headers | awk '{print "   "$1,$2,$3,$7}' | tee -a "$TL"; }
sleep "$RAMP"; T0=$(now_s)
snap "mulai fase sustained dengan 3 replika"
while [ $(( $(now_s) - T0 )) -lt "$UP" ]; do sleep 2; done
k scale deploy/aggregator --replicas=5 >/dev/null; snap "scale 3 -> 5"
while [ $(( $(now_s) - T0 )) -lt "$DOWN" ]; do sleep 2; done
k scale deploy/aggregator --replicas=2 >/dev/null; snap "scale 5 -> 2"

state=$(k6_wait_done "$JOB" $((dsec + 600)))
sum=$(k6_summary "$JOB"); echo "$sum" > "$RESULTS_DIR/k6_summary.json"; k logs "job/$JOB" > "$RESULTS_DIR/k6.log" 2>&1
info "ringkasan k6: $sum"
if [ -n "$sum" ]; then
  rate=$(json_get "$sum" "d['real_error_rate']"); vmax=$(json_get "$sum" "d['vus_max']"); r429=$(json_get "$sum" "d['rejected_429']")
  python3 -c "import sys; sys.exit(0 if float('$rate') < 0.01 else 1)" && ok "error di luar penolakan terkendali: $(python3 -c "print(round(float('$rate')*100,3))")% (< 1%)" || bad "error rate $rate >= 1%"
  [ "$vmax" = "None" ] && vmax=0
  [ "${vmax%.*}" -ge "$VUS" ] && ok "VU tercapai: $vmax" || bad "VU maksimum hanya $vmax dari $VUS (memori node atau batas k6)"
  info "penolakan terkendali (429): $r429"
else bad "ringkasan k6 tidak ditemukan (Job $state)"; fi
[ "$state" = "complete" ] && ok "ambang k6 terpenuhi" || bad "Job k6: $state (ambang k6 gagal atau Job error)"

log "Kriteria 2 tetap terpenuhi setelah scaling"
SINCE="$(( (dsec + RAMP + 120) / 60 + 2 ))m" bash "$HERE/02-exactly-once.sh" 2>&1 | tee "$RESULTS_DIR/exactly_once.txt" | grep -E "LULUS|GAGAL" | sed 's/^/   | /'
grep -q "GAGAL" "$RESULTS_DIR/exactly_once.txt" && bad "kriteria 2 dilanggar selama scaling" || ok "tidak ada duplikat dan satu holder per sumber selama scaling"
[ -n "${CLEANUP:-}" ] && { k delete job "$JOB" --ignore-not-found >/dev/null; k6_cleanup; }
finish
