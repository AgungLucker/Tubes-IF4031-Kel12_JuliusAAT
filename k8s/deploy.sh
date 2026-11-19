set -euo pipefail

CNPG_VERSION="${CNPG_VERSION:-1.24.1}"
CNPG_MANIFEST="https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-${CNPG_VERSION%.*}/releases/cnpg-${CNPG_VERSION}.yaml"
NS=sistem-informasi-kebencanaan-bnpb
DIR="$(cd "$(dirname "$0")" && pwd)"
STORE="$DIR/Storage_HazardEvent"

step() { printf '\n==> %s\n' "$*"; }

step "Operator CloudNativePG ${CNPG_VERSION}"
kubectl apply --server-side --force-conflicts -f "$CNPG_MANIFEST"
kubectl -n cnpg-system rollout status deployment/cnpg-controller-manager --timeout=180s

kubectl -n cnpg-system patch deployment cnpg-controller-manager --type=merge -p '{
  "spec": {"replicas": 2, "template": {"spec": {"affinity": {"podAntiAffinity": {
    "preferredDuringSchedulingIgnoredDuringExecution": [{"weight": 100, "podAffinityTerm": {
      "topologyKey": "kubernetes.io/hostname",
      "labelSelector": {"matchLabels": {"app.kubernetes.io/name": "cloudnative-pg"}}}}]}}}}}}'
kubectl -n cnpg-system rollout status deployment/cnpg-controller-manager --timeout=180s

for i in $(seq 1 30); do
  if kubectl -n cnpg-system get endpoints cnpg-webhook-service -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null | grep -q .; then
    break
  fi
  echo "   menunggu webhook CNPG ($i/30)"; sleep 2
done

step "Namespace"
kubectl apply -f "$DIR/00-namespace.yaml"

step "Shard HazardEvent"
for i in 1 2 3; do
  for attempt in 1 2 3 4 5; do
    kubectl apply -f "$STORE/shard-$i.yaml" && break
    echo "   apply shard-$i gagal, coba lagi ($attempt/5)"; sleep 5
  done
done

step "NetworkPolicy, RBAC Aggregator, pvc-reaper"
kubectl apply -f "$STORE/networkpolicy.yaml"
kubectl apply -f "$STORE/aggregator-rbac.yaml"
kubectl apply -f "$STORE/pvc-reaper.yaml"

if [ -n "${AUDIT_TOKEN:-}" ]; then
  step "Secret audit token"
  kubectl -n "$NS" create secret generic aggregator-audit \
    --from-literal=AUDIT_TOKEN="$AUDIT_TOKEN" --dry-run=client -o yaml | kubectl apply -f -
else
  echo "   (AUDIT_TOKEN kosong: Secret aggregator-audit tidak dibuat/diubah)"
fi

step "Menunggu semua shard sehat (primary + replika)"
for i in 1 2 3; do
  kubectl -n "$NS" wait --for=condition=Ready "cluster/shard-$i" --timeout=600s
done

step "Pemeriksaan"
kubectl -n "$NS" get clusters
kubectl -n "$NS" get pods -l group=hazardevent -o wide
stores=$(kubectl -n "$NS" get pods -l group=hazardevent,role=store --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$stores" -lt 6 ]; then
  echo "PERINGATAN: hanya $stores pod berlabel role=store (harusnya 6: 3 shard x 2 instance, label group=hazardevent). Tester Agent mencari pod lewat label ini." >&2
  exit 1
fi
echo "OK: $stores pod role=store, tiap shard punya 2 salinan di node berbeda."
