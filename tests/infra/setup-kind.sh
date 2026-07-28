#!/bin/bash
set -euo pipefail

echo "=================================================="
echo "Setting up kind cluster for Agent Control Plane"
echo "=================================================="

# Cluster name (override via env var for multi-worktree support)
KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-ambient-local}"

# Detect container runtime (prefer explicit CONTAINER_ENGINE, then Docker, then Podman)
CONTAINER_ENGINE="${CONTAINER_ENGINE:-}"

if [ -z "$CONTAINER_ENGINE" ]; then
  if command -v docker &> /dev/null && docker ps &> /dev/null 2>&1; then
    CONTAINER_ENGINE="docker"
  elif command -v podman &> /dev/null; then
    CONTAINER_ENGINE="podman"
  else
    echo "Error: Neither Docker nor Podman found or running"
    echo "   Please install and start Docker or Podman"
    echo "   Docker: https://docs.docker.com/get-docker/"
    echo "   Podman: brew install podman && podman machine init && podman machine start"
    exit 1
  fi
fi

echo "Using container runtime: $CONTAINER_ENGINE"

# Configure kind to use Podman if selected
if [ "$CONTAINER_ENGINE" = "podman" ]; then
  export KIND_EXPERIMENTAL_PROVIDER=podman
  echo "   Set KIND_EXPERIMENTAL_PROVIDER=podman"

  # Verify Podman is running
  if ! podman ps &> /dev/null; then
    echo "Podman is installed but not running"
    echo "   Start it with: podman machine start"
    exit 1
  fi
fi

# Check if kind cluster already exists
if kind get clusters 2>/dev/null | grep -q "^${KIND_CLUSTER_NAME}$"; then
  if [ "${REQUIRE_NEW_KIND_CLUSTER:-false}" = "true" ]; then
    echo "Refusing to reuse pre-existing Kind cluster '${KIND_CLUSTER_NAME}'"
    exit 1
  fi
  echo "Kind cluster '${KIND_CLUSTER_NAME}' already exists — skipping creation"
  kubectl config use-context "kind-${KIND_CLUSTER_NAME}" >/dev/null 2>&1 || true
  echo "Returning control to the Makefile for platform deployment..."
  exit 0
fi

echo ""
echo "Creating kind cluster '${KIND_CLUSTER_NAME}'..."

# Port defaults: use env vars if set, otherwise pick based on container engine
if [ "$CONTAINER_ENGINE" = "podman" ]; then
  HTTP_PORT="${KIND_HTTP_PORT:-8080}"
  HTTPS_PORT="${KIND_HTTPS_PORT:-8443}"
  echo "   Using ports ${HTTP_PORT}/${HTTPS_PORT} (Podman rootless compatibility)"
else
  HTTP_PORT="${KIND_HTTP_PORT:-80}"
  HTTPS_PORT="${KIND_HTTPS_PORT:-443}"
  echo "   Using ports ${HTTP_PORT}/${HTTPS_PORT} (Docker standard ports)"
fi

API_SERVER_ADDRESS="127.0.0.1"
CERT_SAN_PATCH=""
if [ -n "${KIND_HOST:-}" ]; then
  API_SERVER_ADDRESS="0.0.0.0"
  CERT_SAN_PATCH="  kubeadmConfigPatches:
  - |
    kind: ClusterConfiguration
    apiServer:
      certSANs:
      - ${KIND_HOST}"
  echo "   API server binding to 0.0.0.0 (remote access via ${KIND_HOST})"
fi

