---
title: "Sandbox Policies"
---

A sandbox policy defines the security boundaries of an agent's execution environment. It controls which files the agent can read and write, which network endpoints it can reach, and what system privileges it has.

## What a policy controls

| Area | What it governs |
|------|----------------|
| Filesystem | Which paths are read-only, read-write, or inaccessible |
| Network | Which external endpoints (host + port) the agent can connect to, and which binaries can make those connections |
| Process | Which user and group the sandbox process runs as |
| Landlock | Linux kernel-level filesystem access control (LSM) |

## Built-in policies

ACP ships two example policies:

### Permissive

Allows network access to common services — Vertex AI, GitHub, Jira, PyPI, and more. Each network rule is scoped to specific binaries (e.g., only `claude` can reach Anthropic endpoints, only `git` can reach GitHub).

```yaml
kind: Policy
name: permissive
spec:
  version: 1
  filesystem:
    read_only: [/usr, /lib, /opt, /proc, /etc, ...]
    read_write: [/sandbox, /tmp, /dev/null]
  network_policies:
    claude_code_vertex:
      endpoints:
        - { host: "*-aiplatform.googleapis.com", port: 443 }
        - { host: api.anthropic.com, port: 443 }
      binaries:
        - { path: /usr/local/bin/claude }
    github_rest_api:
      endpoints:
        - { host: api.github.com, port: 443, access: read-only }
      binaries:
        - { path: /usr/local/bin/claude }
        - { path: /usr/bin/gh }
```

### Locked-down

Allows only filesystem access — no network rules defined. The agent can read system paths and write to `/sandbox` and `/tmp`, but cannot make any outbound network connections.

```yaml
kind: Policy
name: locked-down
spec:
  version: 1
  filesystem:
    read_only: [/usr, /lib, /opt, /proc, /etc, ...]
    read_write: [/sandbox, /tmp, /dev/null]
  process:
    run_as_user: sandbox
    run_as_group: sandbox
```

## How policies are assigned

An agent references a policy by name in its definition:

```yaml
kind: Agent
name: my-agent
sandbox_policy: permissive
```

The gateway enforces the policy when creating the sandbox for a session.

## Network policy structure

Each network policy rule has three parts:

1. **Name** — identifies the rule (e.g., `claude_code_vertex`, `github_rest_api`).
2. **Endpoints** — which hosts and ports are allowed, with optional protocol, TLS, and access level.
3. **Binaries** — which executables can use this rule. Only matching binaries can connect to the specified endpoints.

This binary-scoping means that even if the `github_rest_api` rule allows `api.github.com`, only the listed binaries (like `claude` or `gh`) can reach it — a random script in the sandbox cannot.

## Filesystem layout

All policies share the same filesystem structure:

| Path | Access | Purpose |
|------|--------|---------|
| `/sandbox` | Read-write | Agent workspace — code, payloads, outputs |
| `/tmp` | Read-write | Temporary files |
| `/usr`, `/lib`, `/opt` | Read-only | System binaries and libraries |
| `/proc` | Read-only | Process information |
| `/etc` | Read-only | System configuration |

## When to use each policy

- **Permissive** — Default for most agents. Use when the agent needs to call external APIs (inference, GitHub, Jira, package registries).
- **Locked-down** — Use for agents that only need to analyze local files with no external access. Good for security-sensitive workloads where network isolation is required.
- **Custom** — Create your own policy when you need fine-grained control. Start from the permissive policy and remove or add rules for your use case.
