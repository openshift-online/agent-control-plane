#!/usr/bin/env bash
# Wrapper — the demo script was merged into the e2e test for CI visibility.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec bash "$REPO_ROOT/tests/e2e/openshell-cli-e2e.sh" "$@"
