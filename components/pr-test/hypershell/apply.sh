#!/usr/bin/env bash
# Apply the rendered resources. Required Secrets and OIDC clients must exist.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${1:?Usage: apply.sh config.json}"
OC="$SCRIPT_DIR/oc.sh"
python3 - "$CONFIG" <<'CHECK'
import json, sys
config = json.load(open(sys.argv[1]))
if not config.get('api_tls'):
    raise SystemExit('Run setup-tls.py to configure verified API and gRPC TLS')
if config.get('grpc_route_termination') != 'passthrough' and not config.get('service_ca'):
    raise SystemExit('Set service_ca to the namespace service CA before applying')
if any('REPLACE' in value for value in config['images'].values()):
    raise SystemExit('Replace example image references with built image digests')
CHECK
NAMESPACE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["namespace"])' "$CONFIG")"
for secret in ambient-api-server-db ambient-api-server ambient-control-plane-oidc credential-encryption-key sso-credentials ambient-cp-token-keypair; do
  "$OC" get secret "$secret" -n "$NAMESPACE" -o name
done
# OpenShift adds each service account image pull Secret asynchronously.
# Create accounts first so the first pods can pull private images.
python3 "$SCRIPT_DIR/render.py" "$CONFIG" | python3 -c 'import json,sys; data=json.load(sys.stdin); data["items"]=[item for item in data["items"] if item["kind"] == "ServiceAccount"]; print(json.dumps(data))' | "$OC" apply -f -
for account in ambient-api-server-db ambient-api-server ambient-control-plane ambient-ui; do
  "$OC" wait "serviceaccount/$account" -n "$NAMESPACE" --for=jsonpath='{.imagePullSecrets[0].name}' --timeout=60s
done
python3 "$SCRIPT_DIR/render.py" "$CONFIG" | "$OC" apply -f -
for deployment in ambient-api-server-db ambient-api-server ambient-control-plane ambient-ui; do
  "$OC" rollout status "deployment/$deployment" -n "$NAMESPACE" --timeout=300s
done
"$OC" get pods,route -n "$NAMESPACE" -o wide
