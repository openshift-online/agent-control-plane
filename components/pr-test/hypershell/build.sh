#!/usr/bin/env bash
# Build the current source with the OpenShift internal image registry.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OC="$SCRIPT_DIR/oc.sh"
: "${ACP_NAMESPACE:?Set ACP_NAMESPACE to the build namespace}"
: "${ACP_IMAGE_TAG:?Set ACP_IMAGE_TAG to a unique source revision tag}"
COMPONENT="${1:?Usage: build.sh api-server|control-plane|ui|runner}"
case "$COMPONENT" in
  api-server) IMAGE=acp-api-server; CONTEXT=components/ambient-api-server; DOCKERFILE=Dockerfile ;;
  control-plane) IMAGE=acp-control-plane; CONTEXT=components; DOCKERFILE=ambient-control-plane/Dockerfile ;;
  ui) IMAGE=acp-ambient-ui; CONTEXT=components; DOCKERFILE=ambient-ui/Dockerfile ;;
  runner) IMAGE=acp-claude-runner; CONTEXT=components/runners/ambient-runner; DOCKERFILE=Dockerfile ;;
  *) printf 'Unknown component: %s\n' "$COMPONENT" >&2; exit 1 ;;
esac
BUILD_NAME="${IMAGE//_/-}"
export BUILD_NAME IMAGE CONTEXT DOCKERFILE
cd "$REPO_ROOT"
python3 - <<'PY' | "$OC" apply -n "$ACP_NAMESPACE" -f -
import json, os, subprocess
name = os.environ['BUILD_NAME']
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
print(json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': [
    {'apiVersion': 'image.openshift.io/v1', 'kind': 'ImageStream', 'metadata': {'name': os.environ['IMAGE']}},
    {'apiVersion': 'build.openshift.io/v1', 'kind': 'BuildConfig', 'metadata': {'name': name}, 'spec': {
        'runPolicy': 'Serial', 'source': {'type': 'Binary', 'binary': {}},
        'strategy': {'type': 'Docker', 'dockerStrategy': {'dockerfilePath': os.environ['DOCKERFILE'],
            'buildArgs': [{'name': 'GIT_COMMIT', 'value': revision}, {'name': 'GIT_VERSION', 'value': revision}]}},
        'output': {'to': {'kind': 'ImageStreamTag', 'name': os.environ['IMAGE'] + ':' + os.environ['ACP_IMAGE_TAG']}},
        'resources': {'requests': {'cpu': '500m', 'memory': '1Gi'}, 'limits': {'cpu': '4', 'memory': '6Gi'}},
        'successfulBuildsHistoryLimit': 2, 'failedBuildsHistoryLimit': 2}}]}))
PY
"$OC" start-build "$BUILD_NAME" -n "$ACP_NAMESPACE" --from-dir="$REPO_ROOT/$CONTEXT" --follow --wait
"$OC" get imagestreamtag "$IMAGE:$ACP_IMAGE_TAG" -n "$ACP_NAMESPACE" -o jsonpath='{.image.dockerImageReference}{"\n"}'
