#!/usr/bin/env bash
# Vendor OpenShell proto files from github.com/NVIDIA/OpenShell at a pinned ref.
#
# Usage:
#   vendor-proto.sh <tag-or-sha>
#
#   tag-or-sha  Release tag (e.g. v0.0.71) or full commit SHA.
#               Tags are resolved to a commit SHA via the GitHub API so the
#               SHA is embedded in each file header for exact reproducibility.
#
# What this script does:
#   1. Resolves the ref to a commit SHA (if a tag is given).
#   2. Fetches each proto file from the upstream repo at that SHA.
#   3. Strips the upstream SPDX header and go_package option.
#   4. Prepends the local SPDX header with the upstream path and commit SHA.
#   5. Injects the local go_package option after the package declaration.
#   6. Writes the result to the local proto directory.
#   7. Updates proto/VENDOR.md with the new tag and SHA.
#   8. Runs buf generate to regenerate Go stubs.
#
# After running, review the diff (especially openshell.proto, which is a
# curated subset) and commit both the proto sources and generated stubs.
#
# Prerequisites: curl, python3, buf

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPONENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROTO_DIR="$COMPONENT_DIR/proto"
VENDOR_MD="$PROTO_DIR/VENDOR.md"

UPSTREAM_REPO="NVIDIA/OpenShell"
GO_PKG_BASE="github.com/ambient-code/platform/components/ambient-control-plane/internal/openshell/grpc"

# ── helpers ──────────────────────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" &>/dev/null || die "'$1' is required but not found. Install it and retry."
}

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

# ── arg parsing ───────────────────────────────────────────────────────────────

