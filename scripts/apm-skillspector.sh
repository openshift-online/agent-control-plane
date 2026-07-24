#!/usr/bin/env bash
# Shared SkillSpector install/prompt helpers for APM wrapper scripts.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/apm-skillspector.sh"
#   ensure_skillspector          # optional — install may continue without it
#   require_skillspector         # required — scan commands exit if unavailable

install_skillspector_package() {
  if command -v uv &>/dev/null; then
    uv tool install git+https://github.com/NVIDIA/skillspector.git
    return 0
  fi
  if command -v pip &>/dev/null; then
    pip install --user "skillspector @ git+https://github.com/NVIDIA/skillspector.git"
    return 0
  fi
  echo "[!] Cannot install SkillSpector: no uv or pip found on PATH." >&2
  echo "    uv tool install git+https://github.com/NVIDIA/skillspector.git" >&2
  return 1
}

# shellcheck disable=SC2120
_ensure_skillspector() {
  local required="${1:-0}"
  local context="${2:-install}"

  if command -v skillspector &>/dev/null; then
    return 0
  fi

  if [[ "${APM_SKIP_SKILLSPECTOR:-}" == "1" ]]; then
    if [[ "$required" == "1" ]]; then
      echo "[!] SkillSpector is required for scan commands (APM_SKIP_SKILLSPECTOR=1 is set)." >&2
      return 1
    fi
    echo "[i] SkillSpector not installed (APM_SKIP_SKILLSPECTOR=1). Post-install scan skipped." >&2
    return 0
  fi

  local should_install=0

  if [[ "${APM_INSTALL_SKILLSPECTOR:-}" == "1" ]]; then
    should_install=1
  elif [[ -t 0 ]]; then
    if [[ "$required" == "1" ]]; then
      cat >&2 <<'EOF'
[i] SkillSpector is not installed. It is required to run security scans.
EOF
    else
      cat >&2 <<'EOF'
[i] SkillSpector is not installed. It scans deployed skills and commands for
    security issues after each install (warn mode — never blocks install).

    Strongly recommended when installing agent skills from upstream packages.
EOF
    fi
    local reply
    read -r -p "Install SkillSpector now? [Y/n] " reply
    reply="${reply:-Y}"
    case "$reply" in
      [nN]|[nN][oO])
        if [[ "$required" == "1" ]]; then
          echo "[!] Cannot run scan without SkillSpector." >&2
          echo "    Install later: uv tool install git+https://github.com/NVIDIA/skillspector.git" >&2
          return 1
        fi
        echo "[i] Skipping SkillSpector. APM install will continue without a post-install scan." >&2
        echo "    Install later: uv tool install git+https://github.com/NVIDIA/skillspector.git" >&2
        return 0
        ;;
    esac
    should_install=1
  else
    if [[ "$required" == "1" ]]; then
      echo "[!] SkillSpector not installed (non-interactive shell). Cannot run scan." >&2
      echo "    Install: uv tool install git+https://github.com/NVIDIA/skillspector.git" >&2
      echo "    Or: APM_INSTALL_SKILLSPECTOR=1 apm run scan-all" >&2
      return 1
    fi
    echo "[i] SkillSpector not installed (non-interactive shell). Post-install scan skipped." >&2
    echo "    Install later: uv tool install git+https://github.com/NVIDIA/skillspector.git" >&2
    echo "    Or: APM_INSTALL_SKILLSPECTOR=1 apm run install" >&2
    return 0
  fi

  if [[ "$should_install" == "1" ]]; then
    echo "[i] Installing SkillSpector..." >&2
    install_skillspector_package || true
  fi

  if ! command -v skillspector &>/dev/null; then
    if [[ "$required" == "1" ]]; then
      echo "[!] SkillSpector is still not on PATH. Cannot run $context." >&2
      return 1
    fi
    echo "[!] SkillSpector is still not on PATH. Post-install scan skipped." >&2
    return 0
  fi

  return 0
}

ensure_skillspector() {
  _ensure_skillspector 0 "install"
}

require_skillspector() {
  _ensure_skillspector 1 "scan"
}
