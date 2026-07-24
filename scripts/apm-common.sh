#!/usr/bin/env bash
# Shared helpers for APM wrapper scripts (install, update).
#
# Sources .env.local, optionally installs SkillSpector (with user consent),
# and provides apm_run_with_fallback() to handle the GitLab-PAT-missing case.

set -euo pipefail

APM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APM_ROOT"

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

export GITLAB_HOST="${GITLAB_HOST:-gitlab.cee.redhat.com}"

# shellcheck source=apm-skillspector.sh
source "$(dirname "${BASH_SOURCE[0]}")/apm-skillspector.sh"

# ── Skill security scanning (SkillSpector via APM external-scanners) ──────
if ! apm experimental enable external-scanners >/dev/null 2>&1; then
  echo "[!] Could not enable APM 'external-scanners' flag — skill scanning may be unavailable." >&2
fi

ensure_skillspector

run_skill_audit() {
  if ! command -v skillspector &>/dev/null; then
    return 0
  fi
  echo "[i] Scanning installed skills with skillspector (warn mode — see apm-policy.yml)..." >&2
  ./scripts/skill-scan.sh managed || true
}

# Run an APM command, stripping GitLab deps if GITLAB_APM_PAT is not set.
# Usage: apm_run_with_fallback <apm-subcommand> [args...]
apm_run_with_fallback() {
  local subcmd="$1"
  shift

  if [[ -n "${GITLAB_APM_PAT:-}" ]]; then
    apm "$subcmd" "$@"
    run_skill_audit
    return 0
  fi

  cat >&2 <<'EOF'
[!] GITLAB_APM_PAT is not set — installing without ai-security-harness skills.
    Add your GitLab PAT (read_repository scope) to .env.local:

      GITLAB_HOST=gitlab.cee.redhat.com
      GITLAB_APM_PAT=glpat_...

    See .env.local.example, then re-run.
EOF

  cp apm.yml apm.yml.bak
  trap 'mv apm.yml.bak apm.yml' EXIT

  # Remove staged ai-security-harness dependency when GitLab credentials are absent.
  sed -i.tmp '/- path: \.\/vendor\/ai-security-harness$/,/alias: ai-security-harness/{d;}' apm.yml && rm -f apm.yml.tmp

  apm "$subcmd" "$@"
  run_skill_audit
}
