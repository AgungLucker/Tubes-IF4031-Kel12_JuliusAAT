#!/usr/bin/env bash
# P5 kriteria 3 dan 4: selama Sensor Pantai tidak sehat,
#   - permintaan sistem ke sensor TIDAK melonjak (circuit breaker + back-off),
#   - permintaan client yang bergantung padanya dijawab CEPAT (data terakhir / status tidak tersedia), bukan menunggu timeout,
#   - layanan untuk sumber lain tetap memenuhi kriteria latensi M1,
#   - ketika sensor pulih, sistem kembali memakainya TANPA intervensi.
#
#   SCENARIO=down ./tests/p5/03-breaker.sh        # sensor mati (koneksi ditolak): replika 0
#   SCENARIO=hang ./tests/p5/03-breaker.sh        # sensor menggantung (paket dibuang): NetworkPolicy allow dihapus
#   DUR=120 MAX_REQ=20 CLIENT_P95_MS=500 OTHER_P95_MS=300 ./tests/p5/03-breaker.sh
# Yang diubah sementara (dipulihkan otomatis di akhir, juga bila skrip dihentikan): replika sensor / NetworkPolicy.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
need kubectl python3
SCENARIO="${SCENARIO:-down}"; DUR="${DUR:-120}"; MAX_REQ="${MAX_REQ:-20}"
CLIENT_P95_MS="${CLIENT_P95_MS:-500}"; OTHER_P95_MS="${OTHER_P95_MS:-300}"; RECOVER_MAX="${RECOVER_MAX:-300}"

log "Kondisi awal: sensor sehat dan breaker tertutup"
k rollout status deploy/sensor-pantai --timeout=120s >/dev/null || { bad "sensor-pantai tidak siap"; finish; exit 1; }
sleep 20
base=$(num "$(prom 'sum(increase(pantai_upstream_requests_total[30s]))')")
state0=$(num "$(prom 'max(pantai_breaker_state)')")
info "permintaan ke sensor per 30s saat sehat: $base | state breaker: $state0 (0=closed)"
[ "$(python3 -c "print(1 if float('$base')>0 else 0)")" = 1 ] && ok "aggregator mem-polling sensor saat sehat" || bad "tidak ada permintaan ke sensor saat sehat (token belum terbaca? lease SENSOR_PANTAI?)"

case "$SCENARIO" in
  down)
    register_restore "kubectl -n $NS scale deploy/sensor-pantai --replicas=1"
    inject() { k scale deploy/sensor-pantai --replicas=0 >/dev/null; }
    heal()   { k scale deploy/sensor-pantai --replicas=1 >/dev/null; } ;;
  hang)
    k get networkpolicy allow-aggregator-to-sensor-pantai -o json 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
for f in ("uid", "resourceVersion", "creationTimestamp", "managedFields", "generation", "selfLink"):
    d["metadata"].pop(f, None)
json.dump(d, sys.stdout)' > "$RESULTS_DIR/netpol-backup.json" || { echo "NetworkPolicy allow-aggregator-to-sensor-pantai tidak ada"; exit 2; }
    register_restore "kubectl -n $NS apply -f $RESULTS_DIR/netpol-backup.json"
    inject() { k delete networkpolicy allow-aggregator-to-sensor-pantai >/dev/null; }
    heal()   { k apply -f "$RESULTS_DIR/netpol-backup.json" >/dev/null; } ;;
  *) echo "SCENARIO harus down atau hang" >&2; exit 2 ;;
esac

log "Gangguan '$SCENARIO' dimulai; pengamatan ${DUR}s dengan beban client berjalan"
inject; T_INJ=$(now_s)
probe_client lapangan coastal 10 "$DUR" "/data?hazard_type=COASTAL" > "$RESULTS_DIR/probe_coastal.json" 2>"$RESULTS_DIR/probe_coastal.err" &
P1=$!
probe_client lapangan other 20 "$DUR" "/data?hazard_type=SEISMIC,/data?hazard_type=VOLCANIC" > "$RESULTS_DIR/probe_other.json" 2>"$RESULTS_DIR/probe_other.err" &
P2=$!
wait $P1 $P2
sleep 12   # beri waktu Prometheus mengambil sampel terakhir

