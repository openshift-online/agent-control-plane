#!/usr/bin/env bash
# Install APM dependencies using credentials from repo-root .env.local.
#
# One-time setup:
#   cp .env.local.example .env.local
#   # set GITLAB_APM_PAT=glpat_... in .env.local
#
# Then:
#   make apm-install
#   # or: apm run install

# shellcheck source=apm-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/apm-common.sh"

if [[ -n "${GITLAB_APM_PAT:-}" ]]; then
  ./scripts/sync-ai-security-harness-skills.sh
  apm install "$@"
  run_skill_audit
  exit 0
fi

cat >&2 <<'EOF'
[!] GITLAB_APM_PAT is not set — installing without ai-security-harness skills.
    Add your GitLab PAT (read_repository scope) to .env.local:

      GITLAB_HOST=gitlab.cee.redhat.com
      GITLAB_APM_PAT=glpat_...

    See .env.local.example, then re-run: make apm-install
EOF

cp apm.yml apm.yml.bak
trap 'mv apm.yml.bak apm.yml' EXIT

# Remove staged ai-security-harness dependency when GitLab credentials are absent.
sed -i.tmp '/- path: \.\/vendor\/ai-security-harness$/,/alias: ai-security-harness/{d;}' apm.yml && rm -f apm.yml.tmp

apm install "$@"
run_skill_audit
