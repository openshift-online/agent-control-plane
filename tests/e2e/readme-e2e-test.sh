#!/usr/bin/env bash
# End-to-end test for the technical content of README.md.
#
# Goal: any user who copy/pastes their way through the README should succeed.
# This script is pointed at an ALREADY-RUNNING ACP environment (Kind, CRC, or a
# real cluster) -- it does not provision anything. It runs in two phases:
#
#   1. Static gate  (no cluster needed): links, referenced files, badge
#      workflows, `make` targets, and `acpctl` subcommands referenced by the
#      README all resolve.
#   2. Live flow    (needs a reachable cluster): the README's documented acpctl
#      gateway/project commands are executed against the environment and
#      asserted to succeed. Live sections skip cleanly when no cluster is
#      reachable, so this doubles as a pure README linter.
#
# Environment overrides:
#   README_DOC            Doc under test           (default: README.md)
#   PROJECT               Throwaway project name   (default: readme-e2e-<rand>)
#   GATEWAY_URL           Connect target URL       (default: auto-detect on Kind)
#   CHECK_EXTERNAL_LINKS  Curl external http links (default: false)
#   RUN_SANDBOX           Run openshell sandbox     (default: false)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

README_DOC="${README_DOC:-README.md}"
PROJECT="${PROJECT:-readme-e2e-$RANDOM}"
GATEWAY_URL="${GATEWAY_URL:-}"
CHECK_EXTERNAL_LINKS="${CHECK_EXTERNAL_LINKS:-false}"
RUN_SANDBOX="${RUN_SANDBOX:-false}"
GATEWAY_READY_TIMEOUT="${GATEWAY_READY_TIMEOUT:-60}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
ORANGE='\033[38;5;214m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
FAILED=0
SKIPPED=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
skip() { echo -e "  ${YELLOW}⊘${NC} $1${2:+ (skipped: $2)}"; SKIPPED=$((SKIPPED + 1)); }
section() { echo ""; echo -e "${BOLD}$1${NC}"; }

CMD_OUTPUT=""
CMD_RC=0
run_cmd() {
  CMD_RC=0
  echo ""
  printf '  %b▶%b  %b$ %s%b\n' "${BOLD}" "${NC}" "${ORANGE}" "$*" "${NC}"
  CMD_OUTPUT=$("$@" 2>&1) || CMD_RC=$?
  if [ -n "$CMD_OUTPUT" ]; then
    echo "$CMD_OUTPUT" | head -20 | sed 's/^/    /'
  fi
  echo ""
}

finish() {
  echo ""
  echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${YELLOW}${SKIPPED} skipped${NC}"
  if [ "$FAILED" -gt 0 ]; then
    exit 1
  fi
}

die() {
  fail "$1"
  exit 1
}

README_ABS="$REPO_ROOT/$README_DOC"

# Throwaway project bookkeeping for teardown.
CREATED_PROJECT=false
ACPCTL=""

cleanup() {
  if [ "$CREATED_PROJECT" = true ] && [ -n "$ACPCTL" ]; then
    echo ""
    echo -e "${BOLD}Teardown${NC}"
    # Local CLI registration cleanup (only meaningful if setup-cli ran).
    "$ACPCTL" gateway remove-cli --project "$PROJECT" >/dev/null 2>&1 || true
    # Best-effort gateway delete; project delete cascades owned resources.
    "$ACPCTL" delete gateway --all --project "$PROJECT" --yes >/dev/null 2>&1 || true
    # Deleting the throwaway project is the authoritative cleanup -- verify it,
    # because a leaked project on the target environment is a real defect.
    if "$ACPCTL" delete project "$PROJECT" --yes >/dev/null 2>&1; then
      pass "Teardown: deleted project $PROJECT"
    else
      fail "Teardown: deleted project $PROJECT (manual cleanup may be required)"
    fi
  fi
}
on_exit() {
  cleanup
  finish
}
trap on_exit EXIT

cd "$REPO_ROOT"

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

find_acpctl() {
  if command -v acpctl >/dev/null 2>&1; then echo acpctl; return; fi
  if [ -x "$REPO_ROOT/components/ambient-cli/acpctl" ]; then
    echo "$REPO_ROOT/components/ambient-cli/acpctl"; return
  fi
  if [ -x "$REPO_ROOT/acpctl" ]; then echo "$REPO_ROOT/acpctl"; return; fi
  echo ""
}

# Emit only the contents of ```bash fenced blocks, so command extraction never
# picks up prose that merely mentions a command name. Fences may be indented
# (README nests some blocks inside numbered lists).
extract_bash_blocks() {
  awk '
    /^[[:space:]]*```bash[[:space:]]*$/ { in_block = 1; next }
    /^[[:space:]]*```[[:space:]]*$/      { in_block = 0; next }
    in_block                            { print }
  ' "$README_ABS"
}

# GitHub-style heading slug (approximation sufficient for our anchors).
to_slug() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9 _-]//g; s/^ +//; s/ +$//; s/ +/-/g'
}

