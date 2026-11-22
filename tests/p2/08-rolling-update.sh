#!/usr/bin/env bash
# P2 kriteria 8: mengganti versi Aggregator selama load testing berlangsung tanpa permintaan yang gagal.
#   ./tests/p2/08-rolling-update.sh                       # rolling restart (template pod berubah, tag sama)
#   NEW_TAG=abc1234 ./tests/p2/08-rolling-update.sh       # ganti image ke ghcr.io/julius123123/bnpb-aggregator:$NEW_TAG
# Tidak ada permintaan gagal yang diizinkan (real_errors = 0); penolakan 429 terkendali tidak dihitung.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/k6-run.sh"
need kubectl python3
VUS="${VUS:-2000}"; DURATION="${DURATION:-150s}"; TRIGGER="${TRIGGER:-40}"; JOB=k6-p2-rolling
dsec="${DURATION%s}"

register_restore "kubectl -n $NS scale deploy/aggregator --replicas=3"
set_env_temp aggregator RATE_LIMIT_PER_SEC=1000000
k scale deploy/aggregator --replicas=3 >/dev/null; k rollout status deploy/aggregator --timeout=300s >/dev/null
k6_netpol

img0=$(k get deploy aggregator -o jsonpath='{.spec.template.spec.containers[0].image}')
info "image sebelum: $img0"
log "Menjalankan k6 ($VUS VU, ${DURATION}); rolling update dipicu ${TRIGGER}s setelah beban penuh"
k6_start "$JOB" aggregator-load.js "MODE=direct" "VUS=$VUS" "DURATION=$DURATION" "RAMP=20s" "MAX_ERR_RATE=0" "THINK_S=${THINK_S:-3}"
k6_wait_running "$JOB" 900 || { bad "pod k6 tidak Running"; finish; exit 1; }
sleep 20; T0=$(now_s)
while [ $(( $(now_s) - T0 )) -lt "$TRIGGER" ]; do sleep 2; done

log "Memicu penggantian versi"
if [ -n "${NEW_TAG:-}" ]; then
  new="${img0%:*}:$NEW_TAG"; k set image deploy/aggregator "aggregator=$new" >/dev/null
  info "image baru: $new"
else
  k rollout restart deploy/aggregator >/dev/null
fi
k get pods -l app=aggregator -o wide --no-headers | awk '{print "   "$1,$2,$3,$7}'
k rollout status deploy/aggregator --timeout=300s | sed 's/^/   | /'
ready=$(k get pods -l app=aggregator -o jsonpath='{range .items[*]}{.status.containerStatuses[0].ready}{"\n"}{end}' | grep -c true)
[ "$ready" -ge 3 ] && ok "rollout selesai dengan $ready instance Ready" || bad "hanya $ready instance Ready setelah rollout"

state=$(k6_wait_done "$JOB" $((dsec + 300)))
sum=$(k6_summary "$JOB"); echo "$sum" > "$RESULTS_DIR/k6_summary.json"; k logs "job/$JOB" > "$RESULTS_DIR/k6.log" 2>&1
info "ringkasan k6: $sum"
if [ -n "$sum" ]; then
  errs=$(json_get "$sum" "d['real_errors']")
  [ "${errs%.*}" -eq 0 ] && ok "0 permintaan gagal selama penggantian versi" || bad "$errs permintaan gagal selama penggantian versi"
  info "penolakan terkendali (429): $(json_get "$sum" "d['rejected_429']")"
else bad "ringkasan k6 tidak ditemukan"; fi
[ "$state" = "complete" ] && ok "ambang k6 terpenuhi" || bad "Job k6: $state"
[ -n "${CLEANUP:-}" ] && { k delete job "$JOB" --ignore-not-found >/dev/null; k6_cleanup; }
finish