strict_kind_creation=false
kind_create_status=0
kind_create_started=false
kind_preflight_empty=false
kind_cleanup_discovery_allowed=false
kind_creation_started_at=""
kind_creation_pre_ids_file=""
kind_creation_events_file=""
kind_creation_ids_file=""
kind_final_ids_file=""
kind_proof_publish_file=""
kind_cleanup_armed=false
kind_cleanup_ids=()
cleanup_kind_creation_files() {
  [ -z "$kind_creation_pre_ids_file" ] || rm -f -- "$kind_creation_pre_ids_file"
  [ -z "$kind_creation_events_file" ] || rm -f -- "$kind_creation_events_file"
  [ -z "$kind_creation_ids_file" ] || rm -f -- "$kind_creation_ids_file"
  [ -z "$kind_final_ids_file" ] || rm -f -- "$kind_final_ids_file"
  [ -z "$kind_proof_publish_file" ] || rm -f -- "$kind_proof_publish_file"
}
cleanup_kind_creation_on_exit() {
  local status=$?
  if [ "$kind_cleanup_armed" != "true" ] \
    && [ "$strict_kind_creation" = "true" ] \
    && [ "$kind_preflight_empty" = "true" ] \
    && [ "$kind_create_started" = "true" ] \
    && [ "$kind_cleanup_discovery_allowed" = "true" ]; then
    recover_interrupted_kind_creation
  fi
  if [ "$kind_cleanup_armed" = "true" ]; then
    # If termination lands immediately after the hard-link operation, the
    # staging and final names prove that the complete inode was committed.
    if [ -n "$kind_proof_publish_file" ] \
      && [ -e "$KIND_CREATION_PROOF_FILE" ] \
      && [ "$kind_proof_publish_file" -ef "$KIND_CREATION_PROOF_FILE" ]; then
      kind_cleanup_armed=false
    else
      if docker rm --force --volumes -- "${kind_cleanup_ids[@]}" >/dev/null; then
        cleanup_partial_kind_kube_identity
      else
        echo "Failed to remove the exact Docker IDs from the incomplete Kind creation" >&2
      fi
    fi
  fi
  cleanup_kind_creation_files
  trap - EXIT
  exit "$status"
}
cleanup_partial_kind_kube_identity() {
  local owned_kube_identity
  [ -n "${KUBECONFIG:-}" ] || return 0
  owned_kube_identity="kind-${KIND_CLUSTER_NAME}"
  kubectl --kubeconfig "$KUBECONFIG" config delete-context "$owned_kube_identity" >/dev/null 2>&1 || true
  kubectl --kubeconfig "$KUBECONFIG" config delete-cluster "$owned_kube_identity" >/dev/null 2>&1 || true
  kubectl --kubeconfig "$KUBECONFIG" config delete-user "$owned_kube_identity" >/dev/null 2>&1 || true
}
recover_interrupted_kind_creation() {
  local container_id container_name cluster_label node_role
  local recovered_ids=()
  if ! docker ps --all --no-trunc \
    --filter "label=io.x-k8s.kind.cluster=${KIND_CLUSTER_NAME}" \
    --format '{{.ID}}' | LC_ALL=C sort -u > "$kind_final_ids_file"; then
    echo "Kind creation evidence is ambiguous; automatic cleanup was not attempted" >&2
    echo "   reason=interrupted post-create Docker inspection failed" >&2
    return 0
  fi
  while IFS= read -r container_id; do
    [ -z "$container_id" ] && continue
    if [[ ! "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
      echo "Kind creation evidence is ambiguous; automatic cleanup was not attempted" >&2
      echo "   reason=interrupted creation returned an invalid Docker identity" >&2
      return 0
    fi
    recovered_ids+=("$container_id")
  done < "$kind_final_ids_file"
  if [ "${#recovered_ids[@]}" -ne 1 ]; then
    echo "Kind creation evidence is ambiguous; automatic cleanup was not attempted" >&2
    echo "   reason=interrupted creation has ${#recovered_ids[@]} generated-label containers" >&2
    return 0
  fi
  container_id="${recovered_ids[0]}"
  if ! container_name="$(docker inspect --format '{{.Name}}' "$container_id")" \
    || ! cluster_label="$(docker inspect --format '{{ index .Config.Labels "io.x-k8s.kind.cluster" }}' "$container_id")" \
    || ! node_role="$(docker inspect --format '{{ index .Config.Labels "io.x-k8s.kind.role" }}' "$container_id")"; then
    echo "Kind creation evidence is ambiguous; automatic cleanup was not attempted" >&2
    echo "   reason=interrupted generated-label container inspection failed" >&2
    return 0
  fi
  if [ "$container_name" != "/${KIND_CLUSTER_NAME}-control-plane" ] \
    || [ "$cluster_label" != "$KIND_CLUSTER_NAME" ] \
    || [ "$node_role" != "control-plane" ]; then
    echo "Kind creation evidence is ambiguous; automatic cleanup was not attempted" >&2
    echo "   reason=interrupted container did not match the exact Kind node boundary" >&2
    return 0
  fi
  kind_cleanup_ids=("$container_id")
  kind_cleanup_armed=true
}
report_ambiguous_kind_creation() {
  local reason="$1"
  local create_count final_count
  kind_cleanup_discovery_allowed=false
  create_count="$(awk 'NF { count += 1 } END { print count + 0 }' "$kind_creation_ids_file")"
  final_count="$(awk 'NF { count += 1 } END { print count + 0 }' "$kind_final_ids_file")"
  echo "Kind creation evidence is ambiguous; automatic cleanup was not attempted" >&2
  echo "   reason=${reason} kind-status=${kind_create_status} create-events=${create_count} final-containers=${final_count}" >&2
}

if [ "${REQUIRE_NEW_KIND_CLUSTER:-false}" = "true" ]; then
  if [ "$CONTAINER_ENGINE" != "docker" ]; then
    echo "Strict Kind creation provenance requires Docker"
    exit 1
  fi
  KIND_CREATION_PROOF_FILE="${KIND_CREATION_PROOF_FILE:?strict Kind creation proof path is required}"
  if [ -e "$KIND_CREATION_PROOF_FILE" ]; then
    echo "Refusing to replace existing Kind creation proof"
    exit 1
  fi
  strict_kind_creation=true
  umask 077
  kind_creation_pre_ids_file="$(mktemp "${KIND_CREATION_PROOF_FILE}.pre.XXXXXX")"
  kind_creation_events_file="$(mktemp "${KIND_CREATION_PROOF_FILE}.events.XXXXXX")"
  kind_creation_ids_file="$(mktemp "${KIND_CREATION_PROOF_FILE}.created.XXXXXX")"
  kind_final_ids_file="$(mktemp "${KIND_CREATION_PROOF_FILE}.final.XXXXXX")"
  trap cleanup_kind_creation_on_exit EXIT
  docker ps --all --no-trunc \
    --filter "label=io.x-k8s.kind.cluster=${KIND_CLUSTER_NAME}" \
    --format '{{.ID}}' | LC_ALL=C sort -u > "$kind_creation_pre_ids_file"
  while IFS= read -r container_id; do
    if [ -n "$container_id" ] && [[ ! "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
      echo "Kind creation preflight returned an invalid Docker container identity"
      exit 1
    fi
  done < "$kind_creation_pre_ids_file"
  if [ -s "$kind_creation_pre_ids_file" ]; then
    echo "Refusing strict Kind creation while same-label Docker containers already exist"
    exit 1
  fi
  kind_preflight_empty=true
  kind_cleanup_discovery_allowed=true
  # Use a deliberately broad lower boundary. Extra matching events make the
  # exact-set check fail closed; they can never expand the ownership proof.
  kind_creation_started_at="$(( $(date +%s) - 1 ))"
fi

kind_create_started=true
cat <<EOF | kind create cluster --name "${KIND_CLUSTER_NAME}" --config=- || kind_create_status=$?
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  apiServerAddress: "${API_SERVER_ADDRESS}"
nodes:
- role: control-plane
${CERT_SAN_PATCH}
  # Kind v0.31.0 default node image
  image: kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f
  extraPortMappings:
  - containerPort: 30080
    hostPort: ${HTTP_PORT}
    protocol: TCP
  - containerPort: 30443
    hostPort: ${HTTPS_PORT}
    protocol: TCP
EOF

if [ "$strict_kind_creation" = "true" ]; then
  # Docker's retained event stream binds the proof to container create events
  # emitted during this exact kind invocation. The upper boundary is also
  # deliberately broad: a racing same-label create or replacement is included
  # and therefore makes the final exact-set comparison fail.
  kind_creation_until="$(( $(date +%s) + 1 ))"
  if ! docker events \
    --since "$kind_creation_started_at" \
    --until "$kind_creation_until" \
    --filter type=container \
    --filter event=create \
    --filter event=destroy \
    --filter "label=io.x-k8s.kind.cluster=${KIND_CLUSTER_NAME}" \
    --format '{{.Action}} {{.Actor.ID}}' > "$kind_creation_events_file"; then
    report_ambiguous_kind_creation "Docker event query failed"
    exit 1
  fi

  saw_destroy=false
  observed_create_count=0
  while IFS=' ' read -r event_action container_id event_extra; do
    if [ -z "$event_action" ] && [ -z "$container_id" ]; then
      continue
    fi
    if [ -n "${event_extra:-}" ] || [[ ! "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
      report_ambiguous_kind_creation "invalid Docker container event"
      exit 1
    fi
    case "$event_action" in
      create)
        printf '%s\n' "$container_id" >> "$kind_creation_ids_file"
        observed_create_count=$((observed_create_count + 1))
        if [ "$observed_create_count" -gt 1 ]; then
          kind_cleanup_discovery_allowed=false
        fi
        ;;
      destroy)
        saw_destroy=true
        kind_cleanup_discovery_allowed=false
        ;;
      *)
        report_ambiguous_kind_creation "unexpected Docker container event"
        exit 1
        ;;
    esac
  done < "$kind_creation_events_file"

  LC_ALL=C sort -u -o "$kind_creation_ids_file" "$kind_creation_ids_file"
  docker ps --all --no-trunc \
    --filter "label=io.x-k8s.kind.cluster=${KIND_CLUSTER_NAME}" \
    --format '{{.ID}}' | LC_ALL=C sort -u > "$kind_final_ids_file"

  if [ "$saw_destroy" = "true" ] || ! cmp -s "$kind_creation_ids_file" "$kind_final_ids_file"; then
    report_ambiguous_kind_creation "creation events do not match final Docker container identities"
    exit 1
  fi

  proof_count=0
  while IFS= read -r container_id; do
    if [[ ! "$container_id" =~ ^[0-9a-f]{64}$ ]]; then
      report_ambiguous_kind_creation "invalid final Docker container identity"
      exit 1
    fi
    kind_cleanup_ids+=("$container_id")
    proof_count=$((proof_count + 1))
  done < "$kind_final_ids_file"
  if [ "$proof_count" -ne 1 ]; then
    report_ambiguous_kind_creation "creation did not produce exactly one final Docker container"
    exit 1
  fi

  # From here onward, the one live ID is the exact empty-preflight/event/final
  # delta. Any later failure removes only that ID, never a cluster name.
  kind_cleanup_armed=true
  proof_count=0
  while IFS= read -r container_id; do
    cluster_label="$(docker inspect --format '{{ index .Config.Labels "io.x-k8s.kind.cluster" }}' "$container_id")"
    node_role="$(docker inspect --format '{{ index .Config.Labels "io.x-k8s.kind.role" }}' "$container_id")"
    if [ "$cluster_label" != "$KIND_CLUSTER_NAME" ] || [ "$node_role" != "control-plane" ]; then
      echo "Kind creation did not produce the expected control-plane node identity"
      exit 1
    fi
    proof_count=$((proof_count + 1))
  done < "$kind_final_ids_file"
  if [ "$proof_count" -ne 1 ]; then
    echo "Kind creation must produce exactly one control-plane Docker container"
    exit 1
  fi
  if [ "$kind_create_status" -ne 0 ]; then
    echo "Kind create failed after producing one exact Docker container identity" >&2
    exit "$kind_create_status"
  fi

  kind_proof_publish_file="$(mktemp "${KIND_CREATION_PROOF_FILE}.publish.XXXXXX")"
  while IFS= read -r container_id; do
    printf '%s\n' "$container_id" >> "$kind_proof_publish_file"
  done < "$kind_final_ids_file"
  chmod 0600 "$kind_proof_publish_file"

  # A same-directory hard link publishes the complete mode-0600 inode in one
  # operation and fails if another publisher won the destination name.
  if ! ln "$kind_proof_publish_file" "$KIND_CREATION_PROOF_FILE"; then
    echo "Refusing to replace existing Kind creation proof"
    exit 1
  fi
  kind_cleanup_armed=false
  kind_cleanup_discovery_allowed=false
  rm -f -- "$kind_proof_publish_file"
  kind_proof_publish_file=""
  cleanup_kind_creation_files
  trap - EXIT
elif [ "$kind_create_status" -ne 0 ]; then
  exit "$kind_create_status"
fi

echo ""
echo "Kind cluster ready!"
echo "   Cluster: ${KIND_CLUSTER_NAME}"
echo "   Kubernetes: v1.35.0"
echo "   NodePort: 30080 -> host port ${HTTP_PORT}"
echo ""
echo "Returning control to the Makefile for platform deployment..."
