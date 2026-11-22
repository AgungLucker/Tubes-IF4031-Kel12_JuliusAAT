#!/usr/bin/env bash
# P5 kriteria 6, 7, 8 dan bahan post-mortem: latihan game day.
# Menjalankan skenario Tester Agent (mode LATIHAN) satu per satu sementara beban dan kolektor alert kritis
# berjalan, lalu MENGAMATI pemulihan tanpa intervensi apa pun. Skrip ini hanya mengamati dan mencatat;
# ia tidak memperbaiki apa pun selama jendela pemulihan.
#
#   ./tests/p5/06-gameday.sh --yes
#   SCENARIOS="kill-leader kill-store" RECOVERY_S=180 ./tests/p5/06-gameday.sh --yes
#   SCENARIOS=all    -> semua skenario dari '/app list' (bawaan)
# PERINGATAN: skenario seperti wipe-node dan kill-store menghapus pod dan data node. Jalankan hanya pada klaster
# latihan dan setelah mencatat kondisi awal. Skenario UJIAN (terenkripsi) dijalankan asisten saat demo, bukan skrip ini.
#
# Keluaran di folder hasil: timeline.csv (kapan gangguan, kapan sehat lagi), e2e.txt (kritis hilang? latensi),
# slo.md (error budget), probe_*.json (latensi client), state_*.txt (kondisi sebelum/sesudah), gameday-summary.md.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/e2e-lib.sh"
need kubectl python3
RECOVERY_S="${RECOVERY_S:-180}"; SETTLE_S="${SETTLE_S:-30}"; P95_MAX="${P95_MAX:-5}"
[ "${1:-}" = "--yes" ] || { echo "Skrip ini menjalankan gangguan nyata pada klaster. Ulangi dengan --yes bila yakin."; exit 2; }

ALL=$(k exec -n tester-agent daemonset/tester-agent -- /app list 2>/dev/null | tr -s '[:space:]' ' ')
[ -z "$ALL" ] && { echo "Tester Agent tidak ditemukan atau daftar skenario kosong (kubectl get pods -n tester-agent)" >&2; exit 2; }
SCEN="${SCENARIOS:-all}"; [ "$SCEN" = "all" ] && SCEN="$ALL"
read -r -a LIST <<<"$SCEN"
info "skenario: ${LIST[*]}"

cluster_healthy() {  # 0 bila node, pod, shard, dan breaker sehat
  local n p s b
  n=$(kubectl get nodes --no-headers | awk '$2 !~ /^Ready/' | wc -l)
  p=$(k get pods --no-headers | awk '$3=="Completed"||$3=="Succeeded"{next} {split($2,a,"/"); if (a[1]!=a[2] || $3!="Running") c++} END{print c+0}')
  s=$(k get clusters.postgresql.cnpg.io --no-headers 2>/dev/null | grep -vc "healthy state")
  b=$(num "$(prom 'max(pantai_breaker_state)')")
  [ "$n" -eq 0 ] && [ "$p" -eq 0 ] && [ "$s" -eq 0 ] && [ "$(python3 -c "print(1 if float('$b')==0 else 0)")" = 1 ]
}
state() {  # state <berkas>
  { date -u +%FT%TZ; kubectl get nodes --no-headers; echo; k get pods -o wide --no-headers; echo; k get clusters.postgresql.cnpg.io --no-headers
    echo; ingest_sql "select name,holder,epoch,(lease_until>now()) from ingest_lease order by name"; } > "$1" 2>&1
}

