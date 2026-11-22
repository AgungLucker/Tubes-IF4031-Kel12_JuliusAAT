set -euo pipefail
NS=sistem-informasi-kebencanaan-bnpb

 counts() {
   local nodes; nodes=$(kubectl get nodes --no-headers | awk '$2 ~ /^Ready/ {print $1}')
   for n in $nodes; do
-    c=$(kubectl -n $NS get pods -l role=store --field-selector spec.nodeName="$n" --no-headers 2>/dev/null | wc -l | tr -d ' ')
+    c=$(kubectl -n $NS get pods -l group=hazardevent --field-selector spec.nodeName="$n" --no-headers 2>/dev/null | wc -l | tr -d ' ')
     echo "$c $n"
   done | sort -n
 }

wait_healthy() {
  for c in $(kubectl -n $NS get clusters -o name); do
    kubectl -n $NS wait --for=condition=Ready "$c" --timeout=600s
  done
}

promote_on() {
  local node="$1"
  local pod; pod=$(kubectl -n $NS get pods -l role=store,cnpg.io/instanceRole=replica \
      --field-selector spec.nodeName="$node" -o jsonpath='{.items[0].metadata.name}')
  [ -z "$pod" ] && { echo "tidak ada replika di $node"; exit 1; }
  local cluster; cluster=$(kubectl -n $NS get pod "$pod" -o jsonpath='{.metadata.labels.cnpg\.io/cluster}')
  echo "==> switchover $cluster: primary baru $pod di $node"
  if kubectl cnpg version >/dev/null 2>&1; then
    kubectl cnpg promote "$cluster" "$pod" -n $NS
  else
    kubectl -n $NS patch cluster "$cluster" --type=merge --subresource=status \
      -p "{\"status\":{\"targetPrimary\":\"$pod\"}}"
  fi
  sleep 5; wait_healthy
  kubectl -n $NS get clusters
}

if [ "${1:-}" = "--promote-on" ]; then promote_on "$2"; exit 0; fi

for round in 1 2 3 4 5 6; do
  mapfile -t rows < <(counts)
  min_c=${rows[0]%% *}; min_n=${rows[0]#* }
  max_c=${rows[-1]%% *}; max_n=${rows[-1]#* }
  echo "putaran $round: tersedikit $min_n=$min_c, terbanyak $max_n=$max_c"
  if [ $((max_c - min_c)) -le 1 ]; then echo "seimbang."; break; fi

  victim=""
  for pod in $(kubectl -n $NS get pods -l role=store,cnpg.io/instanceRole=replica \
                 --field-selector spec.nodeName="$max_n" -o jsonpath='{.items[*].metadata.name}'); do
    cl=$(kubectl -n $NS get pod "$pod" -o jsonpath='{.metadata.labels.cnpg\.io/cluster}')
    on_target=$(kubectl -n $NS get pods -l cnpg.io/cluster="$cl",cnpg.io/podRole=instance \
                 --field-selector spec.nodeName="$min_n" --no-headers 2>/dev/null | wc -l | tr -d ' ')
    healthy=$(kubectl -n $NS get cluster "$cl" -o jsonpath='{.status.readyInstances}')
    if [ "$on_target" = "0" ] && [ "$healthy" = "2" ]; then victim=$pod; break; fi
  done
  [ -z "$victim" ] && { echo "tidak ada replika yang bisa dipindah dari $max_n"; break; }

  echo "==> pindahkan $victim: $max_n -> $min_n"
  kubectl -n $NS delete pvc "$victim" --wait=false
  kubectl -n $NS delete pod "$victim" --wait=false
  sleep 10; wait_healthy
done

kubectl -n $NS get pods -l role=store -o wide
