#!/bin/bash
# Claude-specific wrapper for OpenShell sandboxes.
#
# ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, HTTPS_PROXY, NODE_EXTRA_CA_CERTS,
# and other proxy/TLS vars are set at the sandbox level by the control plane
# reconciler and the OpenShell supervisor — they apply to all tools, not just
# Claude. This wrapper only handles Claude Code-specific setup.
# Guard against infinite recursion: this script is installed as /usr/local/bin/claude,
# so when Claude Code spawns subagents that invoke `claude` by name, PATH resolves
# back here. A file-based guard is used instead of an env var because the sandbox
# supervisor spawns each command in a clean environment that does not inherit exports.
export HOME=/sandbox
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1

GUARD="/tmp/.claude-wrapper-initialized"
if [ -f "$GUARD" ]; then
    exec /opt/claude/bin/claude --bare "$@"
fi
touch "$GUARD"

OPENSHELL_CA="/etc/openshell-tls/openshell-ca.pem"
if [ -f "$OPENSHELL_CA" ] && [ -z "$ANTHROPIC_BASE_URL" ]; then
    export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-inference-routing}"
    export ANTHROPIC_BASE_URL="https://inference.local"
    export HTTPS_PROXY="http://10.200.0.1:3128"
    export NODE_EXTRA_CA_CERTS="$OPENSHELL_CA"
fi

exec /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --bare "$@"
