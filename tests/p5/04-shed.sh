#!/usr/bin/env bash
# P5 kriteria 5: ketika beban melebihi kapasitas, permintaan Tim Lapangan tetap dilayani sementara permintaan
# Media ditolak secara terkendali (429 + Retry-After).
#   ./tests/p5/04-shed.sh                        # TUNE_MAX=8 MEDIA_RPS=300 LAP_RPS=15 SECS=40
# Agar overload tercapai tanpa ribuan permintaan per detik, anggaran konkurensi client-service diturunkan
# sementara (CLIENT_MAX_INFLIGHT=TUNE_MAX, CLIENT_MEDIA_SHARE=0.5) dan dipulihkan otomatis di akhir.
# Set NO_TUNE=1 bila beban nyata cukup besar untuk menjenuhkan anggaran bawaan (200, Media 60%).
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
need kubectl python3
TUNE_MAX="${TUNE_MAX:-8}"; MEDIA_RPS="${MEDIA_RPS:-300}"; LAP_RPS="${LAP_RPS:-15}"; SECS="${SECS:-40}"; LAP_P95_MS="${LAP_P95_MS:-1500}"

if [ -z "${NO_TUNE:-}" ]; then
  log "Menurunkan anggaran konkurensi client-service sementara (maks $TUNE_MAX, Media 50%)"
  set_env_temp client-service CLIENT_MAX_INFLIGHT="$TUNE_MAX" CLIENT_MEDIA_SHARE=0.5
fi
load() { k exec deploy/client-service -- node -e "fetch('http://localhost:8080/health/load').then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))" 2>/dev/null; }
info "anggaran sebelum uji: $(load)"

log "Beban bersamaan: Media ${MEDIA_RPS} rps dan Tim Lapangan ${LAP_RPS} rps selama ${SECS}s"
probe_client media media "$MEDIA_RPS" "$SECS" "/data?hazard_type=SEISMIC,/data?hazard_type=VOLCANIC" > "$RESULTS_DIR/media.json" 2>"$RESULTS_DIR/media.err" &
M=$!
probe_client lapangan lapangan "$LAP_RPS" "$SECS" "/data?hazard_type=SEISMIC,/data?hazard_type=VOLCANIC" > "$RESULTS_DIR/lapangan.json" 2>"$RESULTS_DIR/lapangan.err" &
L=$!
wait $M $L
info "anggaran setelah uji: $(load)"

python3 - "$RESULTS_DIR/media.json" "$RESULTS_DIR/lapangan.json" "$LAP_P95_MS" <<'PY'
import json, sys
m, l, lim = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), float(sys.argv[3])
for d in (m, l):
    if "fatal" in d:
        print("PROBE_ERROR", d["fatal"]); sys.exit(2)
def n(d, s): return d["statuses"].get(s, 0)
print(f"Media    : terkirim={m['sent']} 200={n(m,'200')} 429={n(m,'429')} lainnya={m['non_ok_non_shed']} retry-after pada 429={m['retry_after_seen']} p95={m['latency_ms']['p95']}ms")
print(f"Lapangan : terkirim={l['sent']} 200={n(l,'200')} 429={n(l,'429')} lainnya={l['non_ok_non_shed']} p95={l['latency_ms']['p95']}ms")
res = {
  "Media ditolak secara terkendali (429 > 0)": n(m, "429") > 0,
  "setiap 429 membawa Retry-After": m["retry_after_seen"] >= n(m, "429") and n(m, "429") > 0,
  "Media tidak mengalami error lain (hanya 200 atau 429)": m["non_ok_non_shed"] == 0,
  "Tim Lapangan tidak ditolak sama sekali (0 x 429)": n(l, "429") == 0,
  "Tim Lapangan tidak mengalami error": l["non_ok_non_shed"] == 0,
  f"latensi p95 Tim Lapangan <= {lim:.0f}ms di bawah beban": (l["latency_ms"]["p95"] or 1e9) <= lim,
}
fail = 0
for k, v in res.items():
    print(f"  [{'LULUS' if v else 'GAGAL'}] {k}"); fail += 0 if v else 1
sys.exit(1 if fail else 0)
PY
rc=$?
[ $rc -eq 0 ] && ok "prioritas ditegakkan: Lapangan dilayani, Media ditolak terkendali" || bad "perilaku prioritas tidak sesuai (lihat butir di atas)"
sh_h=$(num "$(prom 'sum(increase(client_service_shed_total{priority="high"}[2m]))')"); sh_l=$(num "$(prom 'sum(increase(client_service_shed_total{priority="low"}[2m]))')")
info "metrik client_service_shed_total (2 menit terakhir): high=$sh_h low=$sh_l"
finish
