# Examples

This directory contains example Agent, Provider, Gateway, and Credential definitions for the Agent Control Plane. The examples are organized into two tiers:

- **Starter Examples** (`base/` + `overlays/`) — individual agents scoped to simple tenant projects. Start here.
- **vTeam Lab** (`vteam-catalog/`) — multi-agent virtual teams that demonstrate building agentic teams with coordination, specialization, and shared work.

## Prerequisites

If you are using a hosted ACP environment, your administrators provide Vertex
AI access; you only need to supply your own integration credentials, such as
GitHub and Jira, for examples that use those providers.

---

## Starter Examples

Simple, single-agent examples organized into two tenants. Use these to learn how Agents, Providers, Gateways, and Credentials fit together.

### Structure

```
examples/
├── base/
│   ├── agents/              # Agent definitions (provider-agnostic)
│   │   ├── hello-world.yaml
│   │   ├── security-reviewer.yaml
│   │   ├── jira-simple-whoami.yaml
│   │   ├── jira-simple-whoami-with-skill-payload.yaml
│   │   ├── pr-reviewer.yaml
│   │   └── jira-issue-categorizer.yaml
│   ├── gateways/            # Base gateway template
│   │   └── openshell-gateway.yaml
│   └── providers/           # Boilerplate provider integrations (shared by all tenants)
│       ├── vertex.yaml
│       ├── github.yaml
│       └── jira.yaml
└── overlays/
    ├── tenant-a/            # Development tenant
    │   ├── project.yaml
    │   ├── gateway.yaml     # Project-scoped gateway with tenant DNS names
    │   ├── credential-vertex.yaml
    │   ├── credential-jira.yaml
    │   └── credential-github.yaml
    └── tenant-b/            # Staging tenant
        ├── project.yaml
        ├── gateway.yaml
        ├── credential-vertex.yaml
        └── credential-github.yaml
```

`base/` contains resources shared across all tenants: agent definitions and boilerplate provider integrations (vertex, github, jira). `overlays/` contains the tenant-specific Project, Gateway, and Credentials.

### Applying

#### Using kustomize overlays (single command per tenant)

```bash
# Apply to development tenant
acpctl apply -k examples/overlays/tenant-a/ --project tenant-a

# Apply to staging tenant
acpctl apply -k examples/overlays/tenant-b/ --project tenant-b
```

#### Using file-based apply (base agents + overlay per tenant)

```bash
# tenant-a
acpctl apply -f examples/base/agents --project tenant-a
acpctl apply -f examples/overlays/tenant-a --project tenant-a

# tenant-b
acpctl apply -f examples/base/agents --project tenant-b
acpctl apply -f examples/overlays/tenant-b --project tenant-b
```

The `--project` flag (or `acpctl project <name>` beforehand) tells the CLI which project to scope Agents, Providers, and Gateways to.

### What Gets Applied

Each overlay applies the full declarative stack via a single `acpctl apply -k`:

| Kind | Source | Purpose |
|------|--------|---------|
| **Project** | `overlays/*/project.yaml` | Creates the tenant project with description, prompt, and labels |
| **Agent** | `base/agents/*.yaml` | Shared agent definitions (hello-world, pr-reviewer, etc.) |
| **Provider** | `base/providers/*.yaml` | Boilerplate integrations (vertex, github, jira) — shared by all tenants |
| **Gateway** | `overlays/*/gateway.yaml` | Project-scoped OpenShell gateway with tenant-specific DNS names |
| **Credential** | `overlays/*/credential-*.yaml` | Tenant-specific credentials with env-var token references |

### Tenants

#### `tenant-a` — Development

Permissive sandbox mode for rapid iteration. Use this tenant for testing new prompts, provider integrations, and agent configurations.

**Providers configured:** `vertex`, `jira`, `github`
**Credentials:** Vertex AI, Jira, GitHub
**Gateway:** OpenShell gateway at `openshell-gateway.tenant-a.svc.cluster.local`

#### `tenant-b` — Staging

Restricted sandbox policies matching production. Use this tenant to validate agent behavior and provider configs before promoting to production.

**Providers configured:** `vertex`, `github`, `jira` (from base)
**Credentials:** Vertex AI, GitHub (no Jira credential — agents requiring Jira will not run)
**Gateway:** OpenShell gateway at `openshell-gateway.tenant-b.svc.cluster.local`

### Agents

#### `hello-world`

The simplest possible agent. Sends a greeting and demonstrates payload injection and environment variables.

**Providers:** `vertex`

**What it does:** Says hello world, and — thanks to an injected payload — also tells you how to say hello in a different language.

**Session prompt example:**

```
Say hello
```

---

#### `security-reviewer`

A code security auditor. Analyzes code snippets or repositories for common vulnerabilities.

**Providers:** `vertex`

**What it does:** Reviews code for injection attacks, authentication issues, insecure data handling, and other vulnerabilities. Reports findings with severity, location, and remediation guidance.

**Session prompt example:**

