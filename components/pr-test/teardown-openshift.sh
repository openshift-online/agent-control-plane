#!/usr/bin/env bash
# teardown-openshift.sh — tear down an ACP instance deployed by install-openshift.sh
#
# Usage:
#   bash teardown-openshift.sh <namespace>
set -euo pipefail

NAMESPACE="${1:-}"
CLI="${OC:-oc}"

[[ -z "$NAMESPACE" ]] && { echo "Usage: $0 <namespace>"; exit 1; }

CR_NAME="ambient-control-plane-${NAMESPACE}"

echo "==> Tearing down ACP instance: $NAMESPACE"

echo "    Deleting ClusterRoleBinding ${CR_NAME}..."
$CLI delete clusterrolebinding "$CR_NAME" --ignore-not-found 2>/dev/null || true

echo "    Deleting ClusterRole ${CR_NAME}..."
$CLI delete clusterrole "$CR_NAME" --ignore-not-found 2>/dev/null || true

echo "    Deleting namespace ${NAMESPACE}..."
$CLI delete namespace "$NAMESPACE" --ignore-not-found --wait=false 2>/dev/null || true

echo "==> Teardown complete for $NAMESPACE"
