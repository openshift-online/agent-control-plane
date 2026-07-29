#!/usr/bin/env bash
# overlay-sync.sh — Copy generated overlay files into active target deploy directories.
#
# Designed to run as an APM post-install/post-update lifecycle hook or standalone.
#
# Usage:
#   scripts/overlay-sync.sh [--overlay-dir <path>] [--hook <post-install|post-update>]

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "ERROR: not in a git repo" >&2; exit 1; }

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

die() { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }
warn() { echo -e "    ${YELLOW}⚠${NC} $*"; }
ok() { echo -e "    ${GREEN}✓${NC} $*"; }
skip() { echo -e "    ${RED}✗${NC} $*"; }

# ── Parse arguments ────────────────────────────────────────────────────────

OVERLAY_DIR="skills/overlays"
HOOK=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --overlay-dir) OVERLAY_DIR="$2"; shift 2 ;;
    --hook) HOOK="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--overlay-dir <path>] [--hook <post-install|post-update>]"
      echo ""
      echo "  --overlay-dir   Path to overlays directory (default: skills/overlays)"
      echo "  --hook          APM lifecycle hook that invoked this script"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

OVERLAY_PATH="$REPO_ROOT/$OVERLAY_DIR"

if [[ ! -d "$OVERLAY_PATH" ]]; then
  echo "Overlay sync: overlay directory not found at $OVERLAY_DIR — nothing to do."
  exit 0
fi

# ── Check dependencies ─────────────────────────────────────────────────────

if ! command -v jq &>/dev/null; then
  die "jq is required but not installed"
fi

# ── Discover active targets ────────────────────────────────────────────────

if command -v apm &>/dev/null; then
  DEPLOY_DIRS=$(apm targets --json 2>/dev/null | jq -r '.[] | select(.status == "active") | .deploy_dir' || true)
else
  warn "apm not found — falling back to .claude/ if it exists"
  if [[ -d "$REPO_ROOT/.claude" ]]; then
    DEPLOY_DIRS=".claude/"
  else
    echo "Overlay sync: no active targets found — nothing to do."
    exit 0
  fi
fi

if [[ -z "$DEPLOY_DIRS" ]]; then
  echo "Overlay sync: no active targets — nothing to do."
  exit 0
fi

TARGET_COUNT=$(echo "$DEPLOY_DIRS" | wc -l | tr -d ' ')

# ── Discover overlays ──────────────────────────────────────────────────────

OVERLAYS=()
for dir in "$OVERLAY_PATH"/*/; do
  [[ -d "$dir" ]] || continue
  if [[ -f "$dir/customized/config.yaml" ]]; then
    OVERLAYS+=("$(basename "$dir")")
  fi
done

if [[ ${#OVERLAYS[@]} -eq 0 ]]; then
  echo "Overlay sync: no overlays found in $OVERLAY_DIR — nothing to do."
  exit 0
fi

echo ""
echo -e "${BOLD}Overlay sync:${NC} ${#OVERLAYS[@]} overlay(s) found, $TARGET_COUNT active target(s)"
echo ""

# ── Helper: read a simple YAML scalar ──────────────────────────────────────

yaml_value() {
  local file="$1" key="$2"
  grep -m1 "^${key}:" "$file" 2>/dev/null | sed "s/^${key}:[[:space:]]*//" | sed 's/^["'\'']\(.*\)["'\'']$/\1/'
}

# ── Helper: compute SHA-256 ────────────────────────────────────────────────

file_sha256() {
  shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
}

# ── Process each overlay ───────────────────────────────────────────────────

SYNCED=0
WARNED=0
SKIPPED=0

for overlay_name in "${OVERLAYS[@]}"; do
  overlay="$OVERLAY_PATH/$overlay_name"
  config="$overlay/customized/config.yaml"
  gen_dir="$overlay/customized/generated"
  lock_file="$gen_dir/overlay.lock.yaml"

  echo -e "  ${BOLD}$overlay_name${NC}"

  # 4a: Read base-skill
  base_skill=$(yaml_value "$config" "base-skill")
  if [[ -z "$base_skill" ]]; then
    skip "config.yaml missing base-skill — skipped"
    SKIPPED=$((SKIPPED + 1))
    echo ""
    continue
  fi

  # 4b: Path validation
  if [[ "$base_skill" == */* ]] || [[ "$base_skill" == *\\* ]] || [[ "$base_skill" == *..* ]]; then
    skip "base-skill contains path traversal characters — skipped"
    SKIPPED=$((SKIPPED + 1))
    echo ""
    continue
  fi

  # 4c: Check generated/ exists
  if [[ ! -d "$gen_dir" ]]; then
    warn "no generated files — run /overlay-sync-skills in your agent session to generate"
    SKIPPED=$((SKIPPED + 1))
    echo ""
    continue
  fi

  # Count files to sync (everything in generated/ except overlay.lock.yaml)
  gen_files=()
  for f in "$gen_dir"/*; do
    [[ -f "$f" ]] || continue
    [[ "$(basename "$f")" == "overlay.lock.yaml" ]] && continue
    gen_files+=("$f")
  done

  if [[ ${#gen_files[@]} -eq 0 ]]; then
    warn "generated/ directory is empty — run /overlay-sync-skills to generate"
    SKIPPED=$((SKIPPED + 1))
    echo ""
    continue
  fi

  # 4d: Check upstream exists + 4e: Drift check
  upstream_found=false
  upstream_sha=""
  first_deploy_dir=""

  while IFS= read -r deploy_dir; do
    upstream_file="$REPO_ROOT/${deploy_dir}skills/$base_skill/SKILL.md"
    if [[ -f "$upstream_file" ]]; then
      upstream_found=true
      if [[ -z "$first_deploy_dir" ]]; then
        first_deploy_dir="$deploy_dir"
        upstream_sha=$(file_sha256 "$upstream_file")
      fi
    fi
  done <<< "$DEPLOY_DIRS"

  if ! $upstream_found; then
    warn "upstream skill '$base_skill' not found in any active target"
  fi

  # Drift check
  if [[ -f "$lock_file" ]] && [[ -n "$upstream_sha" ]]; then
    lock_sha=$(yaml_value "$lock_file" "base-skill-sha")
    if [[ -n "$lock_sha" ]] && [[ "$lock_sha" != "$upstream_sha" ]]; then
      warn "upstream SHA differs — overlay may be stale, run /overlay-sync-skills to regenerate"
      echo -e "      lock:     ${lock_sha:0:12}..."
      echo -e "      upstream: ${upstream_sha:0:12}..."
      WARNED=$((WARNED + 1))
    fi
  fi

  # 4f: Copy to each active target
  while IFS= read -r deploy_dir; do
    target_dir="$REPO_ROOT/${deploy_dir}skills/$base_skill"
    mkdir -p "$target_dir"

    copied=0
    for f in "${gen_files[@]}"; do
      cp "$f" "$target_dir/$(basename "$f")"
      copied=$((copied + 1))
    done

    ok "${deploy_dir}skills/$base_skill/ ($copied file(s) synced)"
    SYNCED=$((SYNCED + 1))
  done <<< "$DEPLOY_DIRS"

  echo ""
done

# ── Summary ────────────────────────────────────────────────────────────────

echo -e "${BOLD}Done.${NC} $SYNCED target(s) synced, $WARNED stale, $SKIPPED skipped."

if [[ $WARNED -gt 0 ]]; then
  echo ""
  echo "Run /overlay-sync-skills in your agent session to regenerate stale overlays."
fi
