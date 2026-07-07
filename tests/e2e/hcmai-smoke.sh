#!/usr/bin/env bash
# hcmai-smoke.sh — E2E smoke test against the hcmai OpenShift cluster
#
# Wraps smoke-test-llm.sh with hcmai-specific OIDC + Vertex credentials.
# Reads secrets from the ambient-code-gitops repo and the hcmai Keycloak
# OIDC client embedded in the ambient-api namespace.
#
# Usage:
#   ./tests/e2e/hcmai-smoke.sh                    # full run with cleanup
#   SKIP_CLEANUP=1 ./tests/e2e/hcmai-smoke.sh     # preserve resources
#   USE_EXISTING_PROJECT=1 PROJECT_NAME=mturansk ./tests/e2e/hcmai-smoke.sh
#
# Prerequisites:
#   - acpctl on PATH
#   - oc authenticated to hcmai cluster
#   - ambient-code-gitops repo cloned at the conventional path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

GITOPS_SECRETS="${GITOPS_SECRETS:-$HOME/projects/src/gitlab.cee.redhat.com/ambient-code/ambient-code-gitops/.secrets}"

if [[ ! -d "$GITOPS_SECRETS" ]]; then
  echo "error: secrets dir not found: $GITOPS_SECRETS" >&2
  echo "  clone ambient-code-gitops or set GITOPS_SECRETS=/path/to/.secrets" >&2
  exit 1
fi

if [[ ! -f "$GITOPS_SECRETS/VERTEX_SA_KEY" ]]; then
  echo "error: VERTEX_SA_KEY not found in $GITOPS_SECRETS" >&2
  exit 1
fi

OC_CONTEXT="${OC_CONTEXT:-ambient-code/api-hcmais01ue1-s9m2-p3-openshiftapps-com:443/mturansk}"

OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-}"
OIDC_CLIENT_SECRET="${OIDC_CLIENT_SECRET:-}"

if [[ -z "$OIDC_CLIENT_ID" || -z "$OIDC_CLIENT_SECRET" ]]; then
  if command -v oc &>/dev/null; then
    OIDC_CLIENT_ID=$(oc --context "$OC_CONTEXT" -n ambient-api \
      get secret ambient-control-plane-oidc \
      -o jsonpath='{.data.client-id}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
    OIDC_CLIENT_SECRET=$(oc --context "$OC_CONTEXT" -n ambient-api \
      get secret ambient-control-plane-oidc \
      -o jsonpath='{.data.client-secret}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  fi
fi

if [[ -z "$OIDC_CLIENT_ID" || -z "$OIDC_CLIENT_SECRET" ]]; then
  echo "error: could not resolve OIDC credentials from cluster secret" >&2
  echo "  set OIDC_CLIENT_ID and OIDC_CLIENT_SECRET, or ensure oc is authenticated" >&2
  exit 1
fi

export API_URL="${API_URL:-https://ambient-api-server-ambient-api.apps.rosa.hcmais01ue1.s9m2.p3.openshiftapps.com}"
export OIDC_CLIENT_ID
export OIDC_CLIENT_SECRET
export OIDC_ISSUER_URL="${OIDC_ISSUER_URL:-https://keycloak-ambient-keycloak.apps.rosa.hcmais01ue1.s9m2.p3.openshiftapps.com/realms/ambient-code}"
export VERTEX_SA_KEY_FILE="$GITOPS_SECRETS/VERTEX_SA_KEY"
export SESSION_READY_TIMEOUT="${SESSION_READY_TIMEOUT:-180}"
export LLM_RESPONSE_TIMEOUT="${LLM_RESPONSE_TIMEOUT:-180}"

unset TEST_TOKEN

exec "$SCRIPT_DIR/smoke-test-llm.sh" "$@"
