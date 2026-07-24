#!/usr/bin/env bash
# Update all APM dependencies: ai-security-harness pin, remote deps, reinstall.
#
# One-time setup:
#   cp .env.local.example .env.local
#   # set GITLAB_APM_PAT=glpat_... in .env.local
#
# Then:
#   make apm-update
#   # or: apm run update
#
# Does not run on bare `apm update` — use this script or `apm run update`.

# shellcheck source=apm-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/apm-common.sh"

if [[ -n "${GITLAB_APM_PAT:-}" ]]; then
  ./scripts/sync-ai-security-harness-skills.sh --update-pin
else
  cat >&2 <<'EOF'
[!] GITLAB_APM_PAT is not set — ai-security-harness will not be updated.
    Continuing with apm update for other dependencies only.
EOF
fi

apm update --yes "$@"

echo "[i] Commit scripts/ai-security-harness.lock.yaml and apm.lock.yaml if changed."

exec ./scripts/apm-install.sh
