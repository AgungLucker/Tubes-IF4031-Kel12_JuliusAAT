#!/usr/bin/env bash
# P5 kriteria 1: seluruh event yang ditandai kritis oleh Sensor Pantai sampai ke penerima notifikasi Tim Lapangan:
# 0 event kritis hilang, p95 latensi <= 5 detik.
#   SECS=180 ./tests/p5/02-critical-e2e.sh
# Alurnya: kolektor AMQP (ter-bind ke hazard.*.awas, sama seperti notifier) mendengarkan selama SECS detik;
# sesudahnya hasilnya dicocokkan dengan (a) semua observasi kritis dari sensor, (b) HazardEvent AWAS di shard,
# (c) pesan yang dikarantina, (d) isi outbox. Untuk menguji ketahanan, jalankan bersamaan dengan gangguan:
#   FAULT=broker   -> RabbitMQ dimatikan selama FAULT_S detik di tengah uji (alert harus menunggu di outbox)
#   FAULT=leader   -> pod leader SENSOR_PANTAI dibunuh di tengah uji
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/e2e-lib.sh"
need kubectl python3
SECS="${SECS:-180}"; FAULT="${FAULT:-}"; FAULT_S="${FAULT_S:-30}"; P95_MAX="${P95_MAX:-5}"

log "Memulai kolektor AMQP selama ${SECS}s (binding hazard.*.awas, seperti notifier Tim Lapangan)"
T_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
start_collector "$SECS"
sleep 5

case "$FAULT" in
  broker)
    log "Gangguan: RabbitMQ dimatikan selama ${FAULT_S}s"
    register_restore "kubectl -n $NS scale statefulset/rabbitmq --replicas=1"
    sleep $((SECS / 3)); k scale statefulset/rabbitmq --replicas=0 >/dev/null
    sleep "$FAULT_S"; k scale statefulset/rabbitmq --replicas=1 >/dev/null; log "RabbitMQ dinyalakan lagi (tanpa intervensi lain)" ;;
  leader)
    holder=$(leader_holder SENSOR_PANTAI); pod=$(holder_pod "$holder")
    log "Gangguan: leader SENSOR_PANTAI ($pod) dibunuh"
    sleep $((SECS / 3)); k delete pod "$pod" --grace-period=0 --force --wait=false >/dev/null 2>&1 ;;
  "") : ;;
  *) echo "FAULT tidak dikenal: $FAULT" >&2; exit 2 ;;
esac

wait "$COLL_PID" 2>/dev/null
log "Kolektor selesai: $(wc -l < "$RESULTS_DIR/received.jsonl" | tr -d ' ') pesan diterima"
e2e_evaluate "$T_START" "$P95_MAX"; rc=$?
[ "$rc" -ne 0 ] && FAILS=$((FAILS + 1))
grep -q '"event_AWAS_selama_jendela": 0' "$RESULTS_DIR/e2e.txt" && \
  info "tidak ada alert kritis selama jendela uji; perpanjang SECS atau pakai profil sensor yang menghasilkan kritis (Tester Agent)"
finish
