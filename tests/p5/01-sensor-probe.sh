#!/usr/bin/env bash
# P5 (laporan bagian 3): mengkatalogkan perilaku menyimpang Sensor Pantai dan cara menemukannya.
#   DURATION_S=300 ./tests/p5/01-sensor-probe.sh
# Hanya GET ke sensor dari dalam pod aggregator. Hasil JSON lengkap disimpan di folder hasil; ringkasan
# penyimpangan dicetak sebagai tabel yang bisa langsung dipindahkan ke laporan.
# Jalankan pada profil latihan (practice) untuk kalibrasi, dan ulangi lewat Tester Agent saat game day.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
need kubectl python3
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DURATION_S="${DURATION_S:-120}"
POD=$(k get pods -l app=aggregator --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
[ -z "$POD" ] && { echo "tidak ada pod aggregator Running" >&2; exit 2; }
[ -z "$(k exec "$POD" -- sh -c 'echo $PANTAI_AUTH_TOKEN' 2>/dev/null)" ] && { echo "PANTAI_AUTH_TOKEN kosong di pod aggregator (restart aggregator setelah membuat Secret pantai-token)" >&2; exit 2; }

log "Memeriksa sensor selama ${DURATION_S}s dari pod $POD"
k exec -i "$POD" -- env DURATION_S="$DURATION_S" node - < "$HERE/sensor-probe.js" > "$RESULTS_DIR/sensor-probe.json" 2> "$RESULTS_DIR/sensor-probe.err"
python3 - "$RESULTS_DIR/sensor-probe.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("keluaran probe tidak valid:", e); sys.exit(1)
if "error" in d:
    print("probe gagal:", d["error"]); sys.exit(1)
live, bl = d["live"], d["backlog"]
print(f"\nRingkasan ({d['durasi_s']}s, {d['total_observasi_diperiksa']} observasi, {d['observasi_kritis']} kritis)")
print(f"  otentikasi: tanpa token={d['otentikasi']['tanpa_token']} token salah={d['otentikasi']['token_salah']}")
print(f"  backlog: {bl['pages']} halaman, berhenti: {bl['berhenti']}")
print(f"  live: {live['polls']} poll, gagal={live['gagal']} (beruntun maks {live['gagal_beruntun_maks']}), status={live['status']}")
print(f"  latensi ms p50/p95/p99/maks = {live['latensi_ms']['p50']}/{live['latensi_ms']['p95']}/{live['latensi_ms']['p99']}/{live['latensi_ms']['maks']}")
print(f"  item per poll: {live['item_per_poll']}")
print(f"  lag generated_at vs observasi terbaru (s): {live['lag_generated_vs_observed_s']}")
print(f"  quality: {d['quality']}")
print(f"  sebaran nilai: {d['sebaran_nilai']}")
print("\nPenyimpangan yang ditemukan (bahan laporan bagian 3):")
if not d["penyimpangan"]:
    print("  (tidak ada)")
for p in d["penyimpangan"]:
    print(f"  - {p['id']}: {p['jumlah']}x   contoh: {str(p['contoh'])[:110]}")
PY
info "JSON lengkap: $RESULTS_DIR/sensor-probe.json"
echo
echo "Cara menangani tiap penyimpangan: lihat validator (aggregator/src/validators/pantaiValidator.js), breaker, dan"
echo "deteksi data basi di aggregator/src/ingest/pollPantai.js; cocokkan id penyimpangan di atas dengan kolom 'Cara menangani' di laporan."
