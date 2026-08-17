---
title: "Payloads"
---

Payloads are the mechanism for injecting files and repositories into the agent's sandbox before execution starts. They let you pre-load project instructions, configuration files, MCP settings, and source code so the agent has everything it needs from the moment it begins working.

## Types of payloads

| Type | Source field | What it does |
|------|-------------|--------------|
| **File payload** | `content` | Writes inline text to a path inside the sandbox |
| **Repo payload** | `repo_url` | Clones a Git repository into a directory inside the sandbox |

Each payload requires a `sandbox_path` — an absolute path under `/sandbox/` where the content is delivered. Exactly one of `content` or `repo_url` must be specified per entry.

## Payload fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sandbox_path` | string | yes | Absolute path inside the sandbox (must be under `/sandbox/`) |
| `content` | string | one of | Inline string content written to the path |
| `repo_url` | string | one of | Git repository URL to clone into the path |
| `ref` | string | no | Branch, tag, or commit SHA to check out (only valid with `repo_url`; defaults to the repository's default branch) |

## Common uses

**Project instructions** — Place a `CLAUDE.md` file at `/sandbox/CLAUDE.md` or `/sandbox/.claude/CLAUDE.md`. Claude Code reads this automatically and follows its instructions.

```yaml
payloads:
  - sandbox_path: /sandbox/CLAUDE.md
    content: "Whenever you say hello, also tell me how to say hello in a different language."
```

**Source code** — Clone a repository so the agent can read, analyze, or modify it.

```yaml
payloads:
  - sandbox_path: /sandbox/workspace
    repo_url: https://github.com/example/my-service.git
    ref: main
```

**Tool configuration** — Inject settings files, MCP server configs, or permissions.

```yaml
payloads:
  - sandbox_path: /sandbox/.claude/settings.json
    content: |
      {
        "permissions": {"allow": ["Bash", "Read", "Edit"]},
        "model": "claude-sonnet-4-20250514"
      }
```

## Combining payloads

An agent can declare multiple payloads. A typical pattern combines a repo payload for source code with file payloads for instructions and configuration:

```yaml
payloads:
  - sandbox_path: /sandbox/workspace
    repo_url: https://github.com/example/my-service.git
    ref: main
  - sandbox_path: /sandbox/.claude/CLAUDE.md
    content: |
      You are a security review agent. Focus on:
      - SQL injection in database queries
      - XSS in rendered templates
  - sandbox_path: /sandbox/.mcp.json
    content: |
      { "mcpServers": {} }
```

## When payloads are applied

Payloads are delivered during session setup, after the sandbox is created but before the agent's entrypoint process starts. The sequence is:

1. The sandbox container starts and reaches a ready state
2. All payloads are written into the sandbox filesystem
3. The agent's entrypoint (e.g. `claude`) launches and finds the files already in place

This guarantees the agent never runs without its expected files. If a payload fails to deliver (for example, a repository URL is unreachable), the session transitions to a failed state rather than starting without the expected content.

## CLI

```bash
# Apply an agent with payloads
acpctl apply -f agent.yaml --project my-project

# Start a session — payloads are injected automatically
acpctl agent start my-agent --project my-project
```
