#!/usr/bin/env bash
# Create the gateway-trusted-ca ConfigMap in the ACP namespace.
#
# On OpenShift (CRC or otherwise), extracts the ingress CA from the
# router-ca Secret and combines it with system CAs so that gateway pods
# can reach OIDC providers exposed through the ingress controller.
#
# On non-OpenShift clusters, this script is a no-op unless a custom CA
# bundle is provided via GATEWAY_CA_BUNDLE_PATH.
#
# Usage:
#   ./setup-gateway-trusted-ca.sh                      # auto-detect OpenShift
#   GATEWAY_CA_BUNDLE_PATH=/path/to/ca.pem ./setup-gateway-trusted-ca.sh  # custom bundle

set -euo pipefail

NAMESPACE="${NAMESPACE:-ambient-code}"
CONFIGMAP_NAME="gateway-trusted-ca"
CA_KEY="ca-bundle.crt"

# Allow override with a pre-built CA bundle file
if [ -n "${GATEWAY_CA_BUNDLE_PATH:-}" ]; then
  echo "Using custom CA bundle from ${GATEWAY_CA_BUNDLE_PATH}"
  kubectl create configmap "$CONFIGMAP_NAME" \
    --namespace="$NAMESPACE" \
    --from-file="${CA_KEY}=${GATEWAY_CA_BUNDLE_PATH}" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "gateway-trusted-ca ConfigMap created in ${NAMESPACE}"
  exit 0
fi

# Auto-detect OpenShift by checking for route.openshift.io API
if ! kubectl api-resources --api-group=route.openshift.io >/dev/null 2>&1; then
  echo "Not an OpenShift cluster and no GATEWAY_CA_BUNDLE_PATH set — skipping gateway-trusted-ca setup"
  exit 0
fi

echo "OpenShift detected — extracting ingress CA for gateway trust bundle..."

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Step 1: Get the system CA bundle via OpenShift's inject-trusted-cabundle annotation
echo "  Requesting system CA bundle from OpenShift..."
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: gateway-system-ca-temp
  namespace: ${NAMESPACE}
  labels:
    config.openshift.io/inject-trusted-cabundle: "true"
data: {}
EOF

# Wait for the CA bundle to be injected (up to 15s)
for i in $(seq 1 15); do
  BUNDLE_LEN=$(kubectl get configmap gateway-system-ca-temp -n "$NAMESPACE" \
    -o jsonpath='{.data.ca-bundle\.crt}' 2>/dev/null | wc -c || echo "0")
  if [ "$BUNDLE_LEN" -gt 100 ]; then
    break
  fi
  sleep 1
done

if [ "$BUNDLE_LEN" -lt 100 ]; then
  echo "  Warning: system CA bundle injection timed out, using ingress CA only"
  SYSTEM_BUNDLE=""
else
  kubectl get configmap gateway-system-ca-temp -n "$NAMESPACE" \
    -o jsonpath='{.data.ca-bundle\.crt}' > "$TMPDIR/system-ca.pem"
  SYSTEM_BUNDLE="$TMPDIR/system-ca.pem"
  echo "  System CA bundle retrieved ($(grep -c 'BEGIN CERTIFICATE' "$SYSTEM_BUNDLE") certificates)"
fi

# Clean up temp ConfigMap
kubectl delete configmap gateway-system-ca-temp -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1

# Step 2: Extract the ingress operator's CA
echo "  Extracting ingress CA from router-ca Secret..."
kubectl get secret router-ca -n openshift-ingress-operator \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > "$TMPDIR/ingress-ca.pem"
INGRESS_SUBJECT=$(openssl x509 -in "$TMPDIR/ingress-ca.pem" -noout -subject 2>/dev/null || echo "unknown")
echo "  Ingress CA: ${INGRESS_SUBJECT}"

# Step 3: Combine into a single bundle
if [ -n "$SYSTEM_BUNDLE" ]; then
  cat "$SYSTEM_BUNDLE" "$TMPDIR/ingress-ca.pem" > "$TMPDIR/combined-ca.pem"
else
  cp "$TMPDIR/ingress-ca.pem" "$TMPDIR/combined-ca.pem"
fi

TOTAL_CERTS=$(grep -c 'BEGIN CERTIFICATE' "$TMPDIR/combined-ca.pem")
echo "  Combined CA bundle: ${TOTAL_CERTS} certificates"

# Step 4: Create the ConfigMap
kubectl create configmap "$CONFIGMAP_NAME" \
  --namespace="$NAMESPACE" \
  --from-file="${CA_KEY}=$TMPDIR/combined-ca.pem" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "gateway-trusted-ca ConfigMap created in ${NAMESPACE} (${TOTAL_CERTS} certificates)"
