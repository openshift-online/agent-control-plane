---
title: "Multi-Agent Teams"
---

Multiple agents can collaborate on complex work by splitting responsibilities across specialized roles. Instead of configuring a single agent to handle everything, you define a team of agents within a project, each with its own prompt, model, and repository context.

## Why multi-agent

**Specialization.** A security reviewer agent uses a different prompt and model than a documentation writer. Separate agents let you tailor each role without overloading a single system prompt.

**Parallelism.** Independent agents run as separate sessions. A code implementer and a technical writer can work concurrently on the same project without blocking each other.

**Composability.** Teams are built from reusable agent definitions. You can add or remove roles as project needs change without redesigning the entire workflow.

## Team patterns

ACP ships two catalog examples you can use as starting points.

| Pattern | Project | Roles |
|---------|---------|-------|
| Product swarm | `vteam-product-swarm` | Cross-functional delivery: product manager, engineer, designer, researcher, writer |
| Codebase maintainers | `codebase-maintainers` | Internal upkeep: implementation, runtime readiness, CI, security, docs, release gates |

The manifests live in `examples/vteam-catalog/`. See the [Lab guide](/guides/vteam-lab/) to apply them.

### Product swarm

Models a cross-functional product team. Agents follow natural collaboration flows:

- **Design flow** -- architect, team lead, designer refine UX iteratively
- **Technical flow** -- architect, staff engineer, team lead, implementer move from design to code
- **Content flow** -- content strategist, writing manager, technical writer produce documentation
- **Delivery flow** -- product manager, delivery owner, product owner, scrum master coordinate execution

### Codebase maintainers

Models an internal engineering team focused on repository health. Agents cover implementation, CI pipelines, security audits, documentation, and release readiness as distinct roles.

## How agents coordinate

Agents in a team share a project. Coordination happens through the resources that project provides:

| Mechanism | How it works |
|-----------|--------------|
| Shared repository | Agents push to branches in the same repo. One agent's output becomes another's input. |
| Session annotations | Agents write structured annotations to their sessions. Other agents or workflows read those annotations to decide next steps. |
| Providers | Shared provider credentials (GitHub, Jira, etc.) give the whole team access to the same external services. |
| Gateway | A project-scoped gateway provides sandbox execution for all agents in the team. |

Agents do not communicate directly. Instead, they produce artifacts -- commits, annotations, PR comments -- that other agents consume. This keeps coordination explicit and auditable.

## Setting up a team

1. **Create a project** to serve as the team workspace.

   ```bash
   acpctl project create --name my-team
   ```

2. **Define agents** with specialized prompts and roles.

   ```bash
   acpctl agent create --project my-team \
     --name reviewer \
     --prompt "Review pull requests for security and correctness issues"

   acpctl agent create --project my-team \
     --name implementer \
     --prompt "Implement features from GitHub issues following project conventions"
   ```

3. **Add shared providers** so agents can access external services.

   ```bash
   acpctl provider create --project my-team \
     --name github --type github
   ```

4. **Start agents** as needed. Each start creates an independent session.

   ```bash
   acpctl agent start --project my-team reviewer
   acpctl agent start --project my-team implementer
   ```

For a complete walkthrough using the bundled catalog teams, see the [Lab guide](/guides/vteam-lab/).
