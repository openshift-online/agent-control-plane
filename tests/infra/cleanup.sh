#!/bin/bash
set -euo pipefail

echo "======================================"
echo "Cleaning up Ambient Kind Cluster"
echo "======================================"

# Cluster name (override via env var for multi-worktree support)
KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-ambient-local}"

# Detect container runtime (same logic as setup-kind.sh)
CONTAINER_ENGINE="${CONTAINER_ENGINE:-}"

if [ -z "$CONTAINER_ENGINE" ]; then
  if command -v docker &> /dev/null && docker ps &> /dev/null 2>&1; then
    CONTAINER_ENGINE="docker"
  elif command -v podman &> /dev/null && podman ps &> /dev/null 2>&1; then
    CONTAINER_ENGINE="podman"
  fi
fi

# Set KIND_EXPERIMENTAL_PROVIDER if using Podman
if [ "$CONTAINER_ENGINE" = "podman" ]; then
  export KIND_EXPERIMENTAL_PROVIDER=podman
fi

echo ""
echo "Deleting kind cluster '${KIND_CLUSTER_NAME}'..."
# Try to delete regardless of provider -- kind delete is idempotent and
# the cluster may have been created with a different CONTAINER_ENGINE
# than the current default.  Check both docker and podman providers.
deleted=false
if kind delete cluster --name "$KIND_CLUSTER_NAME" 2>/dev/null; then
  deleted=true
fi
if [ "$deleted" = false ] && [ "$CONTAINER_ENGINE" != "podman" ]; then
  # Cluster might have been created with podman
  if KIND_EXPERIMENTAL_PROVIDER=podman kind delete cluster --name "$KIND_CLUSTER_NAME" 2>/dev/null; then
    deleted=true
  fi
fi
if [ "$deleted" = false ] && [ "$CONTAINER_ENGINE" = "podman" ]; then
  # Cluster might have been created with docker
  if KIND_EXPERIMENTAL_PROVIDER="" kind delete cluster --name "$KIND_CLUSTER_NAME" 2>/dev/null; then
    deleted=true
  fi
fi
if [ "$deleted" = true ]; then
  echo "   Cluster deleted"
else
  echo "   Cluster '${KIND_CLUSTER_NAME}' not found (already deleted?)"
fi

# kind delete sometimes leaves the kindest container behind in podman.
# Force-remove any leftover container whose name matches the kind node pattern.
KIND_CONTAINER="${KIND_CLUSTER_NAME}-control-plane"
if command -v podman &> /dev/null && podman container exists "$KIND_CONTAINER" 2>/dev/null; then
  echo "   Removing leftover podman container '${KIND_CONTAINER}'..."
  podman rm -f "$KIND_CONTAINER" >/dev/null 2>&1 || true
  echo "   Removed"
fi

echo ""
echo "Cleaning up test artifacts..."
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CYPRESS_DIR="${REPO_ROOT}/tests/cypress"
cd "$CYPRESS_DIR" 2>/dev/null || true
if [ -f .env.test ]; then
  rm .env.test
  echo "   Removed .env.test"
fi

# Only clean screenshots/videos if CLEANUP_ARTIFACTS=true (for CI)
# Keep them locally for debugging
if [ "${CLEANUP_ARTIFACTS:-false}" = "true" ]; then
  if [ -d "$CYPRESS_DIR/cypress/screenshots" ]; then
    rm -rf "$CYPRESS_DIR/cypress/screenshots"
    echo "   Removed Cypress screenshots"
  fi

  if [ -d "$CYPRESS_DIR/cypress/videos" ]; then
    rm -rf "$CYPRESS_DIR/cypress/videos"
    echo "   Removed Cypress videos"
  fi
else
  if [ -d "$CYPRESS_DIR/cypress/screenshots" ] || [ -d "$CYPRESS_DIR/cypress/videos" ]; then
    echo "   Keeping screenshots/videos for review"
    echo "   To remove: rm -rf tests/cypress/cypress/screenshots tests/cypress/cypress/videos"
  fi
fi

echo ""
echo "Cleanup complete!"
