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

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

export GITLAB_HOST="${GITLAB_HOST:-gitlab.cee.redhat.com}"

if [[ -n "${GITLAB_APM_PAT:-}" ]]; then
  exec apm install "$@"
fi

cat >&2 <<'EOF'
[!] GITLAB_APM_PAT is not set — installing without GitLab dependencies (ai-security-harness).
    To include them, add your GitLab PAT (read_repository scope) to .env.local:

      GITLAB_HOST=gitlab.cee.redhat.com
      GITLAB_APM_PAT=glpat_...

    See .env.local.example, then re-run: make apm-install
EOF

cp apm.yml apm.yml.bak
trap 'mv apm.yml.bak apm.yml' EXIT

# Remove any dependency blocks with type: gitlab
sed -i.tmp '/- git:.*$/,/type: gitlab/{ /type: gitlab/{ N; d; }; d; }' apm.yml && rm -f apm.yml.tmp

apm install "$@"
