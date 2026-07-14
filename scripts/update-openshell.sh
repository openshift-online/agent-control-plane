#!/usr/bin/env bash
# Update the OpenShell dependency to a new version in one shot.
#
# Usage:
#   scripts/update-openshell.sh v0.0.83
#
# What this script does:
#   1. Vendors the gRPC proto files at the given ref (calls vendor-proto.sh).
#   2. Updates the gateway image tag in Go source defaults.
#   3. Updates the supervisor image tag in the gateway configmap manifest.
#   4. Updates the gateway image tag in all example gateway YAML files.
#
# Prerequisites: curl, python3, buf

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ $# -eq 1 ]] || { echo "Usage: $(basename "$0") <version-tag>"; exit 1; }
NEW_VERSION="$1"

# Strip leading 'v' for image tags (gateway images use bare semver)
IMAGE_TAG="${NEW_VERSION#v}"

# Detect current version from VENDOR.md
VENDOR_MD="$REPO_ROOT/components/ambient-control-plane/proto/VENDOR.md"
[[ -f "$VENDOR_MD" ]] || die "VENDOR.md not found at $VENDOR_MD"
OLD_TAG=$(sed -n 's/.*Vendored tag[[:space:]]*|[[:space:]]*`\([^`]*\)`.*/\1/p' "$VENDOR_MD" 2>/dev/null || echo "")
OLD_IMAGE_TAG="${OLD_TAG#v}"

if [[ -z "$OLD_IMAGE_TAG" ]]; then
  die "Could not detect current version from $VENDOR_MD"
fi

if [[ "$OLD_IMAGE_TAG" == "$IMAGE_TAG" ]]; then
  echo "Already at $NEW_VERSION — nothing to do."
  exit 0
fi

echo "Updating OpenShell: $OLD_TAG → $NEW_VERSION"
echo ""

# ── 1. Vendor protos ────────────────────────────────────────────────────────

echo "=== Step 1: Vendoring proto files ==="
bash "$REPO_ROOT/components/ambient-control-plane/scripts/vendor-proto.sh" "$NEW_VERSION"
echo ""

# ── 2. Update gateway image defaults in Go source ───────────────────────────

echo "=== Step 2: Updating gateway image tags in Go source ==="

GO_FILES=(
  "components/ambient-control-plane/internal/gateway/reconciler.go"
  "components/ambient-control-plane/internal/reconciler/gateway_reconciler.go"
)

for f in "${GO_FILES[@]}"; do
  filepath="$REPO_ROOT/$f"
  if [[ -f "$filepath" ]] && grep -q "openshell/gateway:$OLD_IMAGE_TAG" "$filepath"; then
    sed -i.bak "s|openshell/gateway:$OLD_IMAGE_TAG|openshell/gateway:$IMAGE_TAG|g" "$filepath"
    rm -f "${filepath}.bak"
    echo "  updated $f"
  fi
done

# ── 3. Update supervisor image in gateway configmap ─────────────────────────

echo "=== Step 3: Updating supervisor image tag in configmap ==="

CONFIGMAP="$REPO_ROOT/components/ambient-control-plane/manifests/gateway/configmap.yaml"
if [[ -f "$CONFIGMAP" ]] && grep -q "openshell/supervisor:$OLD_IMAGE_TAG" "$CONFIGMAP"; then
  sed -i.bak "s|openshell/supervisor:$OLD_IMAGE_TAG|openshell/supervisor:$IMAGE_TAG|g" "$CONFIGMAP"
  rm -f "${CONFIGMAP}.bak"
  echo "  updated manifests/gateway/configmap.yaml"
fi

# ── 4. Update example gateway YAML files ────────────────────────────────────

echo "=== Step 4: Updating example gateway manifests ==="

while IFS= read -r -d '' yamlfile; do
  if grep -q "openshell/gateway:$OLD_IMAGE_TAG" "$yamlfile"; then
    sed -i.bak "s|openshell/gateway:$OLD_IMAGE_TAG|openshell/gateway:$IMAGE_TAG|g" "$yamlfile"
    rm -f "${yamlfile}.bak"
    relpath="${yamlfile#"$REPO_ROOT"/}"
    echo "  updated $relpath"
  fi
done < <(find "$REPO_ROOT/examples" -name "*.yaml" -print0 2>/dev/null)

# ── done ────────────────────────────────────────────────────────────────────

echo ""
echo "OpenShell updated to $NEW_VERSION."
echo ""
echo "Files updated:"
echo "  - Proto sources + generated gRPC stubs"
echo "  - Go gateway image defaults"
echo "  - Gateway configmap (supervisor image)"
echo "  - Example gateway manifests"
echo ""
echo "Next: review the diff, run tests, and commit."
