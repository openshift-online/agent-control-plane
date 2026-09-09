#!/usr/bin/env bash
# Read the cluster state. Do not change the current context.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OC="$SCRIPT_DIR/oc.sh"
NAMESPACE="${ACP_NAMESPACE:-acp-hypershell}"
HYPERSHELL_NAMESPACE="${HYPERSHELL_NAMESPACE:-hypershell-system}"
"$OC" whoami --show-server
"$OC" whoami
"$OC" get ingresses.config.openshift.io cluster -o jsonpath='{.spec.domain}{"\n"}'
"$OC" get deployment,pods,service,route -n "$HYPERSHELL_NAMESPACE" -o wide
"$OC" get deployment -n agent-sandbox-system
"$OC" get deployment -n cert-manager
"$OC" get storageclass
"$OC" get route default-route -n openshift-image-registry -o jsonpath='{.spec.host}{"\n"}'
for resource in deployments services routes secrets configmaps persistentvolumeclaims serviceaccounts roles rolebindings buildconfigs.build.openshift.io imagestreams.image.openshift.io; do
  result="$("$OC" auth can-i create "$resource" -n "$NAMESPACE")"
  printf '%s: %s\n' "$resource" "$result"
  [[ "$result" == yes ]] || exit 1
done
