#!/bin/bash
# Claude-specific wrapper for OpenShell sandboxes.
#
# ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, HTTPS_PROXY, NODE_EXTRA_CA_CERTS,
# and other proxy/TLS vars are set at the sandbox level by the control plane
# reconciler and the OpenShell supervisor — they apply to all tools, not just
# Claude. This wrapper only handles Claude Code-specific setup.
export HOME=/sandbox
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1

# Bootstrap Claude config if /sandbox is fresh (e.g. per-instance overlay mount).
# Without this, the trust-folder prompt appears on every new sandbox instance.
if [ ! -f /sandbox/.claude.json ]; then
    printf '{"trustedFolders":["/sandbox"],"hasCompletedOnboarding":true}\n' > /sandbox/.claude.json
fi
if [ ! -f /sandbox/.claude/settings.json ]; then
    mkdir -p /sandbox/.claude
    printf '{"theme":"dark"}\n' > /sandbox/.claude/settings.json
fi

exec /opt/claude/bin/claude --bare "$@"
