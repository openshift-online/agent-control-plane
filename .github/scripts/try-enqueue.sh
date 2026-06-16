#!/usr/bin/env bash
# try-enqueue.sh — Called by each gate job after it passes.
# Checks if the PR has auto-merge-pending and all 4 required gates
# have passed, then enqueues into the merge queue.
#
# Usage: try-enqueue.sh <PR_NUMBER> [SELF_CHECK_NAME]
#   SELF_CHECK_NAME: the calling gate's check name (excluded from
#   pending count since it's still in-progress when this runs)
set -euo pipefail

if [ -z "${GITHUB_REPOSITORY:-}" ] || [ -z "${GH_TOKEN:-}" ]; then
  echo "Missing GITHUB_REPOSITORY or GH_TOKEN"
  exit 0
fi

PR_NUMBER="${1:-}"
SELF_CHECK="${2:-}"
if [ -z "$PR_NUMBER" ]; then
  echo "No PR number provided, skipping enqueue"
  exit 0
fi

REPO="$GITHUB_REPOSITORY"

LABELS=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json labels --jq '[.labels[].name]' 2>/dev/null || echo "[]")
if ! echo "$LABELS" | grep -qE "auto-merge-pending|auto-merge-queue"; then
  echo "PR #$PR_NUMBER does not have auto-merge-pending label, skipping"
  exit 0
fi

GATES=("Lint CI Gate" "Unit Tests CI Gate" "SDD boundary check" "Build CI Gate")

CHECKS=$(gh pr checks "$PR_NUMBER" --repo "$REPO" 2>/dev/null || true)

for gate in "${GATES[@]}"; do
  if [ "$gate" = "$SELF_CHECK" ]; then
    continue
  fi
  gate_line=$(echo "$CHECKS" | grep -F "$gate" || true)
  if [ -z "$gate_line" ]; then
    echo "Gate '$gate' not reported yet, skipping"
    exit 0
  fi
  if echo "$gate_line" | grep -q 'fail'; then
    echo "Gate '$gate' failed, not enqueuing"
    exit 0
  fi
  if echo "$gate_line" | grep -q 'pending'; then
    echo "Gate '$gate' still pending, skipping"
    exit 0
  fi
done

echo "All required gates passed for PR #$PR_NUMBER — enqueuing"
# Disable auto-merge first — if it's already enabled, gh pr merge
# just confirms it instead of enqueuing into the merge queue.
gh pr merge "$PR_NUMBER" --disable-auto --repo "$REPO" 2>/dev/null || true
if gh pr merge "$PR_NUMBER" --repo "$REPO"; then
  gh pr edit "$PR_NUMBER" --add-label auto-merge-queue --remove-label auto-merge-pending --repo "$REPO" 2>/dev/null || true
  echo "PR #$PR_NUMBER enqueued successfully"
else
  echo "gh pr merge failed for PR #$PR_NUMBER"
fi