# Newline-delimited set of heading anchors present in the README.
readme_anchors() {
  grep -E '^#{1,6} ' "$README_ABS" | sed -E 's/^#{1,6} +//' | while IFS= read -r h; do
    to_slug "$h"; echo
  done
}

# Extract markdown link/image targets: the "target" in ](target).
extract_link_targets() {
  grep -oE '\]\([^)]+\)' "$README_ABS" \
    | sed -E 's/^\]\(//; s/\)$//' \
    | sed -E 's/[[:space:]]+"[^"]*"$//' \
    | sort -u
}

ANCHORS=""

check_link() {
  local target="$1"
  case "$target" in
    mailto:*|tel:*) return 0 ;;
    http://*|https://*)
      if [ "$CHECK_EXTERNAL_LINKS" = true ]; then
        if curl -sfL --head --max-time 15 "$target" >/dev/null 2>&1; then
          pass "External link: $target"
        else
          fail "External link: $target"
        fi
      else
        skip "External link: $target" "CHECK_EXTERNAL_LINKS=false"
      fi
      ;;
    \#*)
      local anchor="${target#\#}"
      if printf '%s\n' "$ANCHORS" | grep -Fxq "$anchor"; then
        pass "In-page anchor: $target"
      else
        fail "In-page anchor: $target"
      fi
      ;;
    *)
      # Relative path, possibly with #anchor. Verify the file exists.
      local path="${target%%#*}"
      if [ -e "$REPO_ROOT/$path" ]; then
        pass "Relative link: $target"
      else
        fail "Relative link: $target"
      fi
      ;;
  esac
}

# ============================================================================
# Section 1: README static quality gate (no cluster required)
# ============================================================================

section "1. README static quality gate"

[ -f "$README_ABS" ] || die "README exists: $README_DOC"
pass "README exists: $README_DOC"
[ -s "$README_ABS" ] || die "README is non-empty"
pass "README is non-empty"

ANCHORS="$(readme_anchors)"

# --- Links and referenced files ---
section "1a. Links and referenced files"
while IFS= read -r target; do
  [ -n "$target" ] && check_link "$target"
done < <(extract_link_targets)

# --- Badge workflows ---
section "1b. Badge workflows"
for wf in lint.yml unit-tests.yml docs.yml; do
  if [ -f "$REPO_ROOT/.github/workflows/$wf" ]; then
    pass "Badge workflow exists: $wf"
  else
    fail "Badge workflow exists: $wf"
  fi
done

# --- make targets ---
section "1c. make targets referenced in README"
while IFS= read -r target; do
  [ -n "$target" ] || continue
  if grep -qE "^${target}:" "$REPO_ROOT/Makefile"; then
    pass "make target exists: $target"
  else
    fail "make target exists: $target"
  fi
done < <(extract_bash_blocks | grep -oE 'make [a-z][a-z0-9-]+' | awk '{print $2}' | sort -u)

# --- acpctl subcommands ---
section "1d. acpctl subcommands referenced in README"
ACPCTL="$(find_acpctl)"
if [ -z "$ACPCTL" ]; then
  skip "acpctl subcommand validation" "acpctl not found on PATH or in repo"
else
  pass "acpctl found: $ACPCTL"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    group="$(echo "$line" | awk '{print $2}')"
    sub="$(echo "$line" | awk '{print $3}')"
    # Decouple the grep from acpctl's exit code: --help may exit non-zero on
    # some builds while still printing the command surface we want to verify.
    help_out="$("$ACPCTL" "$group" --help 2>&1)" || true
    if printf '%s' "$help_out" | grep -qw "$sub"; then
      pass "acpctl command exists: $group $sub"
    else
      fail "acpctl command exists: $group $sub"
    fi
  done < <(extract_bash_blocks | grep -oE 'acpctl [a-z][a-z0-9-]+ [a-z][a-z0-9-]+' | sort -u)
fi

# ============================================================================
# Section 2: Prerequisites for the live flow
# ============================================================================

section "2. Live prerequisites"

LIVE=true

for tool in jq kubectl curl; do
  if command -v "$tool" >/dev/null 2>&1; then
    pass "$tool is installed"
  else
    skip "$tool is installed" "required for live flow"
    LIVE=false
  fi
done

if [ -z "$ACPCTL" ]; then
  skip "acpctl available for live flow" "acpctl not found"
  LIVE=false
fi

if [ "$LIVE" = true ]; then
  if kubectl cluster-info >/dev/null 2>&1; then
    pass "Cluster is reachable"
  else
    skip "Cluster is reachable" "no reachable cluster; live sections skipped"
    LIVE=false
  fi
fi

if [ "$LIVE" != true ]; then
  section "Live flow skipped"
  skip "README live command flow" "no reachable ACP environment"
  skip "CRC / OpenShift Local path" "not executable in this environment (validated statically only)"
  exit 0
fi

# ============================================================================
# Section 3: Live -- OpenShell as a Service (README: create project & gateway)
# ============================================================================

section "3. Live: create project and gateway"

grep -qE 'acpctl create project' "$README_ABS" \
  && pass "README documents: acpctl create project" \
  || fail "README documents: acpctl create project"

