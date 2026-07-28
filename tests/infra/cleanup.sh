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
deleted=false
if [ "${DOCKER_ONLY_KIND_CLUSTER:-false}" = "true" ]; then
  # The demo adapter must never delete by a reusable cluster name. It passes
  # the immutable Docker IDs witnessed immediately after kind-up. Re-enumerate
  # the exact label now and delete only still-present members of that witness.
  EXPECTED_KIND_CONTAINER_IDS="${EXPECTED_KIND_CONTAINER_IDS:-}"
  if [ "$CONTAINER_ENGINE" != "docker" ]; then
    echo "   Refusing cross-provider cleanup for Docker-owned cluster '${KIND_CLUSTER_NAME}'"
    exit 1
  fi
  if [ -z "$EXPECTED_KIND_CONTAINER_IDS" ]; then
    echo "   Refusing Docker-only cleanup without exact container identities"
    exit 1
  fi
  IFS=',' read -r -a expected_ids <<< "$EXPECTED_KIND_CONTAINER_IDS"
  for container_id in "${expected_ids[@]}"; do
    if [[ ! "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
      echo "   Refusing invalid expected container identity"
      exit 1
    fi
  done
  current_ids=()
  current_id_count=0
  while IFS= read -r container_id; do
    if [ -n "$container_id" ]; then
      current_ids+=("$container_id")
      current_id_count=$((current_id_count + 1))
    fi
  done < <(
    docker ps --all --no-trunc \
      --filter "label=io.x-k8s.kind.cluster=${KIND_CLUSTER_NAME}" \
      --format '{{.ID}}' | LC_ALL=C sort
  )
  sorted_expected_ids=()
  while IFS= read -r container_id; do
    [ -n "$container_id" ] && sorted_expected_ids+=("$container_id")
  done < <(printf '%s\n' "${expected_ids[@]}" | LC_ALL=C sort)
  expected_ids=("${sorted_expected_ids[@]}")
  if [ "$current_id_count" -gt 0 ]; then
    for container_id in "${current_ids[@]}"; do
      witnessed=false
      for expected_id in "${expected_ids[@]}"; do
        if [ "$container_id" = "$expected_id" ]; then
          witnessed=true
          break
        fi
      done
      if [ "$witnessed" != "true" ]; then
        echo "   Refusing cleanup because a current container identity is outside the creation witness"
        exit 1
      fi
    done
    # A previous exact cleanup attempt may have removed only a subset before a
    # later kubeconfig operation failed. Delete only the still-present IDs from
    # the immutable creation witness; an empty set is already container-clean.
    docker rm --force --volumes -- "${current_ids[@]}" >/dev/null
  fi
  owned_kube_identity="kind-${KIND_CLUSTER_NAME}"
  # KUBECONFIG may be unset under `set -u`; only prune kubeconfig entries when a
  # path is provided. Container removal above already made the cluster clean.
  kubeconfig_path="${KUBECONFIG:-}"
  if [ -n "$kubeconfig_path" ]; then
    contexts="$(kubectl --kubeconfig "$kubeconfig_path" config get-contexts -o name)"
    clusters="$(kubectl --kubeconfig "$kubeconfig_path" config get-clusters)"
    users="$(kubectl --kubeconfig "$kubeconfig_path" config get-users)"
    if printf '%s\n' "$contexts" | grep -Fqx -- "$owned_kube_identity"; then
      kubectl --kubeconfig "$kubeconfig_path" config delete-context "$owned_kube_identity" >/dev/null
    fi
    if printf '%s\n' "$clusters" | grep -Fqx -- "$owned_kube_identity"; then
      kubectl --kubeconfig "$kubeconfig_path" config delete-cluster "$owned_kube_identity" >/dev/null
    fi
    if printf '%s\n' "$users" | grep -Fqx -- "$owned_kube_identity"; then
      kubectl --kubeconfig "$kubeconfig_path" config delete-user "$owned_kube_identity" >/dev/null
    fi
  else
    echo "   KUBECONFIG unset; skipping kubeconfig entry cleanup for '${owned_kube_identity}'"
  fi
  deleted=true
else
  # General developer cleanup keeps the historical provider fallback. The
  # strict demo path above never enters this name-based branch.
  if kind delete cluster --name "$KIND_CLUSTER_NAME" 2>/dev/null; then
    deleted=true
  fi
fi
if [ "$deleted" = false ] && [ "${DOCKER_ONLY_KIND_CLUSTER:-false}" != "true" ] && [ "$CONTAINER_ENGINE" != "podman" ]; then
  # Cluster might have been created with podman
  if KIND_EXPERIMENTAL_PROVIDER=podman kind delete cluster --name "$KIND_CLUSTER_NAME" 2>/dev/null; then
    deleted=true
  fi
fi
if [ "$deleted" = false ] && [ "${DOCKER_ONLY_KIND_CLUSTER:-false}" != "true" ] && [ "$CONTAINER_ENGINE" = "podman" ]; then
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
if [ "${DOCKER_ONLY_KIND_CLUSTER:-false}" != "true" ] && command -v podman &> /dev/null && podman container exists "$KIND_CONTAINER" 2>/dev/null; then
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