```
Review this Python function for security issues:

def login(username, password):
    query = f"SELECT * FROM users WHERE username='{username}' AND password='{password}'"
    return db.execute(query)
```

---

#### `jira-simple-whoami`

Demonstrates Jira Model Context Protocol integration. Connects to Jira and
looks up the authenticated user's profile.

**Providers:** `vertex`, `jira`

**Prerequisites:** Jira credentials for the project.

**What it does:** Uses the Jira Model Context Protocol tools to call the Jira
API. Returns the current user's username and profile information.

**Session prompt example:**

```
Who am I in Jira?
```

---

#### `jira-simple-whoami-with-skill-payload`

Same as `jira-simple-whoami` but demonstrates the payload injection pattern: a skill file is injected into the sandbox at `/sandbox/SKILL.md` and the agent follows its instructions.

**Providers:** `vertex`, `jira`

**Prerequisites:** Jira credentials for the project.

**What it does:** Looks up the Jira user profile and responds in olde English, as instructed by the injected skill payload.

**Session prompt example:**

```
Who am I in Jira?
```

---

#### `pr-reviewer`

A GitHub Pull Request reviewer. Fetches PR metadata, diffs, and comments via
the GitHub Model Context Protocol integration. Produces a structured review
report.

**Providers:** `vertex`, `github`

**Prerequisites:** GitHub credentials for the project.

**What it does:**

1. Fetches PR metadata (title, description, author, branches)
2. Retrieves changed files and full diffs
3. Reads existing review comments for context
4. Analyzes the changes against an injected checklist covering security, code quality, tests, architecture conventions, breaking changes, and documentation
5. Produces a report grouped by severity: `CRITICAL` / `WARNING` / `INFO`
6. Ends with an overall recommendation: `APPROVE` / `REQUEST_CHANGES` / `COMMENT`

**Session prompt example:**

```
Review PR #42 in my-org/my-repo
```

---

#### `jira-issue-categorizer`

Automatically categorizes Jira issues into Sankey Activity Types using AI. Inspired by the [jira-ai-categorizer](https://gitlab.cee.redhat.com/hcm-engprod/jira-ai-categorizer) project, reimplemented as an agent — eliminating the need for a separate Python script and external LLM endpoint.

**Providers:** `vertex`, `jira`

**Prerequisites:** Jira credentials for the project. The Jira URL is
pre-configured to `https://redhat.atlassian.net` in the agent definition.

**What it does:**

1. Searches for issues in the specified project(s) using JQL
2. Reads each issue's summary and description
3. Classifies it into one of six Sankey Activity Types using an injected classification guide:
   - `Associate Wellness & Development`
   - `Incidents & Support`
   - `Security & Compliance`
   - `Quality / Stability / Reliability`
   - `Future Sustainability`
   - `Product / Portfolio Work`
4. In dry-run mode (default), reports what would be set without making changes
5. Optionally supports hierarchical propagation: propagates the Activity Type from parent issues down to all descendants

**Session prompt examples:**

```
Categorize issues in project RHCLOUD. Dry-run mode ON.
```

```
Categorize issues in project RHCLOUD for components Clowder and Bonfire. Dry-run mode ON.
```

```
Categorize issues in project HPSTRAT using hierarchical mode. Apply changes.
```

> **Note:** By default the agent runs in dry-run mode and will not write any changes to Jira unless explicitly instructed otherwise in the session prompt.

---

## vTeam Lab

The `vteam-catalog/` directory contains more in-depth examples of building agentic virtual teams. Where the starter examples above show individual agents, the vTeam lab demonstrates multi-agent collaboration: teams of specialized agents with distinct roles, coordination patterns, and shared work.

```text
vteam-catalog/
├── product-swarm/           # Cross-functional product delivery team
└── codebase-maintainers/    # Internal codebase maintenance team
```

The `vteam-product-swarm` and `codebase-maintainers` namespaces are provisioned automatically during `make kind-up` (included in the default `OPENSHELL_TENANTS`). See the [vTeam Catalog README](vteam-catalog/README.md) for architecture details and the [QUICKSTART](vteam-catalog/QUICKSTART.md) for a step-by-step walkthrough.

### Applying

```bash
# Product swarm — six-agent product delivery team
acpctl apply -k examples/vteam-catalog/product-swarm --project vteam-product-swarm

# Codebase maintainers — four-agent maintenance team
acpctl apply -k examples/vteam-catalog/codebase-maintainers --project codebase-maintainers
```

---

## Gateway

Each overlay declares a project-scoped OpenShell gateway in `gateway.yaml`. The gateway is reconciled by the GatewayReconciler into Kubernetes resources (StatefulSet, Service, RBAC, certgen Job).

Key fields:

- `image` — gateway container image (defaults to `OPENSHELL_GATEWAY_IMAGE` if omitted)
- `server_dns_names` — DNS names for TLS certificate generation, scoped to the tenant namespace
- `config` — optional TOML configuration for the gateway

The base `gateways/openshell-gateway.yaml` serves as a reference template. Each overlay declares its own gateway with the correct namespace in `server_dns_names`.
