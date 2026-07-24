#!/usr/bin/env bash
# Shared SkillSpector scan driver for agent-control-plane.
#
# Usage: ./scripts/skill-scan.sh <mode> [-- <extra skillspector scan args>]
#
# Modes:
#   managed    APM-deployed agent content (.claude/skills, .claude/commands).
#              Fast -- this is what runs on every `make apm-install`.
#   unmanaged  Locally authored agent content APM does NOT manage: top-level
#              skills/, .claude/agents, .claude/plugins, loose .claude config,
#              and .github/. Skips managed dirs since those were scanned at
#              install time.
#   all        managed + unmanaged combined (full agent-facing surface).
#
# Scope is deliberately limited to agent/skill-facing directories rather
# than the whole repo. SkillSpector's vulnerability patterns (subprocess
# calls, exec, credential access) are exactly what legitimate Go/Python/TS
# application code looks like too, so pointing it at components/ produces
# near-100% false positives (verified: whole-repo scan hit 2,534 files,
# maxed out at risk score 100). Skills live under .claude/, skills/, and
# .github/ -- that's the surface area worth scanning with this tool.
#
# We scan deployed .claude/skills and .claude/commands, not apm_modules/.
# apm_modules/ holds the full upstream package cache (including maintainer
# scripts/ that agents never see); scanning it produced false positives
# unrelated to the agent attack surface.
#
# Managed dirs are kept in sync with .gitignore's "Claude Code" / "APM"
# sections and apm.lock.yaml's deployed_files roots -- update both if either
# changes.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-all}"
shift || true

MANAGED_DIRS=(".claude/skills" ".claude/commands")

# shellcheck source=apm-skillspector.sh
source "$(dirname "${BASH_SOURCE[0]}")/apm-skillspector.sh"
require_skillspector

SCAN_DIR="$(mktemp -d)"
trap 'rm -rf "$SCAN_DIR"' EXIT

copy_dir() {
  local src="$1"
  shift
  [[ -d "$src" ]] || return 0
  mkdir -p "$SCAN_DIR/$(dirname "$src")"
  rsync -aL "$@" "$src" "$SCAN_DIR/$(dirname "$src")/"
}

case "$MODE" in
  managed)
    for d in "${MANAGED_DIRS[@]}"; do
      copy_dir "$d"
    done
    ;;
  unmanaged)
    copy_dir ".claude" --exclude=skills --exclude=commands
    copy_dir "skills" # top-level; .agents/skills symlinks here
    copy_dir ".github"
    ;;
  all)
    copy_dir ".claude"
    copy_dir "skills"
    copy_dir ".github"
    ;;
  *)
    echo "[!] Unknown mode '$MODE'. Use: managed | unmanaged | all" >&2
    exit 2
    ;;
esac

if [[ -z "$(find "$SCAN_DIR" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
  echo "[i] Nothing to scan for mode '$MODE' -- no matching directories found." >&2
  exit 0
fi

BASELINE_ARGS=()
if [[ -f "$ROOT/.skillspector-baseline.yaml" ]]; then
  BASELINE_ARGS=(--baseline "$ROOT/.skillspector-baseline.yaml")
fi

echo "[i] Scanning ($MODE mode)..." >&2
skillspector scan "$SCAN_DIR" --no-llm "${BASELINE_ARGS[@]}" "$@"
