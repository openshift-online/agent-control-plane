#!/usr/bin/env bash
# Set up Kubernetes Gateway API prerequisites for OpenShell gateway exposure.
#
# Creates a networking Gateway in openshift-ingress that GRPCRoutes from
# tenant namespaces reference via parentRefs. The Gateway uses an HTTPS
# listener with a self-signed wildcard certificate so that clients connect
# via TLS and HTTP/2 is negotiated through ALPN. BackendTLSPolicy handles
# re-encryption to the backend pod.
#
# On CRC (OpenShift Local), a passthrough Route bridges the default
# OpenShift router to the Gateway API pod, simulating the L4 TCP
# LoadBalancer that a production cluster would provide.
#
# Requires: oc CLI logged in to an OpenShift 4.22+ cluster with Gateway API.
#
# Usage:
#   ./setup-gateway-api.sh
#   GATEWAY_API_BASE_DOMAIN=apps.example.com ./setup-gateway-api.sh

set -euo pipefail

GATEWAY_NAME="${GATEWAY_API_GATEWAY_NAME:-acpgw}"
GATEWAY_NAMESPACE="${GATEWAY_API_GATEWAY_NAMESPACE:-openshift-ingress}"
TLS_SECRET_NAME="${GATEWAY_NAME}-tls"

if [ -n "${GATEWAY_API_BASE_DOMAIN:-}" ]; then
  BASE_DOMAIN="$GATEWAY_API_BASE_DOMAIN"
else
  BASE_DOMAIN=$(oc get ingresses.config.openshift.io cluster -o jsonpath='{.spec.domain}' 2>/dev/null || echo "")
  if [ -z "$BASE_DOMAIN" ]; then
    echo "ERROR: Could not detect cluster base domain. Set GATEWAY_API_BASE_DOMAIN."
    exit 1
  fi
fi

WILDCARD_HOST="*.acpgw.${BASE_DOMAIN}"

echo "Setting up Gateway API prerequisites..."
echo "  Gateway:    ${GATEWAY_NAME} in ${GATEWAY_NAMESPACE}"
echo "  Hostname:   ${WILDCARD_HOST}"
echo "  TLS:        ${TLS_SECRET_NAME}"

# Create GatewayClass if it doesn't exist (required on OpenShift 4.19+)
echo "Ensuring GatewayClass openshift-default exists..."
if ! oc get gatewayclass openshift-default >/dev/null 2>&1; then
  echo "  Creating GatewayClass openshift-default..."
  cat <<GCEOF | oc apply -f -
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: openshift-default
spec:
  controllerName: openshift.io/gateway-controller/v1
GCEOF
  echo "  Waiting for istiod-openshift-gateway deployment..."
  for i in $(seq 1 120); do
    if oc get deployment istiod-openshift-gateway -n openshift-ingress >/dev/null 2>&1; then
      oc rollout status deployment/istiod-openshift-gateway -n openshift-ingress --timeout=120s 2>&1 || true
      break
    fi
    if [ "$i" -eq 120 ]; then
      echo "WARNING: istiod-openshift-gateway deployment not found after 120s"
    fi
    sleep 1
  done
fi
ACCEPTED=$(oc get gatewayclass openshift-default -o jsonpath='{.status.conditions[?(@.type=="Accepted")].status}' 2>/dev/null || echo "")
if [ "$ACCEPTED" != "True" ]; then
  echo "  Waiting for GatewayClass to be accepted..."
  for i in $(seq 1 60); do
    ACCEPTED=$(oc get gatewayclass openshift-default -o jsonpath='{.status.conditions[?(@.type=="Accepted")].status}' 2>/dev/null || echo "")
    if [ "$ACCEPTED" = "True" ]; then
      break
    fi
    if [ "$i" -eq 60 ]; then
      echo "WARNING: GatewayClass not yet Accepted after 60s (will continue)"
    fi
    sleep 1
  done
fi
echo "  GatewayClass openshift-default: ${ACCEPTED:-pending}"

# Generate a CA + leaf wildcard TLS certificate for the Gateway listener.
# CRC-only: production clusters use cert-manager or a corporate CA.
# A proper CA → leaf chain is required because the openshell client
# rejects self-signed certs with CA:TRUE (CaUsedAsEndEntity) and can't
# trust self-signed certs with CA:FALSE (UnknownIssuer).
echo "Ensuring TLS certificate for ${WILDCARD_HOST}..."
CA_SECRET_NAME="${GATEWAY_NAME}-ca"
if oc get secret "${TLS_SECRET_NAME}" -n "${GATEWAY_NAMESPACE}" >/dev/null 2>&1; then
  echo "  TLS secret ${TLS_SECRET_NAME} already exists — skipping"