req=$(num "$(prom "sum(increase(pantai_upstream_requests_total[${DUR}s]))")")
skip=$(num "$(prom "sum(increase(pantai_upstream_skipped_total[${DUR}s]))")")
peak=$(num "$(prom "max(max_over_time(pantai_breaker_state[${DUR}s]))")")
info "selama gangguan: permintaan ke sensor=$req (batas $MAX_REQ), panggilan dicegah breaker=$skip, state breaker tertinggi=$peak (2=open)"
python3 -c "import sys; sys.exit(0 if float('$req') <= float('$MAX_REQ') else 1)" && ok "permintaan ke sensor tidak melonjak ($req <= $MAX_REQ dalam ${DUR}s; normalnya ~$(python3 -c "print(round(float('$base')*$DUR/30))"))" || bad "permintaan ke sensor melonjak: $req > $MAX_REQ"
[ "$(python3 -c "print(1 if float('$peak')>=2 else 0)")" = 1 ] && ok "breaker membuka (open)" || bad "breaker tidak pernah open"
python3 -c "import sys; sys.exit(0 if float('$skip') > float('$req') else 1)" && ok "sebagian besar panggilan dicegah tanpa menyentuh jaringan" || bad "panggilan yang dicegah ($skip) tidak lebih banyak dari yang dikirim ($req)"

eval_probe() {  # eval_probe <berkas> <nama> <p95-maks-ms>
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); name, lim = sys.argv[2], float(sys.argv[3])
if "fatal" in d:
    print(f"GAGAL {name}: probe error {d['fatal']}"); sys.exit(1)
p95 = d["latency_ms"]["p95"]; bad = d["non_ok_non_shed"]
print(f"{name}: terkirim={d['sent']} status={d['statuses']} p95={p95}ms maks={d['latency_ms']['max']}ms error={bad} sensor_status={d['sensor_status_seen']}")
sys.exit(0 if (p95 is not None and p95 <= lim and bad == 0) else 1)
PY
}
out=$(eval_probe "$RESULTS_DIR/probe_coastal.json" "client COASTAL (bergantung pada sensor)" "$CLIENT_P95_MS"); rc=$?
echo "   $out"; [ $rc -eq 0 ] && ok "permintaan COASTAL dijawab cepat (p95 <= ${CLIENT_P95_MS}ms), tanpa error" || bad "permintaan COASTAL lambat atau error"
out=$(eval_probe "$RESULTS_DIR/probe_other.json" "client SEISMIC/VOLCANIC (sumber lain)" "$OTHER_P95_MS"); rc=$?
echo "   $out"; [ $rc -eq 0 ] && ok "sumber lain tetap memenuhi latensi (p95 <= ${OTHER_P95_MS}ms)" || bad "sumber lain terdampak oleh sensor yang sakit"
seen=$(json_get "$(cat "$RESULTS_DIR/probe_coastal.json")" "d['sensor_status_seen']")
echo "$seen" | grep -qE "stale|unknown" && ok "respons menandai ketidaktersediaan sensor (source_status: $seen)" || bad "respons tidak menandai status sensor (dilihat: $seen)"

log "Memulihkan sensor; mengukur waktu pulih TANPA intervensi lain"
heal; T_HEAL=$(now_s); rec=""
while [ $(( $(now_s) - T_HEAL )) -lt "$RECOVER_MAX" ]; do
  st=$(num "$(prom 'max(pantai_breaker_state)')"); okr=$(num "$(prom 'sum(rate(pantai_upstream_requests_total{outcome="ok"}[30s]))')")
  if [ "$(python3 -c "print(1 if float('$st')==0 and float('$okr')>0 else 0)")" = 1 ]; then rec=$(( $(now_s) - T_HEAL )); break; fi
  sleep 5
done
[ -n "$rec" ] && ok "breaker tertutup dan polling sukses lagi ${rec}s setelah sensor pulih" || bad "sistem tidak kembali memakai sensor dalam ${RECOVER_MAX}s"
echo "skenario=$SCENARIO permintaan_selama_gangguan=$req dicegah=$skip pulih=${rec:-gagal}s" > "$RESULTS_DIR/ringkasan.txt"
finish
