#!/usr/bin/env bash
set -euo pipefail
: "${ACP_OC_CONTEXT:?Set ACP_OC_CONTEXT to the target cluster context}"
exec oc --context="$ACP_OC_CONTEXT" "$@"
