---
title: "Providers"
---

A provider connects an agent to an external service. Providers are the bridge between ACP's credential system and the runtime integrations an agent needs — model inference, source control, issue tracking, and more.

## What a provider does

When an agent lists a provider in its definition, ACP ensures the corresponding credentials and runtime wiring are available when a session starts. This includes:

- Resolving the credential (token, URL, email) from global, project, or agent scope.
- Injecting credential sidecars or environment variables into the runner pod.
- Exposing MCP tools for providers that support them (GitHub, Jira).

## Built-in provider types

| Type | Service | What it enables |
|------|---------|----------------|
| `vertex` | Google Vertex AI | Claude model inference via Vertex AI endpoints |
| `github` | GitHub | Repository access, PR operations, issue management via MCP tools |
| `jira` | Atlassian Jira | Issue search, creation, updates via MCP tools |
| `google` | Google Cloud | GCP service access via service account |
| `gitlab` | GitLab | Repository and merge request access |
| `kubeconfig` | Kubernetes | Cluster access for agents that manage infrastructure |
| `generic` | Any | Custom integrations with token-based authentication |

## Provider definition

Providers are defined as ACP resources with a name, type, and credential secret reference:

```yaml
kind: Provider
name: vertex
type: vertex
secret: vertex-sa-key
```

```yaml
kind: Provider
name: github
type: github
secret: github-creds
```

The `secret` field references an ACP credential record, not a Kubernetes Secret directly.

## How providers appear in agents

An agent lists the providers it needs. The control plane resolves credentials at session start:

```yaml
kind: Agent
name: my-agent
providers:
  - vertex    # Model inference
  - github    # GitHub API access via MCP
  - jira      # Jira access via MCP
```

If a required provider's credentials are not configured, the session will fail during setup.

## MCP tool providers

Some providers expose their functionality as MCP (Model Context Protocol) tools. When a session starts with a GitHub or Jira provider, ACP injects a credential sidecar that runs an MCP server. The agent can then call tools like `mcp__github__get_pull_request` or `mcp__jira__search_issues` directly.

## Credential resolution order

When multiple credentials exist for the same provider type, ACP resolves them in priority order:

1. **Agent-level credentials** — most specific, wins if present.
2. **Project-level credentials** — shared across agents in the project.
3. **Global credentials** — platform-wide defaults.

A more specific credential overrides a less specific one for the same provider type.

## CLI examples

```bash
# Create a credential for a provider
acpctl credential create --name vertex --provider vertex --token "$SA_KEY" --project my-project
acpctl credential create --name github --provider github --token "$GITHUB_TOKEN" --project my-project

# Apply a provider definition
acpctl apply -f examples/base/providers/vertex.yaml --project my-project

# List providers in a project
acpctl get providers --project my-project
```
