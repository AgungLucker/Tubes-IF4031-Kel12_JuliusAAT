#!/bin/bash

set -euo pipefail

echo "Deploying BNPB application..."

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NS=sistem-informasi-kebencanaan-bnpb
GHCR_PULL_SECRET="${GHCR_PULL_SECRET:-ghcr-pull-secret}"

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

if [ ! -f "$KEYS_DIR/private.pem" ] || [ ! -f "$KEYS_DIR/public.pem" ]; then
  if kubectl -n "$NS" get secret "$JWT_SECRET" >/dev/null 2>&1; then
    echo "No key files in $KEYS_DIR; keeping existing secret $JWT_SECRET."
    SKIP_JWT_SECRET=1
  else
    command -v openssl >/dev/null 2>&1 || { echo "openssl is required to generate JWT keys" >&2; exit 1; }
    echo "Generating JWT key pair (ES256) in $KEYS_DIR ..."
    mkdir -p "$KEYS_DIR"
    openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out "$KEYS_DIR/private.pem"
    openssl pkey -in "$KEYS_DIR/private.pem" -pubout -out "$KEYS_DIR/public.pem"
    chmod 600 "$KEYS_DIR/private.pem"
  fi
fi

if [ -z "${SKIP_JWT_SECRET:-}" ]; then
  kubectl -n "$NS" create secret generic "$JWT_SECRET" \
    --from-file=private.pem="$KEYS_DIR/private.pem" \
    --from-file=public.pem="$KEYS_DIR/public.pem" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

kubectl apply -k "$ROOT/k8s/"

if kubectl -n "$NS" get secret "$GHCR_PULL_SECRET" >/dev/null 2>&1; then
  for deployment in \
    aggregator bmkg-mock pvmbg-mock bnpb-token-service client-service \
    consumer-dashboard consumer-notifier
  do
    kubectl -n "$NS" patch deployment "$deployment" --type merge -p \
      "{\"spec\":{\"template\":{\"spec\":{\"imagePullSecrets\":[{\"name\":\"$GHCR_PULL_SECRET\"}]}}}}"
  done
fi

kubectl rollout status deployment/aggregator -n "$NS"
kubectl rollout status deployment/client-service -n "$NS"
kubectl rollout status deployment/bnpb-token-service -n "$NS"
kubectl rollout status deployment/bmkg-mock -n "$NS"
kubectl rollout status deployment/pvmbg-mock -n "$NS"
kubectl rollout status deployment/consumer-dashboard -n "$NS"
kubectl rollout status deployment/consumer-notifier -n "$NS"

echo "Deployment completed!"

kubectl get pods -n "$NS" -o wide