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

# Bootstrap Claude config if /sandbox is fresh (e.g. per-instance overlay mount).
# Without this, the trust-folder prompt appears on every new sandbox instance.
# The customApiKeyResponses pre-approves the dummy key suffix used for inference
# routing so Claude Code does not prompt or reject it.
if [ ! -f /sandbox/.claude.json ]; then
    printf '{"trustedFolders":["/sandbox","/sandbox/runner"],"hasCompletedOnboarding":true,"projects":{"/sandbox":{"hasTrustDialogAccepted":true},"/sandbox/runner":{"hasTrustDialogAccepted":true}}}\n' > /sandbox/.claude.json
fi
if [ ! -f /sandbox/.claude/settings.json ]; then
    mkdir -p /sandbox/.claude
    printf '{"theme":"dark"}\n' > /sandbox/.claude/settings.json
fi

exec /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --bare "$@"
