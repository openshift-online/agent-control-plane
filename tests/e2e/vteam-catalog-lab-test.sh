#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAB_DOC="${LAB_DOC:-examples/vteam-catalog/QUICKSTART.md}"
PROJECT_ID="${PROJECT_ID:-vteam-product-swarm}"
NAMESPACE="${NAMESPACE:-ambient-code}"
RUN_OPTIONAL_SESSION="${RUN_OPTIONAL_SESSION:-false}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
skip() { echo -e "  ${YELLOW}⊘${NC} $1 (skipped${2:+: $2})"; }
section() { echo ""; echo -e "${BOLD}$1${NC}"; }

finish() {
  echo ""
  echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
  if [ "$FAILED" -gt 0 ]; then
    exit 1
  fi
}

die() {
  fail "$1"
  exit 1
}

LAB_DOC_ABS="$REPO_ROOT/$LAB_DOC"
COMMAND_DIR="$(mktemp -d "${TMPDIR:-/tmp}/acp-lab-e2e.XXXXXX")"
COMMANDS_FILE="$COMMAND_DIR/commands.sh"

cleanup() {
  make kind-port-forward-stop >/dev/null 2>&1 || true
  rm -rf "$COMMAND_DIR"
}
on_exit() {
  cleanup
  finish
}
trap on_exit EXIT

cd "$REPO_ROOT"

extract_bash_blocks() {
  awk '
    /^```bash[[:space:]]*$/ { in_block = 1; next }
    /^```[[:space:]]*$/ {
      if (in_block) {
        print ""
      }
      in_block = 0
      next
    }
    in_block { print }
  ' "$LAB_DOC_ABS"
}

assert_doc_has() {
  local pattern="$1"
  local label="$2"
  if grep -Eq "$pattern" "$LAB_DOC_ABS"; then
    pass "$label"
  else
    fail "$label"
  fi
}

run_doc_block() {
  local label="$1"
  local pattern="$2"
  local block_file="$COMMAND_DIR/${label//[^a-zA-Z0-9]/_}.sh"

  # Intentionally execute trusted repo markdown so the lab copy/paste path stays tested.
  awk -v pat="$pattern" '
    /^```bash[[:space:]]*$/ { in_block = 1; block = ""; next }
    /^```[[:space:]]*$/ {
      if (in_block && block ~ pat) {
        print block
        found = 1
        exit
      }
      in_block = 0
      next
    }
    in_block { block = block $0 "\n" }
    END { if (!found) exit 1 }
  ' "$LAB_DOC_ABS" > "$block_file" || {
    fail "Markdown block found: $label"
    return 1
  }

  if bash -euo pipefail "$block_file"; then
    pass "Markdown block runs: $label"
  else
    fail "Markdown block runs: $label"
    return 1
  fi
}

