#!/usr/bin/env bash
# P2 kriteria 5: node yang sedang bertugas membeku lebih lama dari batas waktu (TTL lease), lalu bangun:
# instance itu tidak berhasil menyimpan apa pun sampai statusnya diperbarui.
#
#   SOURCE=BMKG ./tests/p2/05-freeze.sh                 # membekukan proses aggregator leader (SIGSTOP) lalu SIGCONT
#   FREEZE_S=40 ./tests/p2/05-freeze.sh
#
# SIGSTOP/SIGCONT dikirim dari host node ke proses aggregator (setara suspend VM untuk proses itu).
# Untuk pembekuan sungguhan saat demo: di host VirtualBox jalankan
#   VBoxManage controlvm <vm> savestate ... lalu VBoxManage startvm <vm>     (atau suspend/resume laptop),
# lalu jalankan skrip ini dengan SKIP_INJECT=1 untuk memeriksa hasilnya saja.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
need kubectl python3
SOURCE="${SOURCE:-BMKG}"; TTL="${TTL:-15}"; FREEZE_S="${FREEZE_S:-$((TTL + 25))}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

holder=$(leader_holder "$SOURCE"); [ -z "$holder" ] && { bad "tidak ada leader aktif untuk $SOURCE"; finish; exit 1; }
pod=$(holder_pod "$holder"); node=$(pod_node "$pod")
epoch0=$(ingest_sql "select epoch from ingest_lease where name='$SOURCE'")
info "leader=$holder pod=$pod node=$node epoch=$epoch0, pembekuan ${FREEZE_S}s (TTL lease ${TTL}s)"

unfreeze() { node_sh "$node" "$(host_pid_snippet "$pod") kill -CONT \$PID_C 2>/dev/null; echo CONT" >/dev/null 2>&1; }
register_restore unfreeze

if [ -z "${SKIP_INJECT:-}" ]; then
  log "Membekukan proses aggregator di $node"
  node_sh "$node" "$(host_pid_snippet "$pod") kill -STOP \$PID_C; echo STOP" | sed 's/^/   | /'
  T0=$(now_s); new=""
  while [ $(( $(now_s) - T0 )) -lt "$FREEZE_S" ]; do
    h=$(leader_holder "$SOURCE"); [ -n "$h" ] && [ "$h" != "$holder" ] && [ -z "$new" ] && { new="$h"; info "pengganti $h terpilih setelah $(( $(now_s) - T0 ))s"; }
    sleep 2
  done
  [ -n "$new" ] && ok "instance lain mengambil alih saat leader membeku" || bad "tidak ada pengambilalihan selama pembekuan"
  log "Membangunkan proses (SIGCONT)"
  unfreeze
fi

sleep 25
epoch1=$(ingest_sql "select epoch from ingest_lease where name='$SOURCE'")
cur=$(leader_holder "$SOURCE")
[ "$epoch1" -gt "$epoch0" ] && ok "epoch naik ($epoch0 -> $epoch1): peralihan tercatat" || bad "epoch tidak naik"
[ "$cur" != "$holder" ] && ok "leader sekarang $cur, bukan instance yang membeku" || bad "instance yang membeku masih leader"

log "Status instance yang bangun ($pod)"
m=$(k exec "$pod" -- node -e "fetch('http://localhost:8090/metrics').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null)
lead=$(echo "$m" | grep -E "^aggregator_is_leader\{[^}]*source=\"$SOURCE\"" | awk '{print $NF}')
fen=$(echo "$m" | grep -E "^aggregator_fenced_writes_total\{[^}]*source=\"$SOURCE\"" | awk '{print $NF}')
info "aggregator_is_leader{$SOURCE}=${lead:-?} aggregator_fenced_writes_total{$SOURCE}=${fen:-0}"
[ "${lead:-0}" = "0" ] && ok "instance yang bangun tidak menganggap dirinya leader" || bad "instance yang bangun masih melapor sebagai leader"
k logs "$pod" --since=3m 2>/dev/null | grep -E "\[lease\]|\[fence\]|dihentikan" | tail -5 | sed 's/^/   | /' | tee "$RESULTS_DIR/log_instance_bangun.txt"

log "Tidak ada penulisan dengan epoch usang"
bad_fence=0
for s in 1 2 3; do
  fe=$(shard_sql "$s" "select epoch from ingest_fence where source='$SOURCE'" 2>/dev/null)
  info "fence shard-$s epoch=${fe:-n/a}"
  [ -n "$fe" ] && [ "$fe" -ge "$epoch1" ] || [ -z "$fe" ] || { bad "fence shard-$s ($fe) tertinggal dari epoch $epoch1: penulis lama bisa menulis"; bad_fence=1; }
done
[ $bad_fence -eq 0 ] && ok "semua shard menolak epoch di bawah $epoch1 (tulisan instance yang bangun akan ditolak)"

SINCE="$(( (FREEZE_S + 120) / 60 + 2 ))m" bash "$HERE/02-exactly-once.sh" 2>&1 | tee "$RESULTS_DIR/exactly_once.txt" | grep -E "LULUS|GAGAL" | sed 's/^/   | /'
grep -q "GAGAL" "$RESULTS_DIR/exactly_once.txt" && bad "ada duplikat atau dua holder setelah pembekuan" || ok "tidak ada duplikat setelah pembekuan"
finish
