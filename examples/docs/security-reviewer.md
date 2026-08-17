# Security Reviewer Agent

A focused security analysis agent that scans code for vulnerabilities. This is the most minimal example of a **single-provider, no-payload agent** — its behavior is defined entirely by its prompt.

## What it does

The agent analyzes code in the session workspace for common security vulnerabilities:

- Injection attacks (SQL, command, path traversal)
- Authentication and authorization issues
- Insecure data handling (hardcoded secrets, unencrypted storage)
- OWASP Top 10 patterns

For each finding, the agent reports severity, file location, and actionable remediation guidance.

## Agent definition

```yaml
kind: Agent
name: security-reviewer
sandbox_policy: permissive
prompt: |
  You are a security reviewer. Analyze code for vulnerabilities including
  injection attacks, authentication issues, and insecure data handling.
  Report findings with severity, location, and remediation guidance.
providers:
  - vertex
labels:
  purpose: security
  tier: critical
```

## Key concepts demonstrated

| Concept | How it's used |
|---------|---------------|
| Prompt-only agent | No payloads, no environment variables — the prompt defines all behavior |
| Labels | `tier: critical` enables filtering agents by priority or domain |
| Minimal configuration | Shows the smallest viable agent definition beyond hello-world |

## How to run

```bash
# Apply the agent
acpctl apply -f examples/base/agents/security-reviewer.yaml --project my-project

# Run a security review on a repository
acpctl agent start security-reviewer --project my-project \
  --prompt "Scan the repository for security vulnerabilities, focusing on the API handlers"

# Watch findings
acpctl session messages <session-id> -f
```

## Customization ideas

- **Add a compliance payload**: Inject a checklist (like the PR Reviewer does) with your organization's security standards.
- **Combine with GitHub provider**: Add the `github` provider to let the agent post findings as PR review comments.
- **Scheduled scans**: Use scheduled sessions to run weekly security reviews on your main branch.
