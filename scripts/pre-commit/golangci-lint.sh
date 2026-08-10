#!/usr/bin/env bash
# golangci-lint.sh — run golangci-lint in each affected Go module.
# Skips gracefully if golangci-lint is not installed.
set -euo pipefail

if ! command -v golangci-lint &>/dev/null; then
    echo "golangci-lint not found — skipping (install to enable)"
    exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"

# Known Go module directories (relative to repo root)
GO_MODULES=(
    "components/ambient-api-server"
    "components/ambient-sdk/generator"
    "components/ambient-control-plane"
    "components/public-api"
    "components/ambient-cli"
)

# Determine which modules are affected by the staged files
affected_modules=""
for file in "$@"; do
    for mod in "${GO_MODULES[@]}"; do
        if [[ "$file" == "$mod/"* || "$file" == "$REPO_ROOT/$mod/"* ]]; then
            case "$affected_modules" in
                *"|$mod|"*) ;;
                *) affected_modules="${affected_modules}|${mod}|" ;;
            esac
        fi
    done
done

if [ -z "$affected_modules" ]; then
    exit 0
fi

exit_code=0
for mod in "${GO_MODULES[@]}"; do
    case "$affected_modules" in
        *"|$mod|"*) ;;
        *) continue ;;
    esac
    mod_dir="$REPO_ROOT/$mod"
    if [ -f "$mod_dir/go.mod" ]; then
        echo "golangci-lint: $mod"
        if ! (cd "$mod_dir" && golangci-lint run --timeout=5m); then
            exit_code=1
        fi
    fi
done

exit $exit_code
