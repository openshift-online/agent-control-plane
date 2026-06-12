---
title: "Projects"
---

In the UI, a workspace is the top-level place where a team runs agents. In the API, CLI, database, and control plane, the same object is called a project.

Use project terminology when scripting against ACP:

```text
/api/ambient/v1/projects
acpctl project list
acpctl agent list --project-id <project-id>
```

## What a project owns

A project groups:

- agents and their standing prompts.
- sessions and session message logs.
- project-scoped credentials.
- project settings.
- role bindings for users, agents, sessions, and credentials.
- project prompt context.
- the Kubernetes namespace used by the control plane for runner resources.

Projects are stored in PostgreSQL, not Kubernetes CRDs.

## Project prompt

The project prompt is durable context injected into agent starts and session prompt assembly. Put stable instructions here:

- repository conventions.
- testing expectations.
- security or compliance constraints.
- ownership and escalation rules.
- links or names for internal systems the agent should know.

Keep one-off task details in the session or agent-start prompt.

## Project settings

The API exposes `project_settings` records for project-level configuration. Use settings for structured project data that should be read by multiple sessions or tools. Keep secrets in credentials, not settings.

## Access control

Project access is represented with role bindings. Built-in project roles include:

- `project:owner`
- `project:editor`
- `project:viewer`

Role bindings can be scoped globally, to a project, to an agent, to a session, or to a credential. Credential token reads require a credential token-reader permission; creating a credential also creates an owner binding for the creator.

## Kubernetes namespace

When a session runs, the control plane provisions or resolves a namespace for the project. Session child resources are labeled and cleaned up from that namespace:

- runner Pod.
- Service.
- ServiceAccount.
- generated Secrets.
- optional MCP and credential sidecars.

The namespace is runtime infrastructure. The project record in PostgreSQL remains the source of truth.

## CLI examples

```bash
acpctl create project --name payments --description "Payments automation"
acpctl project set payments
acpctl project update payments --prompt "Follow payments service conventions and run targeted tests."
acpctl project list
```
