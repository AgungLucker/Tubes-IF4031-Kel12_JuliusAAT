#!/usr/bin/env bash
# P2 kriteria 3: bila instance yang sedang mengambil data mati, instance lain melanjutkan dalam <= 60 detik,
# tanpa celah data dan tanpa duplikat.
#   SOURCE=BMKG MAX_S=60 ./tests/p2/03-failover.sh
# Mematikan pod leader dengan paksa (setara crash: SIGKILL, lease TIDAK dilepas, jadi pengganti menunggu TTL).
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
need kubectl python3
SOURCE="${SOURCE:-BMKG}"; MAX_S="${MAX_S:-60}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log "Sebelum: leader sumber $SOURCE"
holder=$(leader_holder "$SOURCE")
[ -z "$holder" ] && { bad "tidak ada leader aktif untuk $SOURCE"; finish; exit 1; }
pod=$(holder_pod "$holder"); epoch0=$(ingest_sql "select epoch from ingest_lease where name='$SOURCE'")
cursor0=$(ingest_sql "select coalesce(last_cursor,'') from ingest_status where source='$SOURCE'")
info "leader=$holder pod=$pod epoch=$epoch0 kursor=$cursor0"

T0=$(now_s)
log "Mematikan pod $pod (force, grace=0) pada T0"
k delete pod "$pod" --grace-period=0 --force --wait=false >/dev/null 2>&1

new_holder=""; T_LEAD=""
while [ $(( $(now_s) - T0 )) -le $((MAX_S + 30)) ]; do
  h=$(leader_holder "$SOURCE")
  if [ -n "$h" ] && [ "$h" != "$holder" ]; then new_holder="$h"; T_LEAD=$(( $(now_s) - T0 )); break; fi
  sleep 1
done
if [ -z "$new_holder" ]; then bad "tidak ada pengganti dalam $((MAX_S + 30)) detik"; finish; exit 1; fi
epoch1=$(ingest_sql "select epoch from ingest_lease where name='$SOURCE'")
info "pengganti=$new_holder epoch=$epoch1 setelah ${T_LEAD}s"
[ "$epoch1" -gt "$epoch0" ] && ok "epoch naik ($epoch0 -> $epoch1)" || bad "epoch tidak naik"

# Poll pertama pengganti yang benar-benar sampai ke upstream (data mulai mengalir lagi)
mock=$([ "$SOURCE" = "PVMBG" ] && echo pvmbg-mock || echo bmkg-mock)
T_DATA=""
while [ $(( $(now_s) - T0 )) -le $((MAX_S + 60)) ]; do
  if k logs "deploy/$mock" --since=3m 2>/dev/null | grep -q "poll:${new_holder}:${SOURCE}:"; then T_DATA=$(( $(now_s) - T0 )); break; fi
  sleep 2
done
[ -z "$T_DATA" ] && { bad "pengganti tidak pernah memanggil upstream"; finish; exit 1; }
info "data mengalir lagi ${T_DATA}s setelah leader mati (batas ${MAX_S}s)"
[ "$T_DATA" -le "$MAX_S" ] && ok "pengambilalihan $T_DATA s <= $MAX_S s" || bad "pengambilalihan $T_DATA s melebihi $MAX_S s"

sleep 10
cursor1=$(ingest_sql "select coalesce(last_cursor,'') from ingest_status where source='$SOURCE'")
if [ "$cursor1" \> "$cursor0" ] || [ "$cursor1" = "$cursor0" ]; then ok "kursor tidak mundur ($cursor0 -> $cursor1): tidak ada celah data"; else bad "kursor mundur ($cursor0 -> $cursor1)"; fi

log "Duplikat setelah failover"
SINCE=10m bash "$HERE/02-exactly-once.sh" 2>&1 | sed 's/^/   | /' | tee "$RESULTS_DIR/exactly_once.txt" | grep -E "LULUS|GAGAL|HASIL"
grep -q "GAGAL" "$RESULTS_DIR/exactly_once.txt" && bad "ada duplikat atau pelanggaran setelah failover" || ok "tidak ada duplikat setelah failover"
echo "T_lead=${T_LEAD}s T_data=${T_DATA}s epoch ${epoch0}->${epoch1}" > "$RESULTS_DIR/ringkasan.txt"
finish
