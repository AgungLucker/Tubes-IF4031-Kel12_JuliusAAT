#!/bin/bash
# Satu perintah untuk memasang seluruh sistem BNPB ke cluster Kubernetes (k3s).
#
#   AUDIT_TOKEN=<token-audit-dari-asisten> ./scripts/deploy.sh
#
# Idempoten: aman dijalankan ulang. Variabel opsional (semuanya boleh kosong):
#   AUDIT_TOKEN        token internal Audit API (Secret aggregator-audit); dilewati bila Secret sudah ada
#   PANTAI_AUTH_TOKEN  token Sensor Pantai; bila kosong dan Secret belum ada, dibuat acak
#   GHCR_USERNAME / GHCR_TOKEN   pull secret GHCR bila image privat
#   SKIP_TESTER_AGENT=1          jangan memasang Tester Agent
#   SKIP_SHARDS=1                jangan memasang operator CloudNativePG dan shard (sudah terpasang)
#   ROLLOUT_TIMEOUT=300s         batas tunggu tiap rollout

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NS=sistem-informasi-kebencanaan-bnpb
GHCR_PULL_SECRET="${GHCR_PULL_SECRET:-ghcr-pull-secret}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-300s}"
# Manifest Tester Agent yang disebut spesifikasi (commit dipin, image tidak boleh diganti).
TESTER_AGENT_MANIFEST="https://raw.githubusercontent.com/susTuna/if4031-tester-agent/ebb55261711123a9a211739ffbf140a275caa6da/manifest.yaml"
ALLOWED_ROLES="aggregator store broker consumer api mock sensor other"