TOTAL=$(( ${#LIST[@]} * (RECOVERY_S + SETTLE_S + 20) + 180 ))
log "Kondisi awal; durasi total sekitar ${TOTAL}s"
cluster_healthy && ok "klaster sehat sebelum game day" || { bad "klaster belum sehat; perbaiki dulu sebelum game day"; state "$RESULTS_DIR/state_awal.txt"; finish; exit 1; }
state "$RESULTS_DIR/state_awal.txt"
T_START=$(date -u +%Y-%m-%dT%H:%M:%SZ); T0=$(now_s)

log "Memulai beban latar belakang dan kolektor alert kritis"
start_collector "$TOTAL"
probe_client lapangan lapangan_coastal 10 "$TOTAL" "/data?hazard_type=COASTAL" > "$RESULTS_DIR/probe_lapangan_coastal.json" 2>/dev/null & P1=$!
probe_client lapangan lapangan_other   15 "$TOTAL" "/data?hazard_type=SEISMIC,/data?hazard_type=VOLCANIC" > "$RESULTS_DIR/probe_lapangan_other.json" 2>/dev/null & P2=$!
probe_client media    media            20 "$TOTAL" "/data?hazard_type=SEISMIC,/data?hazard_type=COASTAL" > "$RESULTS_DIR/probe_media.json" 2>/dev/null & P3=$!
sleep 20

echo "skenario,gangguan_mulai,pulih_setelah_detik,hasil" > "$RESULTS_DIR/timeline.csv"
for sc in "${LIST[@]}"; do
  log "=== Skenario latihan: $sc ==="
  ti=$(now_s)
  k exec -n tester-agent daemonset/tester-agent -- /app run practice "$sc" 2>&1 | tail -6 | sed 's/^/   | /' | tee -a "$RESULTS_DIR/tester-agent.log"
  rec=""; consec=0
  while [ $(( $(now_s) - ti )) -lt "$RECOVERY_S" ]; do
    sleep 10
    if cluster_healthy; then consec=$((consec + 1)); else consec=0; fi
    [ "$consec" -ge 3 ] && { rec=$(( $(now_s) - ti - 20 )); break; }
  done
  if [ -n "$rec" ]; then ok "$sc: sistem pulih sendiri dalam sekitar ${rec}s"; echo "$sc,$(date -u -d @$ti +%T),$rec,pulih" >> "$RESULTS_DIR/timeline.csv"
  else bad "$sc: belum sehat setelah ${RECOVERY_S}s tanpa intervensi"; echo "$sc,$(date -u -d @$ti +%T),,tidak_pulih" >> "$RESULTS_DIR/timeline.csv"; state "$RESULTS_DIR/state_${sc}_gagal.txt"; fi
  sleep "$SETTLE_S"
done

log "Menunggu beban latar belakang selesai"
wait "$P1" "$P2" "$P3" 2>/dev/null; wait "$COLL_PID" 2>/dev/null
state "$RESULTS_DIR/state_akhir.txt"
T_ELAPSED=$(( $(now_s) - T0 ))

log "Alert kritis: 0 hilang dan p95 <= ${P95_MAX}s selama seluruh game day?"
e2e_evaluate "$T_START" "$P95_MAX"; rc=$?; [ "$rc" -ne 0 ] && FAILS=$((FAILS + 1))

log "Layanan client selama game day"
for f in lapangan_coastal lapangan_other media; do
  python3 - "$RESULTS_DIR/probe_$f.json" "$f" <<'PY' | tee -a "$RESULTS_DIR/probe_ringkasan.txt"
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(f"{sys.argv[2]}: tidak ada hasil probe"); sys.exit(0)
if "fatal" in d:
    print(f"{sys.argv[2]}: probe error {d['fatal']}"); sys.exit(0)
tot = d["sent"] or 1
print(f"{sys.argv[2]}: terkirim={d['sent']} status={d['statuses']} gagal={d['non_ok_non_shed']} ({100*d['non_ok_non_shed']/tot:.2f}%) p95={d['latency_ms']['p95']}ms maks={d['latency_ms']['max']}ms")
PY
done

log "SLO dan error budget"
python3 "$HERE/slo_report.py" --window "$((T_ELAPSED + 60))" --ns "$NS" --latency "$P95_MAX" --out "$RESULTS_DIR/slo.md" >/dev/null
rc=$?; cat "$RESULTS_DIR/slo.md"; [ "$rc" -ne 0 ] && bad "SLO jalur peringatan tidak terpenuhi (lihat slo.md)" || ok "SLO jalur peringatan terpenuhi"

{
  echo "# Ringkasan game day ($RUN_ID)"; echo
  echo "Skenario: ${LIST[*]}  |  durasi: ${T_ELAPSED}s  |  batas pemulihan: ${RECOVERY_S}s"; echo
  echo "## Waktu pemulihan tanpa intervensi"; echo; echo '```'; cat "$RESULTS_DIR/timeline.csv"; echo '```'; echo
  echo "## Layanan client"; echo; echo '```'; cat "$RESULTS_DIR/probe_ringkasan.txt" 2>/dev/null; echo '```'; echo
  echo "## Jalur alert kritis"; echo; echo '```'; cat "$RESULTS_DIR/e2e.txt"; echo '```'; echo
  cat "$RESULTS_DIR/slo.md"
  echo; echo "## Bahan post-mortem (isi manual)"; echo
  echo "- Deteksi: panel/metrik apa yang pertama kali menunjukkan gangguan (dashboard aggregator, breaker, outbox, shed)?"
  echo "- Dampak: berapa lama dan siapa yang terdampak (lihat probe_* dan e2e)?"
  echo "- Mitigasi: mekanisme otomatis yang bekerja (lease, breaker, outbox, probe, CNPG failover)."
  echo "- Perbaikan: apa yang akan diubah (ambang, TTL, sumber daya, replika)."
} > "$RESULTS_DIR/gameday-summary.md"
info "ringkasan: $RESULTS_DIR/gameday-summary.md"
finish
