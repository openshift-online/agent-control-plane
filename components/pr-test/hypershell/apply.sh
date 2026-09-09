#!/usr/bin/env bash
# Apply the rendered resources. Required Secrets and OIDC clients must exist.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${1:?Usage: apply.sh config.json}"
OC="$SCRIPT_DIR/oc.sh"
python3 - "$CONFIG" <<'CHECK'
import json, sys
config = json.load(open(sys.argv[1]))
if not config.get('service_ca'):
    raise SystemExit('Set service_ca to the namespace service CA before applying')
if any('REPLACE' in value for value in config['images'].values()):
    raise SystemExit('Replace example image references with built image digests')
CHECK
NAMESPACE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["namespace"])' "$CONFIG")"
for secret in ambient-api-server-db ambient-api-server ambient-control-plane-oidc credential-encryption-key sso-credentials ambient-cp-token-keypair; do
  "$OC" get secret "$secret" -n "$NAMESPACE" -o name
done
python3 "$SCRIPT_DIR/render.py" "$CONFIG" | "$OC" apply -f -
for deployment in ambient-api-server-db ambient-api-server ambient-control-plane ambient-ui; do
  "$OC" rollout status "deployment/$deployment" -n "$NAMESPACE" --timeout=300s
done
"$OC" get pods,route -n "$NAMESPACE" -o wide
