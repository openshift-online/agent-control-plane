#!/usr/bin/env bash
# detect-components.sh — Single source of truth for component path detection.
# Reads .github/component-paths.json and either:
#   --outputs: sets GitHub Actions outputs for job gating (component=true/false)
#   --label:   applies component labels to a PR
#
# Usage:
#   detect-components.sh --outputs          # in detect-changes job
#   detect-components.sh --label PR_NUMBER  # in auto-merge job
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/../component-paths.json"
MODE="${1:---outputs}"

get_changed_files() {
  if [ -n "${CHANGED_FILES:-}" ]; then
    echo "$CHANGED_FILES"
    return
  fi

  local pr="${GH_PR:-}"
  if [ -z "$pr" ] && [ -n "${GITHUB_EVENT_NAME:-}" ]; then
    pr=$(jq -r '.pull_request.number // empty' "${GITHUB_EVENT_PATH:-/dev/null}" 2>/dev/null || true)
  fi

  if [ -n "$pr" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
    gh pr diff "$pr" --repo "${GITHUB_REPOSITORY}" --name-only 2>/dev/null || true
  elif git rev-parse --verify "${BASE_REF:-origin/main}" >/dev/null 2>&1; then
    git diff --name-only "${BASE_REF:-origin/main}...HEAD"
  elif git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    git diff --name-only HEAD~1
  else
    git diff --name-only --diff-filter=ACMR HEAD
  fi
}

match_glob() {
  local file="$1" pattern="$2"
  local regex
  regex=$(echo "$pattern" | sed 's|\*\*|.*|g; s|\([^.]\)\*|\1[^/]*|g')
  echo "$file" | grep -qE "^${regex}$"
}

FILES=$(get_changed_files)

if [ "$MODE" = "--outputs" ]; then
  jq -r 'to_entries[] | .key' "$CONFIG" | while read -r component; do
    patterns=$(jq -r --arg c "$component" '.[$c].paths[]' "$CONFIG")
    matched=false
    while IFS= read -r pattern; do
      while IFS= read -r file; do
        if match_glob "$file" "$pattern"; then
          matched=true
          break 2
        fi
      done <<< "$FILES"
    done <<< "$patterns"
    echo "${component}=${matched}" >> "${GITHUB_OUTPUT:-/dev/stdout}"
  done

elif [ "$MODE" = "--label" ]; then
  PR="${2:?PR number required}"
  LABELS=""
  while read -r component; do
    patterns=$(jq -r --arg c "$component" '.[$c].paths[]' "$CONFIG")
    label=$(jq -r --arg c "$component" '.[$c].label' "$CONFIG")
    matched=false
    while IFS= read -r pattern; do
      while IFS= read -r file; do
        if match_glob "$file" "$pattern"; then
          matched=true
          break 2
        fi
      done <<< "$FILES"
    done <<< "$patterns"
    if [ "$matched" = "true" ]; then
      LABELS="$LABELS --add-label $label"
    fi
  done < <(jq -r 'to_entries[] | .key' "$CONFIG")

  if [ -n "$LABELS" ]; then
    for lbl in $LABELS; do
      [ "$lbl" = "--add-label" ] && continue
      gh label create "$lbl" --repo "${GITHUB_REPOSITORY:-}" 2>/dev/null || true
    done
    gh pr edit "$PR" --repo "${GITHUB_REPOSITORY:-}" $LABELS
    echo "Applied labels:$LABELS"
  else
    echo "No component labels to apply"
  fi
fi
