#!/usr/bin/env bash
# Apply the rendered resources. Required Secrets and OIDC clients must exist.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${1:?Usage: apply.sh config.json}"
OC="$SCRIPT_DIR/oc.sh"
NAMESPACE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["namespace"])' "$CONFIG")"
for secret in ambient-api-server-db ambient-api-server ambient-control-plane-oidc credential-encryption-key sso-credentials; do
  "$OC" get secret "$secret" -n "$NAMESPACE" -o name
done
python3 "$SCRIPT_DIR/render.py" "$CONFIG" | "$OC" apply -f -
for deployment in ambient-api-server-db ambient-api-server ambient-control-plane ambient-ui; do
  "$OC" rollout status "deployment/$deployment" -n "$NAMESPACE" --timeout=300s
done
"$OC" get pods,route -n "$NAMESPACE" -o wide