run_doc_block_with_retry() {
  local max_attempts="${1:-3}"
  local label="$2"
  local pattern="$3"
  local attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    if run_doc_block "$label" "$pattern"; then
      return 0
    fi
    if [ "$attempt" -lt "$max_attempts" ]; then
      FAILED=$((FAILED - 1))
      echo "  Retrying ($((attempt + 1))/$max_attempts) after transient failure..."
      sleep 3
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

find_acpctl() {
  if command -v acpctl >/dev/null 2>&1; then
    echo acpctl
    return
  fi
  if [ -x "$REPO_ROOT/components/ambient-cli/acpctl" ]; then
    echo "$REPO_ROOT/components/ambient-cli/acpctl"
    return
  fi
  if [ -x "$REPO_ROOT/acpctl" ]; then
    echo "$REPO_ROOT/acpctl"
    return
  fi
  echo ""
}

json_name_exists() {
  local json="$1"
  local name="$2"
  echo "$json" | jq -e --arg name "$name" '.items[]? | select(.name == $name)' >/dev/null
}

wait_for_backend() {
  local port="$1"
  for _ in $(seq 1 30); do
    if curl -sf --max-time 5 "http://localhost:${port}/api/ambient/v1/projects" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

backend_port() {
  make -s kind-status | awk '/Forward:/ { for (i = 1; i <= NF; i++) if ($i == "(backend)") print $(i - 1) }'
}

ensure_backend_port_forward() {
  local label="$1"
  BACKEND_PORT="$(backend_port)"
  if [ -n "$BACKEND_PORT" ] && wait_for_backend "$BACKEND_PORT"; then
    pass "$label"
    return
  fi

  echo "  Backend port-forward unavailable; restarting kind port-forward..."
  make kind-port-forward >/tmp/acp-kind-port-forward.log 2>&1 &
  BACKEND_PORT="$(backend_port)"
  if [ -n "$BACKEND_PORT" ] && wait_for_backend "$BACKEND_PORT"; then
    pass "$label"
  else
    die "$label; run make kind-port-forward"
  fi
}

# ============================================================================
# Section 1: Lab markdown quality gate
# ============================================================================

section "1. Lab markdown quality gate"

[ -f "$LAB_DOC_ABS" ] || die "Lab doc exists: $LAB_DOC"
pass "Lab doc exists: $LAB_DOC"

extract_bash_blocks > "$COMMANDS_FILE"

if [ -s "$COMMANDS_FILE" ]; then
  pass "Lab doc contains bash command blocks"
else
  fail "Lab doc contains bash command blocks"
fi

if grep -Eq '<[^>]+>|TODO|FIXME' "$COMMANDS_FILE"; then
  fail "Lab bash blocks have no placeholders"
else
  pass "Lab bash blocks have no placeholders"
fi

assert_doc_has 'make kind-acpctl-login' "Lab uses make kind-acpctl-login"
assert_doc_has '([Aa][Cc][Pp][Cc][Tt][Ll]).*apply' "Lab applies catalog with acpctl"
assert_doc_has 'agent list --project vteam-product-swarm' "Lab lists vTeam agents"
assert_doc_has 'provider list --project vteam-product-swarm' "Lab lists vTeam providers"
assert_doc_has 'agent start stella' "Lab includes Stella start command"
assert_doc_has 'agent sessions stella --project vteam-product-swarm' "Lab includes Stella session inspection"

# ============================================================================
# Section 2: Prerequisites
# ============================================================================

section "2. Prerequisites"

command -v jq >/dev/null 2>&1 || die "jq is installed"
pass "jq is installed"

command -v kubectl >/dev/null 2>&1 || die "kubectl is installed"
pass "kubectl is installed"

kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || die "Kind namespace exists: $NAMESPACE"
pass "Kind namespace exists: $NAMESPACE"

ACPCTL="$(find_acpctl)"
if [ -n "$ACPCTL" ]; then
  export ACPCTL
  export AMBIENT_PROJECT="$PROJECT_ID"
  pass "acpctl found: $ACPCTL"
else
  die "acpctl found"
fi

# ============================================================================
# Section 3: Execute port-forward from markdown
# ============================================================================

section "3. Execute port-forward from markdown"

run_doc_block "kind-port-forward-background" '/tmp/acp-kind-port-forward.log'

ensure_backend_port_forward "Kind backend port-forward is healthy"

# ============================================================================
# Section 4: Execute login from markdown
# ============================================================================

section "4. Execute login from markdown"

run_doc_block "kind-acpctl-login" 'make kind-acpctl-login'

# ============================================================================
# Section 5: Execute catalog apply from markdown
# ============================================================================

section "5. Execute catalog apply from markdown"

run_doc_block_with_retry 3 "catalog-apply" "examples/vteam-catalog/product-swarm"

# ============================================================================
# Section 6: Verify ACP records from markdown commands
# ============================================================================

section "6. Verify ACP records from markdown commands"

ensure_backend_port_forward "Kind backend port-forward is healthy before inspection"

run_doc_block "catalog-inspection" 'agent list --project vteam-product-swarm'

if "$ACPCTL" get project "$PROJECT_ID" >/dev/null 2>&1; then
  pass "Project exists: $PROJECT_ID"
else
  fail "Project exists: $PROJECT_ID"
fi

AGENTS_JSON="$("$ACPCTL" agent list --project "$PROJECT_ID" -o json 2>&1 || true)"
for agent in stella amber parker ryan steve terry; do
  if json_name_exists "$AGENTS_JSON" "$agent"; then
    pass "Agent exists: $agent"
  else
    fail "Agent exists: $agent"
  fi
done

PROVIDERS_JSON="$("$ACPCTL" provider list --project "$PROJECT_ID" -o json 2>&1 || true)"
for provider in vertex github jira; do
  if json_name_exists "$PROVIDERS_JSON" "$provider"; then
    pass "Provider exists: $provider"
  else
    fail "Provider exists: $provider"
  fi
done

# ============================================================================
# Section 7: Optional Stella session
# ============================================================================

section "7. Optional Stella session"

if [ "$RUN_OPTIONAL_SESSION" = "true" ]; then
  run_doc_block "stella-start" 'agent start stella'
  run_doc_block "stella-sessions" 'agent sessions stella'
else
  skip "Stella session start" "set RUN_OPTIONAL_SESSION=true to exercise optional runtime session"
fi
