#!/usr/bin/env bash
# Pustaka bersama untuk tests/p2 dan tests/p5.
# Jalankan skrip dari node-c (butuh kubectl dan python3), dari root repo atau dari folder mana pun.
# Dipakai dengan:  . "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
set -uo pipefail

NS="${NS:-sistem-informasi-kebencanaan-bnpb}"
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
RESULTS_DIR="${RESULTS_DIR:-$LIB_DIR/results/$RUN_ID}"
mkdir -p "$RESULTS_DIR"

FAILS=0
log()  { printf '%s %s\n' "$(date +%T)" "$*"; }
ok()   { printf '  [LULUS] %s\n' "$*"; }
bad()  { printf '  [GAGAL] %s\n' "$*"; FAILS=$((FAILS + 1)); }
info() { printf '  [INFO]  %s\n' "$*"; }
finish() {
  echo
  if [ "$FAILS" -eq 0 ]; then echo "HASIL: LULUS   (bukti: $RESULTS_DIR)"
  else echo "HASIL: GAGAL, $FAILS pemeriksaan tidak terpenuhi   (bukti: $RESULTS_DIR)"; fi
  return "$FAILS"
}
need() { for c in "$@"; do command -v "$c" >/dev/null 2>&1 || { echo "perintah '$c' diperlukan" >&2; exit 2; }; done; }

k() { kubectl -n "$NS" "$@"; }
now_s()  { date +%s; }
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
secret_val() { k get secret "$1" -o "jsonpath={.data.$2}" 2>/dev/null | base64 -d 2>/dev/null; }
num() { awk -v v="${1:-}" 'BEGIN{ if (v=="" || v=="NaN") print 0; else print v+0 }'; }

# ---- Prometheus (lewat wget di pod prometheus, tanpa port-forward) -------------------------------
prom() {  # query instan; mencetak nilai pertama ('' bila kosong)
  local q; q=$(python3 -c 'import sys,urllib.parse as u;print(u.quote(sys.argv[1]))' "$1")
  k exec deploy/prometheus -- wget -qO- "http://localhost:9090/api/v1/query?query=$q" 2>/dev/null |
    python3 -c 'import sys,json
try:
    r=json.load(sys.stdin)["data"]["result"]
    print(r[0]["value"][1] if r else "")
except Exception:
    print("")'
}

# ---- Database ----------------------------------------------------------------------------------
ingest_sql() {  # SQL ke database ingest (lease, status, outbox)
  k exec store-ingest-0 -- sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -At -F "|" -c "$1"' _ "$1"
}
shard_primary() { k get pod -l "cnpg.io/cluster=shard-$1,cnpg.io/instanceRole=primary" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null; }
shard_sql() {   # shard_sql <1|2|3> "<sql>"
  local p; p=$(shard_primary "$1"); k exec "$p" -c postgres -- psql -U postgres -d hazard -At -F "|" -c "$2"
}

# ---- Lease / leader ----------------------------------------------------------------------------
lease_row()     { ingest_sql "select name,holder,epoch,(lease_until>now())::int,round(extract(epoch from (lease_until-now()))::numeric,1) from ingest_lease where name='$1'"; }
leader_holder() { ingest_sql "select holder from ingest_lease where name='$1' and lease_until>now()"; }
holder_pod()    { echo "${1%.*}"; }   # holder = <nama-pod>.<hex acak>
pod_node()      { k get pod "$1" -o jsonpath='{.spec.nodeName}'; }
aggregator_pods() { k get pods -l app=aggregator --field-selector=status.phase=Running --no-headers -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName; }

# ---- Eksekusi di namespace host sebuah node (pod privileged sementara; image alpine kecil) ----
node_sh() {  # node_sh <node> '<skrip shell yang dijalankan di host>'
  local node="$1" b64 name="nsh-$RANDOM"
  b64=$(printf '%s' "$2" | base64 | tr -d '\n')
  kubectl -n "$NS" run "$name" --rm -i --restart=Never --quiet --labels=role=other \
    --image=alpine:3.20 --image-pull-policy=IfNotPresent \
    --overrides="{\"spec\":{\"nodeName\":\"$node\",\"hostPID\":true,\"tolerations\":[{\"operator\":\"Exists\"}],\"containers\":[{\"name\":\"$name\",\"image\":\"alpine:3.20\",\"stdin\":true,\"securityContext\":{\"privileged\":true},\"command\":[\"nsenter\",\"-t\",\"1\",\"-m\",\"-u\",\"-i\",\"-n\",\"-p\",\"--\",\"sh\",\"-c\",\"echo $b64 | base64 -d | sh\"]}]}}" 2>&1
}

host_pid_snippet() {  # potongan skrip host yang mengisi PID_C = PID host dari kontainer aggregator di pod $1
  echo "CID=\$(/usr/local/bin/k3s crictl ps -q --label io.kubernetes.pod.name=$1 --label io.kubernetes.container.name=aggregator | head -1); PID_C=\$(/usr/local/bin/k3s crictl inspect -o go-template --template '{{.info.pid}}' \$CID); echo pid=\$PID_C;"
}

# ---- Client Tim Lapangan / Media (probe di dalam pod client-service) --------------------------
client_creds() {  # client_creds media|lapangan|internal  ->  "<id> <secret>"
  local u; u=$(echo "$1" | tr '[:lower:]' '[:upper:]')
  echo "$(secret_val bnpb-secrets "${u}_CLIENT_ID") $(secret_val bnpb-secrets "${u}_CLIENT_SECRET")"
}
probe_client() {  # probe_client <client> <label> <rps> <detik> <path1,path2>   -> JSON ringkasan di stdout
  local c="$1" label="$2" rps="$3" secs="$4" paths="$5" id secret
  read -r id secret <<<"$(client_creds "$c")"
  k exec -i deploy/client-service -- env CLIENT_ID="$id" CLIENT_SECRET="$secret" LABEL="$label" \
    RPS="$rps" SECS="$secs" PATHS="$paths" node - < "$LIB_DIR/probe.js"
}
json_get() {  # json_get '<json>' 'expr python atas d'
  python3 -c 'import sys,json
d=json.loads(sys.argv[1])
print(eval(sys.argv[2]))' "$1" "$2"
}

# ---- Perubahan env sementara + pemulihan otomatis ---------------------------------------------
_RESTORE_CMDS=()
on_exit_restore() { for c in "${_RESTORE_CMDS[@]:-}"; do [ -n "$c" ] && eval "$c" >/dev/null 2>&1; done; }
trap on_exit_restore EXIT
register_restore() { _RESTORE_CMDS+=("$1"); }
set_env_temp() {  # set_env_temp <deploy> VAR=nilai ...  (mengembalikan nilai lama saat skrip selesai)
  local dep="$1"; shift
  local kv name old
  for kv in "$@"; do
    name="${kv%%=*}"
    old=$(k get deploy "$dep" -o "jsonpath={.spec.template.spec.containers[0].env[?(@.name==\"$name\")].value}" 2>/dev/null)
    if [ -n "$old" ]; then register_restore "kubectl -n $NS set env deploy/$dep $name=$old"
    else register_restore "kubectl -n $NS set env deploy/$dep $name-"; fi
  done
  k set env "deploy/$dep" "$@" >/dev/null && k rollout status "deploy/$dep" --timeout=300s >/dev/null
}
