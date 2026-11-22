#!/usr/bin/env bash
# Fungsi bantu untuk menjalankan k6 sebagai Job DI DALAM klaster (alat uji di luar pod komponen aplikasi,
# sesuai Lampiran B). Di-source oleh 06/07/08:   . "$HERE/k6-run.sh"
# Variabel: K6_MEM_REQ (1Gi) K6_MEM_LIM (4Gi) K6_NODE (opsional: pin Job ke satu node yang RAM-nya besar)
# CATATAN KAPASITAS: k6 butuh sekitar 1-2 MB per VU. 10.000 VU berarti 10-20 GB, melebihi RAM node saat ini.
# Bila tidak muat, jalankan k6 dari mesin lain (mis. laptop host) memakai tests/p2/optional-entry.yaml,
# atau kurangi VUS dan perbesar laju lewat THINK_S yang lebih kecil, lalu catat batasan itu di laporan.
K6_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/k6"

k6_netpol() {  # izinkan pod berlabel app=loadtest masuk ke aggregator, client-service, dan token-service
  for spec in "aggregator:8090" "client-service:8080" "bnpb-token-service:8090"; do
    local app="${spec%%:*}" port="${spec##*:}"
    cat <<EOF | k apply -f - >/dev/null
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: allow-loadtest-to-$app}
spec:
  podSelector: {matchLabels: {app: $app}}
  policyTypes: [Ingress]
  ingress:
    - from: [{podSelector: {matchLabels: {app: loadtest}}}]
      ports: [{protocol: TCP, port: $port}]
EOF
  done
}
k6_cleanup() {
  for app in aggregator client-service bnpb-token-service; do k delete networkpolicy "allow-loadtest-to-$app" --ignore-not-found >/dev/null; done
  k delete configmap k6-scripts --ignore-not-found >/dev/null
}

k6_start() {  # k6_start <nama-job> <skrip.js> [VAR=nilai ...]
  local name="$1" script="$2"; shift 2
  k create configmap k6-scripts --from-file="$K6_DIR" --dry-run=client -o yaml | k apply -f - >/dev/null
  k delete job "$name" --ignore-not-found >/dev/null
  local envs="" kv
  for kv in "$@"; do envs+="            - {name: \"${kv%%=*}\", value: \"${kv#*=}\"}"$'\n'; done
  [ -z "$envs" ] && envs='            - {name: "K6_NOOP", value: "1"}'$'\n'
  local node_sel=""; [ -n "${K6_NODE:-}" ] && node_sel="nodeSelector: {kubernetes.io/hostname: ${K6_NODE}}"
  cat <<EOF | k apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata: {name: $name}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 7200
  template:
    metadata: {labels: {app: loadtest, role: other}}
    spec:
      restartPolicy: Never
      $node_sel
      containers:
        - name: k6
          image: grafana/k6:0.54.0
          args: ["run", "/scripts/$script"]
          env:
${envs}          resources: {requests: {memory: ${K6_MEM_REQ:-1Gi}}, limits: {memory: ${K6_MEM_LIM:-4Gi}}}
          volumeMounts: [{name: scripts, mountPath: /scripts}]
      volumes: [{name: scripts, configMap: {name: k6-scripts}}]
EOF
}

k6_wait_running() {  # tunggu pod Job berjalan (image k6 mungkin lama ditarik)
  local name="$1" t=0 ph
  while [ $t -lt "${2:-600}" ]; do
    ph=$(k get pods -l "job-name=$name" -o jsonpath='{.items[0].status.phase}' 2>/dev/null)
    [ "$ph" = "Running" ] || [ "$ph" = "Succeeded" ] && return 0
    sleep 3; t=$((t + 3))
  done
  return 1
}
k6_wait_done() {  # tunggu Job selesai; mencetak "complete" atau "failed"
  local name="$1" t=0 s f
  while [ $t -lt "${2:-1800}" ]; do
    s=$(k get job "$name" -o jsonpath='{.status.succeeded}' 2>/dev/null); f=$(k get job "$name" -o jsonpath='{.status.failed}' 2>/dev/null)
    [ "${s:-0}" -ge 1 ] && { echo complete; return 0; }
    [ "${f:-0}" -ge 1 ] && { echo failed; return 0; }
    sleep 5; t=$((t + 5))
  done
  echo timeout; return 1
}
k6_summary() { k logs "job/$1" 2>/dev/null | grep SUMMARY_JSON | tail -1 | sed 's/^SUMMARY_JSON //'; }
