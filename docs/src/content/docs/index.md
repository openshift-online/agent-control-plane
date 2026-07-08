---
title: "Agent Control Plane"
---

Agent Control Plane (ACP) runs AI agents against real developer work: repositories, project context, credentials, messages, and long-running tasks. You can start work from the web UI, `acpctl`, the REST API, generated SDKs, or the MCP server.

ACP is not a CRD data model. The API server is a Go service backed by PostgreSQL and exposes `/api/ambient/v1/...` on port 8000. The control plane watches the API server over gRPC and creates Kubernetes runner Pods for sessions. Each runner is a Python AG-UI server with bridges for Claude Agent SDK, Gemini CLI, and LangGraph.

## Use ACP for

- Running a code agent on a repository with project instructions and credentials.
- Creating reusable project agents with standing prompts.
- Starting sessions from the UI, CLI, CI, scripts, SDKs, or MCP tools.
- Streaming messages and AG-UI events while the agent works.
- Inspecting files, Git state, repository status, artifacts, and MCP status for active sessions.

## First steps

1. Read [What is ACP?](getting-started/) for the system model.
2. Use [Quick start](getting-started/quickstart-ui/) to create a project, agent, and session from the UI.
3. Add a [Session Config Quickstart](getting-started/session-config/) repo when an agent needs shared instructions, Claude skills, or reusable team
   context.
4. Use [CLI Reference](getting-started/cli/) when you want repeatable automation from a terminal or CI job.
5. Try the [catalog lab](guides/vteam-lab/) when you want to apply a bundled multi-agent catalog.

## Core objects

- [Projects](concepts/projects/) group agents, sessions, credentials, and settings.
- [Sessions](concepts/sessions/) are the execution records that the control plane turns into runner Pods.
- [Credentials](concepts/credentials/) are credential records and sidecars that let runners reach GitHub, GitLab, Jira, Google, Vertex, and Kubernetes.
- [Context & artifacts](concepts/context-and-artifacts/) explains what the runner sees in `/workspace` and what you can retrieve afterward.
- [Workflows](concepts/workflows/) are optional Git-backed instruction bundles loaded into a session.
- [Scheduled sessions](concepts/scheduled-sessions/) are project records for recurring work; the current API stores and manages them, but automatic firing is not implemented in the API service yet.

## Automation paths

- [GitHub Actions](extensions/github-action/) can create or start sessions with `curl` or `acpctl`.
- [MCP Server](extensions/mcp-server/) exposes ACP project, agent, session, and message tools to MCP clients.
- [Bugfix](workflows/bugfix/), [triage](workflows/triage/), and [PRD/RFE](workflows/prd-rfe/) pages give prompt patterns you can run as ordinary ACP sessions.
