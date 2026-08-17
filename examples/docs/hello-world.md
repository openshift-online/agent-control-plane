# Hello World Agent

The simplest possible agent — a starting point for understanding how ACP agents work. It sends a greeting and demonstrates two foundational ACP features: **payload injection** and **environment variables**.

## What it does

When started, the agent runs a single prompt ("Say hello world") using Claude via Vertex AI. What makes it interesting is not the prompt itself, but the two mechanisms it shows:

1. **Payload injection** — A `CLAUDE.md` file is written into the sandbox at `/sandbox/CLAUDE.md` before the agent starts. Claude Code reads this file automatically and follows its instructions. In this case, the payload tells the agent to also say hello in a different language every time it greets.

2. **Environment variables** — The `ENV_NAME` variable is injected into the runner pod. Agents can use environment variables for configuration that varies across deployments without changing the agent definition.

## Agent definition

```yaml
kind: Agent
name: hello-world
sandbox_policy: permissive
prompt: "Say hello world"
providers:
  - vertex
payloads:
  - sandbox_path: /sandbox/CLAUDE.md
    content: "Whenever you say hello, also tell me how to say hello in a different language."
environment:
  ENV_NAME: "test"
labels:
  purpose: testing
```

## Key concepts demonstrated

| Concept | How it's used |
|---------|---------------|
| Payloads | `CLAUDE.md` injected at `/sandbox/CLAUDE.md` — Claude Code reads this automatically as project instructions |
| Environment variables | `ENV_NAME` set to `"test"` — available inside the runner pod |
| Sandbox policy | Uses `permissive` — allows network access for Vertex AI inference |
| Providers | `vertex` — connects to Vertex AI for Claude model access |
| Labels | `purpose: testing` — metadata for filtering and organization |

## How to run

```bash
# Apply the agent to your project
acpctl apply -f examples/base/agents/hello-world.yaml --project my-project

# Start a session
acpctl agent start hello-world --project my-project --prompt "Say hello"

# Watch the session output
acpctl session messages <session-id> -f
```

## What to try next

- Change the payload content to give the agent a different personality or instruction set.
- Add more environment variables and reference them in the prompt.
- Switch to the `locked-down` sandbox policy to see how network restrictions affect the agent.
