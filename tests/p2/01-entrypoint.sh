#!/usr/bin/env bash
# P2 kriteria 1: aggregator berjalan >= 3 instance di node berbeda, di belakang satu titik masuk yang
# berhenti mengarahkan permintaan ke instance yang tidak sehat.
#   ./tests/p2/01-entrypoint.sh                 # MIN_NODES=2 FREEZE_S=40 RPS=15
# Satu instance dibekukan (SIGSTOP dari host node) sehingga readiness probe gagal; skrip mengukur berapa
# lama Service berhenti mengarahkan ke instance itu, dan memastikan permintaan klien tetap berhasil.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
need kubectl python3
MIN_NODES="${MIN_NODES:-2}"; FREEZE_S="${FREEZE_S:-40}"; RPS="${RPS:-15}"; DETECT_MAX="${DETECT_MAX:-20}"

log "1) Sebaran instance aggregator"
rows=$(aggregator_pods); echo "$rows" | sed 's/^/     /'
npods=$(echo "$rows" | grep -c .); nnodes=$(echo "$rows" | awk '{print $2}' | sort -u | wc -l | tr -d ' ')
ready=$(k get pods -l app=aggregator -o jsonpath='{range .items[*]}{.status.containerStatuses[0].ready}{"\n"}{end}' | grep -c true)
[ "$npods" -ge 3 ] && ok "$npods instance Running" || bad "hanya $npods instance Running (butuh >= 3)"
[ "$ready" -ge 3 ] && ok "$ready instance Ready" || bad "hanya $ready instance Ready"
[ "$nnodes" -ge "$MIN_NODES" ] && ok "tersebar di $nnodes node berbeda" || bad "hanya di $nnodes node (minimal $MIN_NODES)"
mx=$(echo "$rows" | awk '{print $2}' | sort | uniq -c | sort -rn | awk 'NR==1{print $1}')
info "jumlah instance terbanyak pada satu node: $mx"

log "2) Titik masuk: Service hanya berisi pod yang Ready"
ep=$(k get endpoints aggregator -o jsonpath='{.subsets[*].addresses[*].ip}' | wc -w | tr -d ' ')
[ "$ep" -eq "$ready" ] && ok "Endpoints aggregator = $ep alamat (sama dengan jumlah pod Ready)" || bad "Endpoints=$ep, pod Ready=$ready"

log "3) Satu instance dibuat tidak sehat selama ${FREEZE_S}s dengan beban klien berjalan"
victim=$(echo "$rows" | awk 'NR==1{print $1}'); vnode=$(pod_node "$victim"); vip=$(k get pod "$victim" -o jsonpath='{.status.podIP}')
info "korban=$victim node=$vnode ip=$vip"
probe_client lapangan entry "$RPS" $((FREEZE_S + 25)) "/data?hazard_type=SEISMIC" > "$RESULTS_DIR/probe.json" 2>"$RESULTS_DIR/probe.err" & PROBE=$!
sleep 4

unfreeze() { node_sh "$vnode" "$(host_pid_snippet "$victim") kill -CONT \$PID_C 2>/dev/null" >/dev/null 2>&1; }
register_restore unfreeze
node_sh "$vnode" "$(host_pid_snippet "$victim") kill -STOP \$PID_C; echo STOP" | sed 's/^/   | /'
T0=$(now_s); DETECT=""
while [ $(( $(now_s) - T0 )) -lt 60 ]; do
  if ! k get endpoints aggregator -o jsonpath='{.subsets[*].addresses[*].ip}' | tr ' ' '\n' | grep -qx "$vip"; then DETECT=$(( $(now_s) - T0 )); break; fi
  sleep 1
done
if [ -n "$DETECT" ]; then info "Service berhenti mengarahkan ke instance sakit setelah ${DETECT}s"
  [ "$DETECT" -le "$DETECT_MAX" ] && ok "instance tidak sehat dikeluarkan dari Endpoints dalam ${DETECT}s (<= ${DETECT_MAX}s)" || bad "pengeluaran dari Endpoints ${DETECT}s > ${DETECT_MAX}s"
else bad "instance sakit tetap ada di Endpoints setelah 60s"; DETECT=60; fi

while [ $(( $(now_s) - T0 )) -lt "$FREEZE_S" ]; do sleep 2; done
unfreeze
T1=$(now_s); BACK=""
while [ $(( $(now_s) - T1 )) -lt 120 ]; do
  k get endpoints aggregator -o jsonpath='{.subsets[*].addresses[*].ip}' | tr ' ' '\n' | grep -qx "$vip" && { BACK=$(( $(now_s) - T1 )); break; }
  sleep 2
done
[ -n "$BACK" ] && ok "instance kembali ke Endpoints ${BACK}s setelah pulih (tanpa intervensi)" || bad "instance tidak kembali ke Endpoints dalam 120s"

wait "$PROBE" 2>/dev/null
out=$(cat "$RESULTS_DIR/probe.json")
python3 - "$RESULTS_DIR/probe.json" "$DETECT" <<'PY' && ok "tidak ada kegagalan klien setelah instance sakit dikeluarkan" || bad "masih ada kegagalan klien setelah instance sakit dikeluarkan"
import json, sys
d = json.load(open(sys.argv[1])); detect = int(sys.argv[2])
tl = d["timeline"]; total = d["sent"]
errs = [x for x in tl if x["err"]]
after = [x for x in errs if x["t"] > 4 + detect + 8]
print(f"   total={total} status={d['statuses']} error_jaringan={d['network_errors']} detik_dengan_error={[x['t'] for x in errs]}")
sys.exit(1 if after else 0)
PY
finish
