# vTeam Catalog Examples

This directory contains ACP-native vTeam Catalog examples. vTeam is the
multi-agent collaboration concept that predates ACP, and these examples map that
concept onto existing ACP declarative primitives:

- `Project` for the team workspace.
- `Agent` for every team member.
- `Provider` for shared runtime integrations.
- Labels and annotations for vTeam metadata, reporting lines, install version,
  and known gaps.
- Agent inbox seeds for first-run coordination and recurring-work reminders.
- `payloads.repo_url` for portable session configuration repositories.

ACP does not currently have a first-class `vTeam`, install preview,
reporting-line, versioned install, scheduled-task manifest kind, or
`acpctl session --team` / `--scr` flag. These examples intentionally do not add
those concepts. They map the vTeam Catalog shape onto resources that
`acpctl apply -k` already understands.

## Product Swarm

`product-swarm/` creates a cross-functional product delivery swarm with an
Amber, Parker, Ryan, Stella, Steve, and Terry, matching the active ACP agent
personas under `docs/internal/agents/active/`.

Each agent also mounts the session config reference repo into
`/sandbox/session-config`:

```yaml
payloads:
  - sandbox_path: /sandbox/session-config
    repo_url: https://github.com/ambient-code/session-config-reference
    ref: main
```

That is the deployable lower-level mapping for the proposed CLI sugar:

```bash
acpctl session --team=bingo -p "check for new issues"
acpctl session --scr=https://github.com/ambient-code/session-config-reference -p "check for new issues"
```

In the current repo, a future `--team` could resolve a named catalog team to a
project and agent set. A future `--scr` could inject the same
`payloads.repo_url` entry into the launched session or selected agent.

Apply it to a local ACP cluster:

```bash
acpctl apply -k examples/vteam-catalog/product-swarm --project vteam-product-swarm
```

For a full manual reload from a fresh local Kind cluster, use
[QUICKSTART.md](QUICKSTART.md).

The product swarm also includes a synthetic work packet for a Team Creation
onboarding wizard:

```bash
open examples/vteam-catalog/product-swarm/work/team-creation-onboarding-wizard.md
```

If the project is not already your active context, the explicit `--project`
argument is important because ACP agents are project-scoped.

The provider declarations reference these Kubernetes Secret names:

- `vertex-sa-key`
- `github-creds`
- `jira`

Create those secrets in the project namespace before starting sessions that need
the providers. Applying the catalog creates the ACP records; missing provider
secrets become runtime issues when an agent session starts.

## Codebase Maintainers

`codebase-maintainers/` creates a four-agent maintenance team for an internal
devtooling codebase. It is not product-facing. It treats the codebase as both
software and a managed program with explicit ownership for code health,
runtime/demo readiness, CI, security, docs, release gates, and human decisions.

The catalog includes:

- `lead-maintainer` for operating picture, prioritization, work routing, and
  the human decision queue.
- `code-maintainer` for implementation quality, bug investigation, refactors,
  repo conventions, and API/SDK drift.
- `runtime-maintainer` for Kind, OpenShell, runners, sessions, manifests,
  images, demo readiness, and cleanup.
- `quality-maintainer` for tests, CI, security checks, docs verification,
  release gates, and final proceed/no-proceed evidence.

Apply it to a local ACP cluster:

```bash
acpctl apply -k examples/vteam-catalog/codebase-maintainers --project codebase-maintainers
```

The example also includes a synthetic work packet:

```bash
open examples/vteam-catalog/codebase-maintainers/work/release-readiness-assessment.md
```

The provider declarations reference these Kubernetes Secret names:

- `vertex-sa-key`
- `github-creds`
- `runtime-kubeconfig`

Create those secrets in the project namespace before starting sessions that need
the providers. Applying the catalog creates the ACP records; missing provider
secrets become runtime issues when an agent session starts.
