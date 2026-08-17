# PR Reviewer Agent

An automated GitHub Pull Request reviewer that analyzes diffs against a structured checklist and produces a severity-graded report. This agent demonstrates how to combine **multiple providers**, **MCP tool integration**, and **payload-driven behavior** to build a useful code review automation.

## What it does

When given a PR reference (repository and number), the agent:

1. **Fetches PR metadata** — title, description, author, base/head branches via GitHub MCP tools
2. **Retrieves the full diff** — changed files and line-by-line diffs
3. **Reads existing review comments** — to avoid duplicating feedback already given
4. **Analyzes changes against a checklist** — covering security, code quality, tests, architecture, breaking changes, and documentation
5. **Produces a structured report** grouped by severity:
   - `CRITICAL` — must be fixed before merge
   - `WARNING` — should be addressed, may block merge
   - `INFO` — suggestions, style, non-blocking observations
6. **Ends with a recommendation** — `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`

## Agent definition

```yaml
kind: Agent
name: pr-reviewer
sandbox_policy: permissive
prompt: |
  You are an expert PR reviewer. The session prompt will tell you which
  pull request to review (repository and PR number or URL).
  Use the GitHub MCP tools to fetch PR data and analyze changes.
providers:
  - vertex
  - github
payloads:
  - sandbox_path: /sandbox/PR_REVIEW_CHECKLIST.md
    content: |
      # PR Review Checklist
      ## Security
      - [ ] No secrets, tokens, or credentials hardcoded in the diff
      - [ ] User-supplied input is validated and sanitized
      ...
```

## Key concepts demonstrated

| Concept | How it's used |
|---------|---------------|
| Multiple providers | `vertex` for inference + `github` for GitHub API access |
| MCP tools | The agent uses `mcp__github__*` functions to interact with GitHub — not the `gh` CLI |
| Payload as skill | The checklist is injected at `/sandbox/PR_REVIEW_CHECKLIST.md`, giving the agent domain-specific review criteria |
| Structured output | The prompt instructs the agent to produce findings with file paths, line numbers, severity, and remediation |

## Prerequisites

GitHub credentials must be configured for the project. The credential provides API access through the GitHub MCP sidecar, which exposes GitHub operations as MCP tools the agent can call.

```bash
acpctl credential create --name github --provider github --token "$GITHUB_TOKEN" --project my-project
```

## How to run

```bash
# Apply the agent
acpctl apply -f examples/base/agents/pr-reviewer.yaml --project my-project

# Start a review session
acpctl agent start pr-reviewer --project my-project \
  --prompt "Review PR #42 in my-org/my-repo"

# Watch the review output
acpctl session messages <session-id> -f
```

## Customization ideas

- **Team-specific checklist**: Replace the payload with your team's review standards — add performance budgets, accessibility checks, or compliance requirements.
- **Auto-trigger on PR creation**: Combine with a scheduled session to run the reviewer on every new PR in a repository.
- **Multi-repo reviewer**: Modify the prompt to accept multiple PRs and produce a consolidated report.