else
  TMPDIR=$(mktemp -d)
  trap 'rm -rf "$TMPDIR"' EXIT

  # 1. Generate a CA cert (self-signed, CA:TRUE)
  openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "${TMPDIR}/ca.key" -out "${TMPDIR}/ca.crt" -days 365 \
    -subj "/CN=acpgw-ca" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

  # 2. Generate a leaf cert signed by the CA
  openssl req -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "${TMPDIR}/tls.key" -out "${TMPDIR}/tls.csr" \
    -subj "/CN=acpgw" \
    -addext "subjectAltName=DNS:${WILDCARD_HOST}" 2>/dev/null
  openssl x509 -req -in "${TMPDIR}/tls.csr" \
    -CA "${TMPDIR}/ca.crt" -CAkey "${TMPDIR}/ca.key" -CAcreateserial \
    -out "${TMPDIR}/tls.crt" -days 365 \
    -extfile <(printf "subjectAltName=DNS:%s\nbasicConstraints=critical,CA:FALSE" "${WILDCARD_HOST}") 2>/dev/null

  oc create secret tls "${TLS_SECRET_NAME}" -n "${GATEWAY_NAMESPACE}" \
    --cert="${TMPDIR}/tls.crt" --key="${TMPDIR}/tls.key"
  oc create secret generic "${CA_SECRET_NAME}" -n "${GATEWAY_NAMESPACE}" \
    --from-file=ca.crt="${TMPDIR}/ca.crt"
  echo "  Created TLS secret ${TLS_SECRET_NAME} and CA secret ${CA_SECRET_NAME}"

  # 3. Print instructions for downloading and trusting the CA certs.
  # CRC uses self-signed CAs — the user must install them into their
  # system trust store before acpctl/openshell will trust the gateway.
  echo ""
  echo "  Download CRC CA certs and install into your system trust store:"
  echo ""
  echo "    oc get secret ${CA_SECRET_NAME} -n ${GATEWAY_NAMESPACE} -o jsonpath='{.data.ca\\.crt}' | base64 -d > crc-ca-bundle.crt"
  echo "    oc get secret router-ca -n openshift-ingress-operator -o jsonpath='{.data.tls\\.crt}' | base64 -d >> crc-ca-bundle.crt"
  echo ""
  echo "    # Fedora / RHEL / CentOS"
  echo "    sudo cp crc-ca-bundle.crt /etc/pki/ca-trust/source/anchors/crc-ca-bundle.crt"
  echo "    sudo update-ca-trust"
  echo ""
  echo "    # macOS"
  echo "    sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain crc-ca-bundle.crt"
fi

# Create/update the networking Gateway
echo "Creating networking Gateway ${GATEWAY_NAME}..."
cat <<EOF | oc apply -f -
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: ${GATEWAY_NAME}
  namespace: ${GATEWAY_NAMESPACE}
  labels:
    app.kubernetes.io/name: openshell
    app.kubernetes.io/component: gateway-api
    app.kubernetes.io/managed-by: agent-control-plane
spec:
  gatewayClassName: openshift-default
  listeners:
  - name: grpc
    hostname: "${WILDCARD_HOST}"
    port: 443
    protocol: HTTPS
    tls:
      mode: Terminate
      certificateRefs:
      - name: ${TLS_SECRET_NAME}
        kind: Secret
    allowedRoutes:
      namespaces:
        from: All
EOF

# Wait for Gateway to be accepted
echo "Waiting for Gateway to be accepted..."
for i in $(seq 1 30); do
  STATUS=$(oc get gateway "${GATEWAY_NAME}" -n "${GATEWAY_NAMESPACE}" \
    -o jsonpath='{.status.conditions[?(@.type=="Accepted")].status}' 2>/dev/null || echo "")
  if [ "$STATUS" = "True" ]; then
    echo "  Gateway ${GATEWAY_NAME}: Accepted"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "WARNING: Gateway not yet accepted after 30s (will continue, may accept later)"
  fi
  sleep 1
done

ADDRESSES=$(oc get gateway "${GATEWAY_NAME}" -n "${GATEWAY_NAMESPACE}" \
  -o jsonpath='{.status.addresses[*].value}' 2>/dev/null || echo "")
if [ -n "$ADDRESSES" ]; then
  echo "  Gateway addresses: ${ADDRESSES}"
fi

# CRC-only: the Gateway's LoadBalancer stays <pending> because CRC has no
# cloud LB provisioner.  Create a passthrough Route so the default OpenShift
# router (HAProxy) forwards raw TCP to the Gateway API pod, simulating an
# L4 LB.  In a real deployment this Route is unnecessary — the cloud LB
# handles it.
GW_SVC="${GATEWAY_NAME}-openshift-default"
if oc get svc "${GW_SVC}" -n "${GATEWAY_NAMESPACE}" >/dev/null 2>&1; then
  LB_IP=$(oc get svc "${GW_SVC}" -n "${GATEWAY_NAMESPACE}" \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
  if [ -z "$LB_IP" ]; then
    echo "LoadBalancer pending (CRC-only) — creating passthrough Route bridge..."
    echo "  (In production, a cloud LoadBalancer replaces this Route)"

    # The default IngressController rejects wildcardPolicy: Subdomain routes.
    # Patch it to allow them — this is safe on CRC dev clusters.
    echo "  Enabling wildcard route admission on default IngressController..."
    oc patch ingresscontroller default -n openshift-ingress-operator \
      --type=merge \
      -p '{"spec":{"routeAdmission":{"wildcardPolicy":"WildcardsAllowed"}}}'

    cat <<RTEOF | oc apply -f -
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: ${GATEWAY_NAME}-grpc-bridge
  namespace: ${GATEWAY_NAMESPACE}
  labels:
    app.kubernetes.io/name: openshell
    app.kubernetes.io/component: gateway-api
    app.kubernetes.io/managed-by: agent-control-plane
spec:
  host: "wildcard.acpgw.${BASE_DOMAIN}"
  wildcardPolicy: Subdomain
  to:
    kind: Service
    name: ${GW_SVC}
    weight: 100
  port:
    targetPort: grpc
  tls:
    termination: passthrough
RTEOF
    echo "  Passthrough Route ${GATEWAY_NAME}-grpc-bridge created"
  fi
fi

echo "Gateway API prerequisites ready."
