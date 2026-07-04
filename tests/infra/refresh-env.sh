#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

echo "======================================"
echo "Refreshing Kind Environment"
echo "======================================"

# Load .env if it exists
if [ ! -f ".env" ]; then
  echo "⚠️  No .env file found - nothing to refresh"
  echo "   Create tests/infra/.env to override images or add API keys"
  exit 0
fi

source .env

echo "Loading configuration from .env..."

# Update runner secrets if ANTHROPIC_API_KEY changed
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo ""
  echo "Updating ANTHROPIC_API_KEY in ambient-runner-secrets..."
  kubectl create secret generic ambient-runner-secrets \
    -n ambient-code \
    --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
    --dry-run=client -o yaml | kubectl apply --validate=false -f -
  echo "   ✅ Secret updated"
fi

# Update deployment images if IMAGE_* vars are set
UPDATED_DEPLOYMENTS=()

if [ -n "${IMAGE_API_SERVER:-}" ]; then
  echo ""
  echo "Updating api-server image to: ${IMAGE_API_SERVER}"
  kubectl set image -n ambient-code deployment/ambient-api-server api-server="${IMAGE_API_SERVER}"
  UPDATED_DEPLOYMENTS+=("ambient-api-server")
fi

if [ -n "${IMAGE_UI:-}" ]; then
  echo ""
  echo "Updating ambient-ui image to: ${IMAGE_UI}"
  kubectl set image -n ambient-code deployment/ambient-ui ambient-ui="${IMAGE_UI}"
  UPDATED_DEPLOYMENTS+=("ambient-ui")
fi

if [ -n "${IMAGE_CONTROL_PLANE:-}" ]; then
  echo ""
  echo "Updating control-plane image to: ${IMAGE_CONTROL_PLANE}"
  kubectl set image -n ambient-code deployment/ambient-control-plane ambient-control-plane="${IMAGE_CONTROL_PLANE}"
  UPDATED_DEPLOYMENTS+=("ambient-control-plane")
fi

# Update runner/state-sync via control-plane env vars
if [ -n "${IMAGE_RUNNER:-}" ] || [ -n "${IMAGE_STATE_SYNC:-}" ]; then
  echo ""
  [ -n "${IMAGE_RUNNER:-}" ] && echo "Updating runner image to: ${IMAGE_RUNNER}"
  [ -n "${IMAGE_STATE_SYNC:-}" ] && echo "Updating state-sync image to: ${IMAGE_STATE_SYNC}"

  ENV_PATCH=""
  [ -n "${IMAGE_RUNNER:-}" ] && ENV_PATCH="${ENV_PATCH} AMBIENT_CODE_RUNNER_IMAGE=${IMAGE_RUNNER}"
  [ -n "${IMAGE_STATE_SYNC:-}" ] && ENV_PATCH="${ENV_PATCH} STATE_SYNC_IMAGE=${IMAGE_STATE_SYNC}"

  kubectl set env -n ambient-code deployment/ambient-control-plane $ENV_PATCH
  UPDATED_DEPLOYMENTS+=("ambient-control-plane")
fi

# Restart updated deployments if any
if [ ${#UPDATED_DEPLOYMENTS[@]} -gt 0 ]; then
  echo ""
  echo "Restarting updated deployments..."
  for deployment in "${UPDATED_DEPLOYMENTS[@]}"; do
    kubectl rollout restart -n ambient-code deployment/$deployment
    echo "   ✅ Restarted $deployment"
  done
else
  echo ""
  echo "⚠️  No image overrides found in .env"
  echo "   Set IMAGE_API_SERVER, IMAGE_UI, IMAGE_CONTROL_PLANE, IMAGE_RUNNER, or IMAGE_STATE_SYNC"
fi

echo ""
echo "✅ Environment refreshed!"
