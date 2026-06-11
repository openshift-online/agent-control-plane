#!/usr/bin/env bash
# convention-guard.sh — PreToolUse hook for Edit|Write tool calls.
# Checks file path and content against project conventions.
# Replaces prompt-type hooks that fail on Vertex AI (output_config issue).
#
# Exit codes:
#   0 = allow the tool call
#   2 = block the tool call (stderr shown to agent as reason)
set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Extract content to check based on tool type
if [[ "$TOOL_NAME" == "Write" ]]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // ""')
elif [[ "$TOOL_NAME" == "Edit" ]]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // ""')
else
  exit 0
fi

warn() {
  echo "$1" >&2
  exit 2
}

# --- Generated/sensitive files ---
case "$FILE_PATH" in
  *.env|*.env.*|*/package-lock.json|*/go.sum|*/vendor/*)
    warn "This is a generated or sensitive file. Use the appropriate package manager or tool instead."
    ;;
esac

# --- Go: panic() in production code ---
if [[ "$FILE_PATH" == */components/operator/*.go ]]; then
  if [[ "$FILE_PATH" != *_test.go ]]; then
    if echo "$CONTENT" | grep -q 'panic('; then
      warn "Do not use panic() in production code. Return fmt.Errorf with context instead."
    fi
  fi
fi

# --- Skills: remind about standards ---
if [[ "$FILE_PATH" == */.claude/skills/* || "$FILE_PATH" == */skills/* ]]; then
  warn "Follow the Anthropic skill-creator standard. Required: pushy description, under 500 lines, explanation over rigidity, evals in evals/evals.json."
fi

# --- New feature files: suggest feature flag ---
if [[ "$TOOL_NAME" == "Write" ]]; then
  if [[ "$FILE_PATH" == */components/ambient-ui/src/app/*/page.tsx ]]; then
    warn "New feature code detected. Consider gating behind a feature flag. Use /unleash-flag to set one up."
  fi
fi

# --- Manifests/workflows: image reference consistency ---
if [[ "$FILE_PATH" == */components/manifests/*.yaml || "$FILE_PATH" == */.github/workflows/*.yml || "$FILE_PATH" == */.github/workflows/*.yaml ]]; then
  if echo "$CONTENT" | grep -qE '(quay\.io/|registry\.redhat\.io/|_IMAGE)'; then
    warn "Image references must match across the full stack. Grep all overlays, workflows, ConfigMaps, and Makefile targets to verify the image name and tag are consistent."
  fi
fi

# --- Go: create-and-ignore AlreadyExists anti-pattern ---
if [[ "$FILE_PATH" == */components/operator/*.go ]]; then
  if echo "$CONTENT" | grep -qE '(errors\.IsAlreadyExists|apierrors\.IsAlreadyExists)'; then
    warn "Use reconcile (update-or-create) patterns, not create-and-ignore-AlreadyExists. Skipping AlreadyExists misses spec drift and ownership updates."
  fi
fi

# --- Go: swallowed errors ---
if [[ "$FILE_PATH" == */components/operator/*.go ]]; then
  if echo "$CONTENT" | grep -qE '_ =.*\('; then
    warn "Never silently swallow errors. Every error must be propagated, logged, or collected."
  fi
fi

# --- Manifests: missing SecurityContext ---
if [[ "$FILE_PATH" == */components/manifests/*.yaml ]]; then
  if echo "$CONTENT" | grep -qE '(initContainers|containers):'; then
    if ! echo "$CONTENT" | grep -q 'runAsNonRoot: true'; then
      warn "All containers must run under restricted SecurityContext: runAsNonRoot: true, drop ALL capabilities, readOnlyRootFilesystem: true."
    fi
  fi
fi

exit 0
