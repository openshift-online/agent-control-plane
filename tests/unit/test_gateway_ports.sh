#!/usr/bin/env bash
#
# Unit tests for scripts/lib/gateway-ports.sh — deterministic tenant→port mapping.
# Pure bash, no cluster required.
#
# Usage: bash tests/unit/test_gateway_ports.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../../scripts/lib/gateway-ports.sh"

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
PASSED=0; FAILED=0

pass() { echo -e "  ${GREEN}\xE2\x9C\x93${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}\xE2\x9C\x97${NC} $1"; FAILED=$((FAILED + 1)); }

# assert_port <expected> <ns> [env assignments...]
assert_port() {
  local expected="$1" ns="$2"; shift 2
  local got stderr_file
  stderr_file=$(mktemp)
  got=$(env "$@" bash "$LIB" port-for "$ns" 2>"$stderr_file")
  local stderr_content
  stderr_content=$(cat "$stderr_file")
  rm -f "$stderr_file"
  if [ "$got" = "$expected" ] && [ -z "$stderr_content" ]; then
    pass "port-for $ns ($*) = $expected"
  elif [ "$got" != "$expected" ]; then
    fail "port-for $ns ($*): expected '$expected', got '$got'"
  else
    fail "port-for $ns ($*): unexpected stderr: $stderr_content"
  fi
}

# assert_fails <ns> [env assignments...]
assert_fails() {
  local ns="$1"; shift
  if env "$@" bash "$LIB" port-for "$ns" >/dev/null 2>&1; then
    fail "port-for $ns ($*): expected non-zero exit, got success"
  else
    pass "port-for $ns ($*) fails as expected"
  fi
}

echo "gateway-ports.sh unit tests"

# Default list + default base
assert_port 15080 tenant-a
assert_port 15081 tenant-b
assert_port 15082 tenant-c
assert_port 15083 vteam-product-swarm
assert_port 15084 codebase-maintainers

# Base override via KIND_FWD_GATEWAY_BASE_PORT
assert_port 20000 tenant-a KIND_FWD_GATEWAY_BASE_PORT=20000
assert_port 20002 tenant-c KIND_FWD_GATEWAY_BASE_PORT=20000

# Base override via GATEWAY_BASE_PORT (setup-gateway-cli.sh compatibility)
assert_port 16081 tenant-b GATEWAY_BASE_PORT=16080

# KIND_FWD_GATEWAY_BASE_PORT takes precedence over GATEWAY_BASE_PORT
assert_port 20000 tenant-a KIND_FWD_GATEWAY_BASE_PORT=20000 GATEWAY_BASE_PORT=16080

# Custom tenant list
assert_port 15080 foo OPENSHELL_TENANTS="foo bar"
assert_port 15081 bar OPENSHELL_TENANTS="foo bar"

# Unknown tenant → failure, no port on stdout
assert_fails not-a-tenant
assert_fails tenant-a OPENSHELL_TENANTS="foo bar"

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[ "$FAILED" -eq 0 ]
