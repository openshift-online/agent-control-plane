#!/usr/bin/env bash
# Setup SSO configuration for Kind cluster with port-forwarded Keycloak
# This script patches the sso-credentials secret and keycloak deployment
# to use the correct localhost ports for local development.

set -euo pipefail

NAMESPACE="${NAMESPACE:-ambient-code}"
KIND_FWD_AMBIENT_UI_PORT="${KIND_FWD_AMBIENT_UI_PORT:-14856}"
KIND_FWD_KEYCLOAK_PORT="${KIND_FWD_KEYCLOAK_PORT:-18856}"

# Check if secret exists
if ! kubectl get secret sso-credentials -n "$NAMESPACE" >/dev/null 2>&1; then
  echo "Error: sso-credentials secret not found in namespace $NAMESPACE"
  echo "Run 'kubectl apply -k components/manifests/overlays/kind/' first"
  exit 1
fi

# Patch SSO credentials with port-forwarded URLs
KC_ISSUER="http://keycloak-service.ambient-code.svc.cluster.local:11880/realms/ambient-code"
kubectl patch secret sso-credentials -n "$NAMESPACE" --type=json -p="[
  {
    \"op\": \"add\",
    \"path\": \"/data/SSO_FRONTEND_ISSUER_URL\",
    \"value\": \"$(echo -n "$KC_ISSUER" | base64 -w0)\"
  },
  {
    \"op\": \"add\",
    \"path\": \"/data/SSO_REDIRECT_URI\",
    \"value\": \"$(echo -n "http://localhost:${KIND_FWD_AMBIENT_UI_PORT}/api/auth/sso/callback" | base64 -w0)\"
  }
]" >/dev/null

# Patch KC_HOSTNAME so the OIDC issuer uses the cluster-internal FQDN.
# Developers add /etc/hosts: 127.0.0.1 keycloak-service.ambient-code.svc.cluster.local
# to reach Keycloak from the host via the same URL used in-cluster.
# Only patch if the value changed to avoid unnecessary restarts.
DESIRED_KC_HOSTNAME="http://keycloak-service.ambient-code.svc.cluster.local:11880"
CURRENT_KC_HOSTNAME=$(kubectl get deployment/keycloak -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="KC_HOSTNAME")].value}' 2>/dev/null || true)

if [ "$CURRENT_KC_HOSTNAME" != "$DESIRED_KC_HOSTNAME" ]; then
  kubectl set env deployment/keycloak -n "$NAMESPACE" \
    KC_HOSTNAME="$DESIRED_KC_HOSTNAME" >/dev/null
  echo "Waiting for Keycloak restart..."
  kubectl rollout status deployment/keycloak -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
fi
