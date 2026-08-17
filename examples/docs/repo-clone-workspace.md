# Repo Clone Workspace Agent

An agent that starts with a Git repository already cloned into its sandbox. This example demonstrates the **repo payload** feature — a payload type that clones a repository at a specific ref into the agent's workspace before execution begins.

## What it does

The agent starts with a repository cloned at `/sandbox/workspace` and explores its contents. This is useful for agents that need to analyze, review, or work with code from external repositories without requiring Git credentials at runtime.

## Agent definition

```yaml
kind: Agent
name: repo-clone-workspace
prompt: "Describe the repository you have access to"
providers:
  - vertex
payloads:
  - sandbox_path: /sandbox/CLAUDE.md
    content: "You have a cloned repository at /sandbox/workspace. Explore it."
  - sandbox_path: /sandbox/workspace
    repo_url: https://github.com/octocat/Hello-World.git
    ref: master
labels:
  purpose: testing
```

## Key concepts demonstrated

| Concept | How it's used |
|---------|---------------|
| Repo payload | `repo_url` + `ref` clones a repository into the sandbox before the agent starts |
| Multiple payloads | Combines a file payload (`CLAUDE.md`) with a repo payload (`workspace`) |
| Workspace setup | The cloned repo is available at `/sandbox/workspace` — the agent can read, analyze, or modify it |

## How repo payloads work

Unlike file payloads (which write content inline), repo payloads clone an entire Git repository:

```yaml
payloads:
  - sandbox_path: /sandbox/workspace    # Where to clone
    repo_url: https://github.com/org/repo.git  # Repository URL
    ref: main                            # Branch, tag, or commit SHA
```

The clone happens during session setup, before the agent's prompt runs. The agent sees the repository as a local directory and can navigate it with standard file operations.

## How to run

```bash
# Apply the agent
acpctl apply -f examples/base/agents/repo-clone-workspace.yaml --project my-project

# Start a session — the repo is cloned automatically
acpctl agent start repo-clone-workspace --project my-project \
  --prompt "List the files and describe the project structure"

# Watch the output
acpctl session messages <session-id> -f
```

## Customization ideas

- **Code review on external repos**: Point `repo_url` at a repository your team depends on and ask the agent to analyze it.
- **Multi-repo workspace**: Add multiple repo payloads at different `sandbox_path` locations to give the agent access to several repositories.
- **Pin to a specific commit**: Use a commit SHA as `ref` to ensure reproducible analysis across runs.
