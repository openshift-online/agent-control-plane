---
title: "CLI Reference"
---

`acpctl` is the command-line interface for ACP. Use it for project setup, credentials, agents, sessions, message streaming, scheduled-session records, and CI automation.

## Build or install

If your deployment provides a binary, use that. From this repository:

```bash
cd components/ambient-cli
go build -o acpctl ./cmd/acpctl
```

## Login

`acpctl` stores config in `~/.config/ambient/config.json` unless `AMBIENT_CONFIG` is set.

```bash
acpctl login https://acp.example.com --use-auth-code --project my-project
acpctl login https://acp.example.com --token "$AMBIENT_TOKEN" --project my-project
acpctl login https://acp.example.com --client-credentials \
  --issuer-url "$OIDC_ISSUER_URL" \
  --client-id "$OIDC_CLIENT_ID" \
  --client-secret "$OIDC_CLIENT_SECRET"
```

Useful environment overrides:

```bash
export AMBIENT_API_URL=https://acp.example.com
export AMBIENT_TOKEN=...
export AMBIENT_PROJECT=my-project
```

## Projects

```bash
acpctl project list
acpctl create project --name my-project --description "Automation for the API team"
acpctl project set my-project
acpctl project current
acpctl project update my-project --prompt "Follow our repository standards and keep changes narrow."
```

The CLI uses the configured project for project-scoped commands unless you pass `--project-id`.

## Credentials

Create credentials for private repositories and external tools:

```bash
acpctl credential create \
  --name github-main \
  --provider github \
  --token "$GITHUB_TOKEN"

acpctl credential create \
  --name jira \
  --provider jira \
  --url https://example.atlassian.net \
  --email dev@example.com \
  --token "$JIRA_API_TOKEN"

acpctl credential list --provider github
acpctl credential bind github-main --project my-project
```

Supported CLI provider values are `github`, `gitlab`, `jira`, `google`, and `kubeconfig`. The OpenAPI credential schema also includes `vertex`.

Avoid printing tokens in logs or CI output. `acpctl credential token <id>` returns the stored token only if your role bindings allow `credential:token-reader`.

## Agents

Agents are the normal way to run repeatable work.

```bash
acpctl agent create \
  --name api-maintainer \
  --prompt "You maintain the API server. Follow CLAUDE.md and run targeted tests."

acpctl agent list
acpctl agent get api-maintainer
acpctl agent start api-maintainer --prompt "Fix the failing session status test."
acpctl agent start-preview api-maintainer
acpctl agent sessions api-maintainer
acpctl agent stop api-maintainer
```

`agent start` is idempotent: if the agent already has an active session, the API returns it instead of creating another one.

## Sessions

You can create one-off sessions directly, then start or stop them through the session lifecycle endpoints.

```bash
acpctl create session \
  --name investigate-auth \
  --project-id my-project \
  --prompt "Find why expired tokens return 500 instead of 401." \
  --repo-url https://github.com/acme/service.git

acpctl get sessions
acpctl get sessions -w
acpctl get session <session-id> -o json
acpctl stop <session-id>
```

For a project-agent ID, the root command also starts an agent session:

```bash
acpctl start <project-agent-id> --project-id my-project --prompt "Run triage."
```

## Messages and events

```bash
acpctl session messages <session-id>
acpctl session messages <session-id> -f
acpctl session messages <session-id> -F
acpctl session send <session-id> "Continue with a smaller patch." -f
acpctl session events <session-id>
```

`messages -f` streams until the current turn finishes. `messages -F` reconnects continuously. `events` streams raw AG-UI events from the runner while the runner is reachable.

## Scheduled-session records

The CLI manages scheduled-session records exposed by the API:

```bash
acpctl scheduled-session create \
  --name weekday-triage \
  --agent-id api-maintainer \
  --schedule "0 9 * * 1-5" \
  --timezone America/New_York \
  --prompt "Triage new issues and produce a summary."

acpctl scheduled-session list
acpctl scheduled-session suspend weekday-triage
acpctl scheduled-session resume weekday-triage
acpctl scheduled-session trigger weekday-triage
acpctl scheduled-session runs weekday-triage
```

Current server behavior stores and updates these records. Automatic cron execution and run history population are not implemented in the API service yet.

## Inbox

Agents have project-scoped inbox messages. Starting an agent drains unread inbox messages into the start context and marks them read.

```bash
acpctl inbox send --project-id my-project --pa-id api-maintainer --body "Please review the auth changes."
acpctl inbox list --project-id my-project --pa-id api-maintainer
acpctl inbox mark-read --project-id my-project --pa-id api-maintainer --msg-id <message-id>
```

## Generic resources

```bash
acpctl get projects
acpctl get agents --project-id my-project
acpctl get credentials -o json
acpctl describe session <session-id>
acpctl delete session <session-id>
acpctl apply -f resources.yaml
acpctl ambient
acpctl completion bash
```

Use `-o json` for scripts. Use `--api-url` or `AMBIENT_API_URL` when a job should target a specific deployment.
