#!/usr/bin/env bash
# Update the agent-sandbox CRD version in one shot.
#
# Usage:
#   scripts/update-agent-sandbox.sh v0.5.1
#
# What this script does:
#   1. Validates the release exists on GitHub.
#   2. Updates the default AGENT_SANDBOX_VERSION in the Makefile.
#   3. Updates the default in scripts/setup-kind-openshell.sh.
#   4. Updates the version reference in README.md.
#   5. Updates the install command in specs/platform/openshell-sandbox-provisioning.spec.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ $# -eq 1 ]] || { echo "Usage: $(basename "$0") <version-tag>"; exit 1; }
NEW_VERSION="$1"

# Detect current version from Makefile
MAKEFILE="$REPO_ROOT/Makefile"
OLD_VERSION=$(sed -n 's/^AGENT_SANDBOX_VERSION ?= \(.*\)/\1/p' "$MAKEFILE" 2>/dev/null || echo "")

if [[ -z "$OLD_VERSION" ]]; then
  die "Could not detect current AGENT_SANDBOX_VERSION from Makefile"
fi

if [[ "$OLD_VERSION" == "$NEW_VERSION" ]]; then
  echo "Already at $NEW_VERSION — nothing to do."
  exit 0
fi

echo "Updating agent-sandbox: $OLD_VERSION → $NEW_VERSION"
echo ""

# ── 1. Validate release exists ──────────────────────────────────────────────

echo "=== Step 1: Validating release ==="
MANIFEST_URL="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${NEW_VERSION}/manifest.yaml"
HTTP_CODE=$(curl -fsSL -o /dev/null -w "%{http_code}" "$MANIFEST_URL" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" != "200" ]]; then
  die "Release $NEW_VERSION not found (HTTP $HTTP_CODE). Check https://github.com/kubernetes-sigs/agent-sandbox/tags"
fi
echo "  Release $NEW_VERSION exists (manifest.yaml downloadable)"

# ── 2. Update Makefile ──────────────────────────────────────────────────────

echo "=== Step 2: Updating Makefile ==="
sed -i.bak "s|AGENT_SANDBOX_VERSION ?= $OLD_VERSION|AGENT_SANDBOX_VERSION ?= $NEW_VERSION|g" "$MAKEFILE"
rm -f "${MAKEFILE}.bak"
echo "  updated AGENT_SANDBOX_VERSION in Makefile"

# ── 3. Update setup-kind-openshell.sh ────────────────────────────────────────

echo "=== Step 3: Updating setup-kind-openshell.sh ==="
SETUP_SCRIPT="$REPO_ROOT/scripts/setup-kind-openshell.sh"
if [[ -f "$SETUP_SCRIPT" ]]; then
  sed -i.bak "s|AGENT_SANDBOX_VERSION:-$OLD_VERSION|AGENT_SANDBOX_VERSION:-$NEW_VERSION|g" "$SETUP_SCRIPT"
  rm -f "${SETUP_SCRIPT}.bak"
  echo "  updated default in setup-kind-openshell.sh"
fi

# ── 4. Update README.md ─────────────────────────────────────────────────────

echo "=== Step 4: Updating README.md ==="
README="$REPO_ROOT/README.md"
if [[ -f "$README" ]] && grep -q "$OLD_VERSION" "$README"; then
  sed -i.bak "s|$OLD_VERSION|$NEW_VERSION|g" "$README"
  rm -f "${README}.bak"
  echo "  updated version references in README.md"
fi

# ── 5. Update provisioning spec ─────────────────────────────────────────────

echo "=== Step 5: Updating provisioning spec ==="
SPEC="$REPO_ROOT/specs/platform/openshell-sandbox-provisioning.spec.md"
if [[ -f "$SPEC" ]] && grep -q "$OLD_VERSION" "$SPEC"; then
  sed -i.bak "s|$OLD_VERSION|$NEW_VERSION|g" "$SPEC"
  rm -f "${SPEC}.bak"
  echo "  updated version references in provisioning spec"
fi

# ── done ────────────────────────────────────────────────────────────────────

echo ""
echo "agent-sandbox updated to $NEW_VERSION."
echo ""
echo "Files updated:"
echo "  - Makefile (AGENT_SANDBOX_VERSION default)"
echo "  - scripts/setup-kind-openshell.sh (fallback default)"
echo "  - README.md (version references)"
echo "  - specs/platform/openshell-sandbox-provisioning.spec.md (install command)"
echo ""
echo "Next: run 'make kind-up' to test with the new CRD version."
