#!/bin/bash
export HOME=/sandbox
export ANTHROPIC_BASE_URL=https://inference.local
# Sentinel value: the gateway proxy intercepts requests before reaching Anthropic.
# The actual API key is managed by the gateway's credential provider, not the runner.
export ANTHROPIC_API_KEY=gateway
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1

# Supervisor proxy — all sandbox traffic routes through it; inference.local
# is a virtual hostname the proxy intercepts (no DNS entry exists).
export HTTPS_PROXY=http://10.200.0.1:3128
export NO_PROXY=127.0.0.1,localhost

# Trust the OpenShell self-signed CA so Node.js accepts inference.local TLS.
if [ -f /etc/openshell-tls/openshell-ca.pem ]; then
    export NODE_EXTRA_CA_CERTS=/etc/openshell-tls/openshell-ca.pem
fi

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