run_cmd "$ACPCTL" create project --name "$PROJECT"
if [ "$CMD_RC" -eq 0 ]; then
  CREATED_PROJECT=true
  pass "Created project: $PROJECT"
else
  die "Created project: $PROJECT"
fi

GATEWAY_CREATED=false
grep -qE 'acpctl create gateway' "$README_ABS" \
  && pass "README documents: acpctl create gateway" \
  || fail "README documents: acpctl create gateway"

run_cmd "$ACPCTL" create gateway --project "$PROJECT"
if [ "$CMD_RC" -ne 0 ]; then
  fail "Requested gateway for project: $PROJECT"
else
  pass "Requested gateway for project: $PROJECT"

  # Assert the gateway actually RECONCILES -- not merely that the API accepted
  # the request or that `get` exits 0. The control plane exposes
  # ambient.ai/reconcile-status; "Synced" is the signal a README reader depends
  # on for the gateway to work. Fail (not skip) if it never reaches Synced.
  GW_JSON=""
  GW_STATUS=""
  i=0
  while [ "$i" -lt "$GATEWAY_READY_TIMEOUT" ]; do
    GW_JSON="$("$ACPCTL" get gateway --project "$PROJECT" -o json 2>/dev/null || true)"
    GW_STATUS="$(printf '%s' "$GW_JSON" | jq -r '.items[0].annotations | fromjson | ."ambient.ai/reconcile-status" // empty' 2>/dev/null || true)"
    if [ "$GW_STATUS" = "Synced" ]; then
      GATEWAY_CREATED=true
      break
    fi
    sleep 5
    i=$((i + 5))
  done
  if [ "$GATEWAY_CREATED" = true ]; then
    pass "Gateway reconciled (status: Synced)"
    # An external route address is only present on route-capable clusters.
    # port-forward environments (kind) and cluster-DNS gateways expose none;
    # there the README uses the --kubectl flow, so route steps skip below.
    if [ -z "$GATEWAY_URL" ]; then
      GATEWAY_URL="$(printf '%s' "$GW_JSON" | jq -r '.items[0].route // {} | tojson' 2>/dev/null | grep -oE 'https?://[^ "]+' | head -1 || true)"
    fi
  else
    fail "Gateway reconciled within ${GATEWAY_READY_TIMEOUT}s (last status: ${GW_STATUS:-none})"
  fi
fi

# ============================================================================
# Section 4: Live -- connect and inspect (README: get gateway, setup-cli)
# ============================================================================

section "4. Live: connect and inspect"

if [ "$GATEWAY_CREATED" = true ]; then
  run_cmd "$ACPCTL" get gateway --project "$PROJECT"
  if [ "$CMD_RC" -eq 0 ] && [ -n "$CMD_OUTPUT" ]; then
    pass "get gateway returns records"
  else
    fail "get gateway returns records"
  fi
else
  skip "get gateway returns records" "no gateway created"
fi

# README documents the connect commands.
grep -qE 'acpctl gateway setup-cli' "$README_ABS" \
  && pass "README documents: acpctl gateway setup-cli" \
  || fail "README documents: acpctl gateway setup-cli"

# Route-based connect (README's OpenShell-as-a-Service flow, validated on
# OpenShift Local / real clusters). Requires a gateway route address; on
# port-forward environments like kind there is none, so these steps skip
# rather than fail. Set GATEWAY_URL to force the route-based path.
if [ "$GATEWAY_CREATED" = true ] && [ -n "$GATEWAY_URL" ]; then
  run_cmd "$ACPCTL" gateway setup-cli --project "$PROJECT" --print
  [ "$CMD_RC" -eq 0 ] && pass "gateway setup-cli --print" || fail "gateway setup-cli --print"

  run_cmd "$ACPCTL" gateway setup-cli --project "$PROJECT" --gateway-url "$GATEWAY_URL" --kubectl
  [ "$CMD_RC" -eq 0 ] && pass "gateway setup-cli --gateway-url" || fail "gateway setup-cli --gateway-url"
else
  skip "gateway setup-cli --print" "gateway has no external route address (cluster-DNS/port-forward access); README uses the --kubectl flow here. Set GATEWAY_URL to test the route-based flow"
  skip "gateway setup-cli --gateway-url" "no gateway URL resolved; set GATEWAY_URL to test the port-forward connect flow"
fi

# Optional sandbox lifecycle via the openshell CLI (README ~lines 75-78).
if [ "$RUN_SANDBOX" = true ] && command -v openshell >/dev/null 2>&1; then
  run_cmd openshell sandbox create
  [ "$CMD_RC" -eq 0 ] && pass "openshell sandbox create" || fail "openshell sandbox create"
  run_cmd openshell sandbox list
  [ "$CMD_RC" -eq 0 ] && pass "openshell sandbox list" || fail "openshell sandbox list"
else
  skip "openshell sandbox create/list" "set RUN_SANDBOX=true with openshell installed"
fi

# CRC path is validated statically only (targets/links checked in Section 1).
skip "CRC / OpenShift Local path" "not executable in CI (validated statically only)"

# Teardown runs via the EXIT trap; finish() reports results there.
