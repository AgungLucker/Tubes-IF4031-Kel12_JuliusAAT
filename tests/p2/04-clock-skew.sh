#!/usr/bin/env bash
# P2 kriteria 4: sinkronisasi waktu satu node mati dan jamnya bergeser (+45 s, lalu -30 s):
# tidak pernah ada dua instance yang sama-sama berhasil menyimpan hasil pengambilan pada periode yang sama.
#
#   SOURCE=BMKG ./tests/p2/04-clock-skew.sh                 # node = node tempat leader SOURCE berjalan
#   NODE=node-b FWD=45 BACK=30 PHASE_S=40 ./tests/p2/04-clock-skew.sh
#   USE_TESTER=1 ./tests/p2/04-clock-skew.sh                # memakai skenario Tester Agent 'clock-skew' (latihan)
#
# PERINGATAN: jangan menyasar node control plane (node-c); k3s server bisa terganggu. Paksa dengan ALLOW_CP=1.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
need kubectl python3
SOURCE="${SOURCE:-BMKG}"; FWD="${FWD:-45}"; BACK="${BACK:-30}"; PHASE_S="${PHASE_S:-40}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

holder=$(leader_holder "$SOURCE"); [ -z "$holder" ] && { bad "tidak ada leader aktif untuk $SOURCE"; finish; exit 1; }
pod=$(holder_pod "$holder"); NODE="${NODE:-$(pod_node "$pod")}"
cp_nodes=$(k get nodes -l node-role.kubernetes.io/control-plane -o jsonpath='{.items[*].metadata.name}')
if echo " $cp_nodes " | grep -q " $NODE " && [ -z "${ALLOW_CP:-}" ] && [ -z "${USE_TESTER:-}" ]; then
  echo "NODE=$NODE adalah control plane. Pilih node worker (mis. NODE=node-b) atau set ALLOW_CP=1." >&2; exit 2
fi
epoch0=$(ingest_sql "select epoch from ingest_lease where name='$SOURCE'")
fenced0=$(num "$(prom 'sum(aggregator_fenced_writes_total)')")
info "sumber=$SOURCE leader=$holder node=$NODE epoch=$epoch0 | geser jam: +${FWD}s lalu -${BACK}s, tiap fase ${PHASE_S}s"

restore_clock() { node_sh "$NODE" 'timedatectl set-ntp true 2>/dev/null; systemctl restart systemd-timesyncd chrony chronyd 2>/dev/null; date -u' >/dev/null 2>&1; }
register_restore restore_clock

# Pencuplik lease tiap detik (jam database, bukan jam node)
SAMPLES="$RESULTS_DIR/lease_samples.csv"; echo "waktu_s,holder,epoch,aktif" > "$SAMPLES"
( while :; do
    r=$(lease_row "$SOURCE" 2>/dev/null); IFS='|' read -r _ h e live _ <<<"$r"
    echo "$(date +%s),$h,$e,$live" >> "$SAMPLES"; sleep 1
  done ) & SAMPLER=$!
register_restore "kill $SAMPLER"
START_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ -n "${USE_TESTER:-}" ]; then
  log "Menjalankan skenario latihan Tester Agent: clock-skew"
  k exec -n tester-agent daemonset/tester-agent -- /app run practice clock-skew 2>&1 | tail -5 | sed 's/^/   | /'
  sleep $((PHASE_S * 2 + 20))
else
  log "Fase 1: NTP dimatikan, jam $NODE dimajukan ${FWD}s"
  node_sh "$NODE" "timedatectl set-ntp false 2>/dev/null; date -s @\$((\$(date +%s) + $FWD)) >/dev/null; date -u" | sed 's/^/   | /'
  sleep "$PHASE_S"
  log "Fase 2: jam dimundurkan ${BACK}s dari waktu sebenarnya (selisih $((FWD + BACK))s dari fase 1)"
  node_sh "$NODE" "date -s @\$((\$(date +%s) - $((FWD + BACK)))) >/dev/null; date -u" | sed 's/^/   | /'
  sleep "$PHASE_S"
  log "Pemulihan: NTP dinyalakan lagi"
  restore_clock
  sleep 20
fi
kill "$SAMPLER" 2>/dev/null

log "Analisis"
python3 - "$SAMPLES" <<'PY' || bad "epoch tidak monoton pada pencuplikan lease"
import csv, sys
rows = [r for r in csv.DictReader(open(sys.argv[1])) if r["epoch"].isdigit()]
eps = [int(r["epoch"]) for r in rows]
mono = all(b >= a for a, b in zip(eps, eps[1:]))
changes = sum(1 for a, b in zip(eps, eps[1:]) if b != a)
print(f"   cuplikan={len(rows)} perpindahan_epoch={changes} epoch {eps[0] if eps else '?'} -> {eps[-1] if eps else '?'} monoton={mono}")
sys.exit(0 if mono else 1)
PY
epoch1=$(ingest_sql "select epoch from ingest_lease where name='$SOURCE'")
fenced1=$(num "$(prom 'sum(aggregator_fenced_writes_total)')")
info "epoch $epoch0 -> $epoch1; tulisan ditolak fencing: $fenced0 -> $fenced1"

stale=0
for s in 1 2 3; do
  fe=$(shard_sql "$s" "select epoch from ingest_fence where source='$SOURCE'" 2>/dev/null)
  [ -n "$fe" ] && [ "$fe" -gt "$epoch1" ] && { bad "fence shard-$s ($fe) lebih maju dari epoch lease ($epoch1)"; stale=1; }
done
[ $stale -eq 0 ] && ok "epoch fence di semua shard <= epoch lease: tidak ada penulis dengan epoch usang yang menang"

SINCE="$(( (PHASE_S * 2 + 120) / 60 + 2 ))m" bash "$HERE/02-exactly-once.sh" 2>&1 | tee "$RESULTS_DIR/exactly_once.txt" | grep -E "LULUS|GAGAL|INFO" | sed 's/^/   | /'
grep -q "GAGAL" "$RESULTS_DIR/exactly_once.txt" && bad "ada duplikat atau dua holder pada detik yang sama" \
  || ok "tidak ada duplikat dan tidak ada dua holder pada detik yang sama selama pergeseran jam"
finish