[[ $# -eq 1 ]] || usage
REF="$1"
TAG=""

# ── resolve tag → SHA ─────────────────────────────────────────────────────────

require_cmd curl
require_cmd python3
require_cmd buf

if [[ "$REF" =~ ^v[0-9] ]]; then
  TAG="$REF"
  echo "Resolving tag $TAG → SHA ..."
  API_RESPONSE=$(curl -fsSL "https://api.github.com/repos/$UPSTREAM_REPO/git/ref/tags/$TAG") \
    || die "GitHub API request failed for tag $TAG"

  SHA=$(python3 - "$UPSTREAM_REPO" <<PYEOF
import json, sys, urllib.request

repo = sys.argv[1]
d = json.loads(sys.stdin.read())
obj = d["object"]

# Lightweight tag → commit directly; annotated tag → tag object → commit
if obj["type"] == "commit":
    print(obj["sha"])
else:
    tag_url = obj["url"]
    with urllib.request.urlopen(tag_url) as r:
        td = json.loads(r.read())
    print(td["object"]["sha"])
PYEOF
  <<< "$API_RESPONSE") || die "Could not resolve tag $TAG to a commit SHA"

else
  SHA="$REF"
fi

SHORT_SHA="${SHA:0:12}"
if [[ -n "$TAG" ]]; then
  echo "Vendoring $UPSTREAM_REPO @ $TAG ($SHORT_SHA)"
else
  echo "Vendoring $UPSTREAM_REPO @ $SHORT_SHA"
fi

# ── file table ────────────────────────────────────────────────────────────────
#
# Each entry: "upstream_path|local_subpath|go_pkg_suffix|subset_note"
#
#   upstream_path  path in the upstream repo (relative to repo root)
#   local_subpath  destination under $PROTO_DIR/
#   go_pkg_suffix  appended to $GO_PKG_BASE to form the full go_package value
#   subset_note    if non-empty, added as a comment line below Vendored-from
#                  (use this for files that are a curated subset of upstream)

FILES=(
  "proto/datamodel.proto|openshell/datamodel/v1/datamodel.proto|openshell/datamodel/v1;datamodel_v1|"
  "proto/sandbox.proto|openshell/sandbox/v1/sandbox.proto|openshell/sandbox/v1;sandbox_v1|"
  "proto/openshell.proto|openshell/v1/openshell.proto|openshell/v1;openshell_v1|Subset: sandbox lifecycle, exec, and provider management RPCs needed by the control plane."
)

# ── Python transform helper ───────────────────────────────────────────────────
#
# Written to a temp file so we can pipe the fetched content via stdin without
# conflicting with a heredoc.

PYSCRIPT="$(mktemp --suffix=.py)"
PYTMP="$(mktemp)"
trap 'rm -f "$PYSCRIPT" "$PYTMP"' EXIT

cat > "$PYSCRIPT" <<'PYEOF'
import sys, re

local_file  = sys.argv[1]
upstream_path = sys.argv[2]   # e.g. proto/datamodel.proto
sha         = sys.argv[3]
go_package  = sys.argv[4]
subset_note = sys.argv[5]     # empty string if not a subset

lines = sys.stdin.read().splitlines()

# Strip the upstream header block and go_package option.
# We reconstruct both from scratch so the local versions are authoritative.
STRIP = re.compile(
    r'// SPDX-'                      # SPDX copyright / license tags
    r'|// Vendored'                  # our own vendored-from line (re-stamp)
    r'|// Subset:'                   # our subset note (re-stamp)
    r'|// DO NOT EDIT'               # generated-code banner (not relevant here)
    r'|\s*option go_package\s*='     # upstream go_package (replaced with ours)
)

cleaned = []
skip_leading_blank = True

for line in lines:
    if STRIP.match(line):
        continue
    if skip_leading_blank and line.strip() in ('', '//'):
        continue
    skip_leading_blank = False
    cleaned.append(line)

# Build our header.
header = [
    '// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.',
    '// SPDX-License-Identifier: Apache-2.0',
    '//',
    f'// Vendored from github.com/NVIDIA/OpenShell/{upstream_path} at {sha}',
]
if subset_note:
    header.append(f'// {subset_note}')

out = header + ['']

# Insert our go_package option immediately after the package declaration.
inserted = False
for line in cleaned:
    out.append(line)
    if not inserted and re.match(r'^package\s+\S', line):
        out.append('')
        out.append(f'option go_package = "{go_package}";')
        inserted = True

with open(local_file, 'w') as f:
    f.write('\n'.join(out).rstrip('\n') + '\n')
PYEOF

# ── fetch and transform each file ─────────────────────────────────────────────

for entry in "${FILES[@]}"; do
  IFS='|' read -r upstream_path local_sub go_sub subset_note <<< "$entry"

  local_file="$PROTO_DIR/$local_sub"
  go_package="${GO_PKG_BASE}/${go_sub}"
  raw_url="https://raw.githubusercontent.com/$UPSTREAM_REPO/$SHA/$upstream_path"

  echo "  fetching $upstream_path ..."
  curl -fsSL "$raw_url" > "$PYTMP" \
    || die "Failed to fetch $raw_url — check the SHA/tag and try again."

  mkdir -p "$(dirname "$local_file")"

  python3 "$PYSCRIPT" \
    "$local_file" "$upstream_path" "$SHA" "$go_package" "$subset_note" \
    < "$PYTMP"

  echo "    → $local_sub"
done

# ── update VENDOR.md ──────────────────────────────────────────────────────────

echo "Updating $VENDOR_MD ..."

python3 - "$VENDOR_MD" "$TAG" "$SHA" <<'PYEOF'
import sys, re

vendor_md = sys.argv[1]
tag       = sys.argv[2]   # may be empty
sha       = sys.argv[3]

with open(vendor_md) as f:
    content = f.read()

# Remove existing Vendored tag / Vendored commit rows so we can re-insert them.
content = re.sub(r'\| Vendored tag\s*\|[^\n]*\n', '', content)
content = re.sub(r'\| Vendored commit\s*\|[^\n]*\n', '', content)

# Build the replacement rows.
new_rows = ''
if tag:
    new_rows += f'| Vendored tag    | `{tag}` |\n'
new_rows += f'| Vendored commit | `{sha}` |\n'

# Insert after the "| Upstream path | ... |" row.
content, n = re.subn(
    r'(\| Upstream path\s*\|[^\n]*\n)',
    r'\1' + new_rows,
    content,
)
if n == 0:
    # Fallback: append before the closing separator line
    content = re.sub(
        r'(\|---\|---\|)',
        r'\1\n' + new_rows.rstrip('\n'),
        content,
        count=1,
    )

with open(vendor_md, 'w') as f:
    f.write(content)
PYEOF

# ── regenerate Go stubs ───────────────────────────────────────────────────────

echo "Running buf generate ..."
cd "$PROTO_DIR" && buf generate

# ── done ──────────────────────────────────────────────────────────────────────

echo ""
echo "Done. Files updated:"
echo "  components/ambient-control-plane/proto/"
echo "  components/ambient-control-plane/internal/openshell/grpc/"
echo ""
echo "NOTE: openshell.proto is a curated subset of the upstream file."
echo "      Review the diff and trim any RPCs that reference message types"
echo "      from proto files not vendored here before committing."
