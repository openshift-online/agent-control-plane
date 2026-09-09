#!/usr/bin/env bash
# Build locally, then push to the selected OpenShift internal image registry.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OC="$SCRIPT_DIR/oc.sh"
: "${ACP_NAMESPACE:?Set ACP_NAMESPACE to the image namespace}"
: "${ACP_IMAGE_TAG:?Set ACP_IMAGE_TAG to a unique source revision tag}"
COMPONENT="${1:?Usage: build.sh api-server|control-plane|ui|runner}"
case "$COMPONENT" in
  api-server) IMAGE=acp-api-server; CONTEXT=components/ambient-api-server; DOCKERFILE=Dockerfile ;;
  control-plane) IMAGE=acp-control-plane; CONTEXT=components; DOCKERFILE=ambient-control-plane/Dockerfile ;;
  ui) IMAGE=acp-ambient-ui; CONTEXT=components; DOCKERFILE=ambient-ui/Dockerfile ;;
  runner) IMAGE=acp-claude-runner; CONTEXT=components/runners/ambient-runner; DOCKERFILE=Dockerfile.openshell ;;
  *) printf 'Unknown component: %s\n' "$COMPONENT" >&2; exit 1 ;;
esac
cd "$REPO_ROOT"
REVISION="$(git rev-parse HEAD)"
REGISTRY="$("$OC" get route default-route -n openshift-image-registry -o jsonpath='{.spec.host}')"
LOCAL_IMAGE="localhost/$IMAGE:$ACP_IMAGE_TAG"
AUTH_DIR="$(mktemp -d)"
trap 'rm -rf "$AUTH_DIR"' EXIT
mkdir -p "$AUTH_DIR/source"
git archive "$REVISION" "$CONTEXT" | tar -x -C "$AUTH_DIR/source"
podman build --platform linux/amd64 --build-arg "GIT_COMMIT=$REVISION" \
  --build-arg "GIT_VERSION=$REVISION" --label "org.opencontainers.image.revision=$REVISION" \
  -t "$LOCAL_IMAGE" -f "$AUTH_DIR/source/$CONTEXT/$DOCKERFILE" "$AUTH_DIR/source/$CONTEXT"
"$OC" create imagestream "$IMAGE" -n "$ACP_NAMESPACE" --dry-run=client -o yaml | "$OC" apply -f -
"$OC" whoami -t | podman login --authfile "$AUTH_DIR/auth.json" --username "$("$OC" whoami)" \
  --password-stdin "$REGISTRY"
podman push --authfile "$AUTH_DIR/auth.json" --digestfile "$AUTH_DIR/digest" \
  "$LOCAL_IMAGE" "docker://$REGISTRY/$ACP_NAMESPACE/$IMAGE:$ACP_IMAGE_TAG"
printf 'image-registry.openshift-image-registry.svc:5000/%s/%s@%s\n' \
  "$ACP_NAMESPACE" "$IMAGE" "$(cat "$AUTH_DIR/digest")"
