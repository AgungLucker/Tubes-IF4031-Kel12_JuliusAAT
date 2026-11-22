#!/usr/bin/env bash
# P2 kriteria 2: tiap sumber diambil tepat sekali; tidak ada HazardEvent ganda; upstream tidak menerima
# permintaan berlipat. Aman dijalankan kapan saja (hanya membaca). Jalankan setelah tes lain sebagai
# bukti "tidak ada duplikat" (failover, jam bergeser, freeze, scaling).
#   SINCE=30m ./tests/p2/02-exactly-once.sh
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
need kubectl python3
SINCE="${SINCE:-30m}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log "1) Duplikat langsung di database shard (source|source_ref_id harus unik antar seluruh shard)"
for s in 1 2 3; do shard_sql "$s" "select source||'|'||source_ref_id from hazard_events" 2>/dev/null; done | sort > "$RESULTS_DIR/all_refs.txt"
total=$(wc -l < "$RESULTS_DIR/all_refs.txt" | tr -d ' ')
dups=$(uniq -d "$RESULTS_DIR/all_refs.txt" | wc -l | tr -d ' ')
info "total HazardEvent di semua shard: $total"
[ "$dups" -eq 0 ] && ok "tidak ada source_ref_id ganda ($total baris)" || { bad "$dups source_ref_id ganda"; uniq -d "$RESULTS_DIR/all_refs.txt" | head -5; }

log "2) Duplikat lewat Audit API (hazard_id dan source_ref_id, plus pencocokan checksum)"
POD=$(k get pods -l app=aggregator --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
out=$(k exec -i "$POD" -- node - < "$HERE/audit_scan.js" 2>&1); rc=$?
echo "$out" > "$RESULTS_DIR/audit_scan.json"
case $rc in
  0) ok "Audit API: $(json_get "$out" "d['total']") event, 0 duplikat (partial=$(json_get "$out" "d['partial']"))" ;;
  1) bad "Audit API menemukan duplikat: $(json_get "$out" "d['duplicate_hazard_ids']") hazard_id, $(json_get "$out" "d['duplicate_source_refs']") source_ref_id" ;;
  3) info "dilewati: AUDIT_TOKEN belum diisi (Secret aggregator-audit)" ;;
  *) bad "Audit API gagal: ${out:0:200}" ;;
esac
if [ $rc -eq 0 ]; then
  mism=$(json_get "$out" "[s for s,c in d['checksums'].items() if not c.get('count_matches_scan', True)]")
  [ "$mism" = "[]" ] && ok "jumlah per sumber cocok dengan /internal/audit/checksum" || bad "jumlah tidak cocok dengan checksum untuk: $mism"
fi

log "3) Permintaan ke upstream per sumber (log mock BMKG/PVMBG, jendela $SINCE)"
python3 "$HERE/exactly_once.py" --ns "$NS" --since "$SINCE" --out "$RESULTS_DIR/upstream.json"
rc=$?
[ $rc -eq 0 ] && ok "satu holder per sumber pada setiap detik, laju permintaan tidak berlipat" || bad "pelanggaran pada log upstream (lihat $RESULTS_DIR/upstream.json)"

log "4) Lease saat ini"
ingest_sql "select name,holder,epoch,(lease_until>now()) as aktif from ingest_lease order by name" | sed 's/^/     /'
finish