step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'PERINGATAN: %s\n' "$*" >&2; }
die()  { printf 'GAGAL: %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------------- 1. Prasyarat
step "Memeriksa cluster"
command -v kubectl >/dev/null 2>&1 || die "kubectl tidak ditemukan"
kubectl version --request-timeout=10s >/dev/null 2>&1 || die "cluster tidak terjangkau (periksa kubeconfig)"

ready_nodes=$(kubectl get nodes --no-headers | awk '$2 ~ /^Ready/ {n++} END {print n+0}')
total_nodes=$(kubectl get nodes --no-headers | wc -l | tr -d ' ')
kubectl get nodes -o wide
[ "$ready_nodes" -ge 2 ] || die "butuh minimal 2 node Ready (sekarang $ready_nodes dari $total_nodes)"
[ "$ready_nodes" -eq "$total_nodes" ] || warn "ada node yang belum Ready ($ready_nodes dari $total_nodes); pod bisa Pending"
if kubectl get nodes -o jsonpath='{.items[*].spec.providerID}' | grep -qi k3d; then
  warn "cluster berbasis container (k3d): hanya boleh untuk pengembangan, bukan demo"
fi

# --------------------------------------------------------------------------- 2. Namespace & Secret dasar
step "Namespace dan Secret dasar"
kubectl apply -f "$ROOT/k8s/00-namespace.yaml"
kubectl apply -f "$ROOT/k8s/config/secrets.yaml"

if [ -n "${GHCR_USERNAME:-}" ] && [ -n "${GHCR_TOKEN:-}" ]; then
  kubectl -n "$NS" create secret docker-registry "$GHCR_PULL_SECRET" \
    --docker-server=ghcr.io \
    --docker-username="$GHCR_USERNAME" \
    --docker-password="$GHCR_TOKEN" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

KEYS_DIR="$ROOT/keys"
JWT_SECRET=bnpb-jwt-keys
SKIP_JWT_SECRET=""
if [ ! -f "$KEYS_DIR/private.pem" ] || [ ! -f "$KEYS_DIR/public.pem" ]; then
  if kubectl -n "$NS" get secret "$JWT_SECRET" >/dev/null 2>&1; then
    echo "Tidak ada berkas kunci di $KEYS_DIR; memakai Secret $JWT_SECRET yang sudah ada."
    SKIP_JWT_SECRET=1
  else
    command -v openssl >/dev/null 2>&1 || die "openssl diperlukan untuk membuat kunci JWT"
    echo "Membuat pasangan kunci JWT (ES256) di $KEYS_DIR ..."
    mkdir -p "$KEYS_DIR"
    openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out "$KEYS_DIR/private.pem"
    openssl pkey -in "$KEYS_DIR/private.pem" -pubout -out "$KEYS_DIR/public.pem"
    chmod 600 "$KEYS_DIR/private.pem"
  fi
fi
if [ -z "$SKIP_JWT_SECRET" ]; then
  kubectl -n "$NS" create secret generic "$JWT_SECRET" \
    --from-file=private.pem="$KEYS_DIR/private.pem" \
    --from-file=public.pem="$KEYS_DIR/public.pem" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

# Token Audit API (diberikan asisten). Tanpa ini Audit API di Aggregator tidak bisa diakses.
if [ -n "${AUDIT_TOKEN:-}" ]; then
  kubectl -n "$NS" create secret generic aggregator-audit \
    --from-literal=AUDIT_TOKEN="$AUDIT_TOKEN" --dry-run=client -o yaml | kubectl apply -f -
elif ! kubectl -n "$NS" get secret aggregator-audit >/dev/null 2>&1; then
  warn "AUDIT_TOKEN kosong dan Secret aggregator-audit belum ada: Audit API tidak akan berfungsi"
fi

# Token Sensor Pantai: dipakai bersama oleh Sensor Pantai (sebagai token yang diharapkan) dan Aggregator.
if [ -n "${PANTAI_AUTH_TOKEN:-}" ]; then
  kubectl -n "$NS" create secret generic pantai-token \
    --from-literal=token="$PANTAI_AUTH_TOKEN" --dry-run=client -o yaml | kubectl apply -f -
elif ! kubectl -n "$NS" get secret pantai-token >/dev/null 2>&1; then
  command -v openssl >/dev/null 2>&1 || die "openssl diperlukan untuk membuat token Sensor Pantai"
  echo "Membuat token Sensor Pantai acak (Secret pantai-token)"
  kubectl -n "$NS" create secret generic pantai-token --from-literal=token="$(openssl rand -hex 16)"
fi

# --------------------------------------------------------------------------- 3. Operator CNPG dan shard HazardEvent
if [ -z "${SKIP_SHARDS:-}" ]; then
  step "Operator CloudNativePG dan shard HazardEvent"
  # deploy.sh memakai AUDIT_TOKEN dari environment untuk Secret aggregator-audit (idempoten).
  bash "$ROOT/k8s/deploy.sh"
else
  echo "SKIP_SHARDS=1: operator dan shard dilewati"
fi

# --------------------------------------------------------------------------- 4. Aplikasi
step "Menerapkan manifest aplikasi (kustomize)"
kubectl apply -k "$ROOT/k8s/"

if kubectl -n "$NS" get secret "$GHCR_PULL_SECRET" >/dev/null 2>&1; then
  for deployment in \
    aggregator bmkg-mock pvmbg-mock bnpb-token-service client-service \
    consumer-dashboard consumer-notifier satellite-processor
  do
    kubectl -n "$NS" patch deployment "$deployment" --type merge -p \
      "{\"spec\":{\"template\":{\"spec\":{\"imagePullSecrets\":[{\"name\":\"$GHCR_PULL_SECRET\"}]}}}}" >/dev/null
  done
fi

# ConfigMap Prometheus/Grafana memakai nama tetap (tanpa hash): pod tidak restart sendiri saat isinya berubah.
step "Memuat ulang konfigurasi Prometheus dan Grafana"
kubectl -n "$NS" rollout restart deployment/prometheus deployment/grafana

# --------------------------------------------------------------------------- 5. Tester Agent
if [ -z "${SKIP_TESTER_AGENT:-}" ]; then
  step "Tester Agent"
  kubectl apply -f "$TESTER_AGENT_MANIFEST" || warn "gagal memasang Tester Agent (periksa akses internet ke raw.githubusercontent.com)"
else
  echo "SKIP_TESTER_AGENT=1: Tester Agent dilewati"
fi

# --------------------------------------------------------------------------- 6. Tunggu hingga siap
step "Menunggu rollout"
for deployment in \
  aggregator client-service bnpb-token-service bmkg-mock pvmbg-mock \
  consumer-dashboard consumer-notifier satellite-processor sensor-pantai \
  prometheus grafana jaeger
do
  kubectl -n "$NS" rollout status "deployment/$deployment" --timeout="$ROLLOUT_TIMEOUT"
done
kubectl -n "$NS" rollout status statefulset/rabbitmq --timeout="$ROLLOUT_TIMEOUT" || warn "rabbitmq belum siap"

# --------------------------------------------------------------------------- 7. Pemeriksaan kontrak platform
step "Pemeriksaan"
fail=0

bad=$(kubectl -n "$NS" get pods -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.labels.role}{"\n"}{end}' \
  | awk -v allowed="$ALLOWED_ROLES" 'BEGIN{n=split(allowed,a," "); for(i=1;i<=n;i++) ok[a[i]]=1} !($2 in ok) {print $1" (role="$2")"}')
if [ -n "$bad" ]; then
  warn "pod dengan label role di luar daftar yang diizinkan:"; echo "$bad" >&2; fail=1
else
  echo "OK  semua pod punya label role yang valid"
fi

stores=$(kubectl -n "$NS" get pods -l role=store --no-headers 2>/dev/null | wc -l | tr -d ' ')
echo "OK  $stores pod role=store"

agg_nodes=$(kubectl -n "$NS" get pods -l app=aggregator --field-selector=status.phase=Running \
  -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort -u | wc -l | tr -d ' ')
agg_pods=$(kubectl -n "$NS" get pods -l app=aggregator --field-selector=status.phase=Running --no-headers | wc -l | tr -d ' ')
if [ "$agg_pods" -ge 3 ] && [ "$agg_nodes" -ge 2 ]; then
  echo "OK  aggregator: $agg_pods instance di $agg_nodes node"
else
  warn "aggregator: $agg_pods instance Running di $agg_nodes node (butuh >=3 instance di node berbeda)"; fail=1
fi

if kubectl get ns tester-agent >/dev/null 2>&1; then
  echo "OK  Tester Agent: $(kubectl -n tester-agent get pods --no-headers 2>/dev/null | wc -l | tr -d ' ') pod"
elif [ -z "${SKIP_TESTER_AGENT:-}" ]; then
  warn "namespace tester-agent tidak ada"; fail=1
fi

echo
kubectl get pods -n "$NS" -o wide
[ "$fail" -eq 0 ] && echo && echo "Deployment selesai." || { echo; echo "Deployment selesai dengan peringatan (lihat di atas)."; exit 1; }
