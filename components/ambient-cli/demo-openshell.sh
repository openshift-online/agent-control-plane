#!/usr/bin/env bash
# Demo: OpenShell CLI power-user workflow
#
# Walks through a full openshell CLI session against ACP-managed gateways:
#   1. Gateway discovery and mTLS registration
#   2. Sandbox lifecycle (create, get, list, delete)
#   3. Provider management (add, list, remove)
#   4. Policy CRUD (create from YAML, get, list, delete)
#   5. Settings management (get, set, list)
#   6. Cleanup and resource teardown
#
# Every command is printed with its output so the workflow is easy to follow.
#
# Prerequisites:
#   - kind-up with OPENSHELL_USE_GATEWAY=true (default)
#   - acpctl built (make build-cli)
#   - openshell CLI installed and available in $PATH
#   - Keycloak reachable (KEYCLOAK_URL, default http://localhost:11880)
#
# Usage:
#   ./demo-openshell.sh [--skip-cleanup] [--cluster-validate]
#
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec bash "$REPO_ROOT/tests/e2e/openshell-cli-e2e.sh" "$@"
