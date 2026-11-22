#!/usr/bin/env bash
# Fungsi bersama untuk evaluasi jalur alert kritis. Di-source oleh 02-critical-e2e.sh dan 06-gameday.sh.
# Butuh: lib.sh sudah di-source, variabel HERE (folder tests/p5), RESULTS_DIR.

e2e_evaluate() {  # e2e_evaluate <T_START iso> [P95_MAX detik]  -> kode keluar 0 bila semua pemeriksaan lulus
  local t_start="$1" p95="${2:-5}" pod pending s
  log "Menunggu outbox mengalir (maks 60s)"
  for _ in $(seq 1 30); do
    pending=$(ingest_sql "select count(*) from critical_outbox where sent_at is null" 2>/dev/null); [ "${pending:-1}" = "0" ] && break; sleep 2
  done
  pending=$(ingest_sql "select count(*) from critical_outbox where sent_at is null" 2>/dev/null); pending="${pending:-0}"

  log "Mengumpulkan kebenaran dasar dari sensor dan database"
  pod=$(k get pods -l app=aggregator --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
  k exec -i "$pod" -- node - < "$HERE/sensor_critical.js" > "$RESULTS_DIR/sensor_critical.json" 2>/dev/null
  for s in 1 2 3; do
    shard_sql "$s" "select source_ref_id from hazard_events where source='SENSOR_PANTAI' and severity='AWAS'" 2>/dev/null
  done | sort -u > "$RESULTS_DIR/db_all.txt"
  for s in 1 2 3; do
    shard_sql "$s" "select source_ref_id||'|'||to_char(ingested_at::timestamptz at time zone 'utc','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from hazard_events where source='SENSOR_PANTAI' and severity='AWAS' and ingested_at::timestamptz >= '$t_start'::timestamptz" 2>/dev/null
  done | sort -u > "$RESULTS_DIR/db_window.txt"
  ingest_sql "select substring(encode(raw_payload,'escape') from '\"observation_id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\"') from rejected_messages where source='SENSOR_PANTAI' and encode(raw_payload,'escape') ~ '\"critical\"[[:space:]]*:[[:space:]]*true'" 2>/dev/null | sort -u > "$RESULTS_DIR/rejected_critical.txt"

  python3 "$HERE/e2e_report.py" --received "$RESULTS_DIR/received.jsonl" --sensor "$RESULTS_DIR/sensor_critical.json" \
    --db-all "$RESULTS_DIR/db_all.txt" --db-window "$RESULTS_DIR/db_window.txt" --rejected "$RESULTS_DIR/rejected_critical.txt" \
    --pending "$pending" --p95-max "$p95" --out "$RESULTS_DIR/e2e.json" | tee "$RESULTS_DIR/e2e.txt"
  return "${PIPESTATUS[0]}"
}

start_collector() {  # start_collector <detik>  -> menjalankan kolektor di latar belakang; PID di COLL_PID
  local pod; pod=$(k get pods -l app=aggregator --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
  k exec -i "$pod" -- env SECS="$1" KEYS="hazard.*.awas" node - < "$HERE/collector.js" > "$RESULTS_DIR/received.jsonl" 2> "$RESULTS_DIR/collector.err" &
  COLL_PID=$!
}
