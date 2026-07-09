---
title: "Quick start"
---

Use the web UI when you want to create a project, configure an agent, start a session, and watch the work happen.

## 1. Sign in

Open your ACP deployment URL and sign in with your organization SSO. The UI uses OIDC through Keycloak; API requests are made with bearer-token identity behind the UI.

## 2. Open a project

Create or select a project from the dashboard. In the API and CLI, this object is called a `project`; some UI text may still call it a workspace.

Use the project prompt for durable context that should apply to every agent and session in that project: repository conventions, review standards, product constraints, or deployment rules.

## 3. Add credentials

If the agent needs private repos or external tools, add project credentials before starting work. Supported credential records include GitHub, GitLab, Jira, Google, Vertex, and kubeconfig.

Credentials are stored by the API server, and token access is controlled by role bindings. When a session starts, the control plane resolves the credentials visible to that project or agent and injects them into the runner through sidecars or runner environment wiring.

## 4. Create an agent

Create an agent in the project with a short name and standing prompt. The prompt should describe the agent's role and constraints, not just the immediate task.

Example agent prompt:

```text
You maintain the API server. Follow the repository conventions, keep changes narrow,
run targeted tests, and explain any behavior change before finishing.
```

## 5. Start a session

Start the agent with a task prompt. ACP creates or reuses an active session for that agent, drains unread inbox messages into the start context, and transitions the session to `Pending`.

The control plane then creates a runner Pod. When the runner is reachable, the session moves toward `Running` and starts streaming messages and AG-UI events.

## 6. Add a session-config harness

Use a [session-config repo](../session-config/) when an agent needs shared team
instructions, Claude skills, reusable review checklists, or curated Library
content. The day-0 path mounts that repo into `/sandbox/session-config` through
Agent YAML applied with `acpctl apply`.

## 7. Work with the session

Use the session view to follow the conversation, send more messages, inspect events, and review available file, Git, repository, workspace, and MCP status panels. These panels are backed by runner endpoints and are most useful while the session Pod is running.

Stop the session when the work is no longer needed. Stopping a session asks the control plane to remove the runner resources and move the session out of the active phases.

## CLI equivalent

```bash
acpctl login https://acp.example.com --use-auth-code --project my-project
acpctl agent create --name api-maintainer --prompt "You maintain the API server."
acpctl agent start api-maintainer --prompt "Find and fix the failing auth test."
acpctl get sessions -w
```
