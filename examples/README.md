# Examples

This directory contains example Agent, Provider, Gateway, and Credential definitions for the Agent Control Plane.

## Structure

```
examples/
├── base/
│   ├── policies/            # Sandbox policies (applied before agents)
│   │   └── permissive.yaml
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

`base/` contains resources shared across all tenants: sandbox policies, agent definitions, gateway templates, and boilerplate provider integrations (vertex, github, jira). `overlays/` contains the tenant-specific Project, Gateway, and Credentials.

## Applying Examples

```bash
# Apply to development tenant
acpctl apply -k examples/overlays/tenant-a/ --project tenant-a

# Apply to staging tenant
acpctl apply -k examples/overlays/tenant-b/ --project tenant-b
```

The `--project` flag (or `acpctl project <name>` beforehand) tells the CLI which project to scope Agents, Providers, and Gateways to.

## What Gets Applied

Each overlay applies the full declarative stack via a single `acpctl apply -k`:

| Kind | Source | Purpose |
|------|--------|---------|
| **Project** | `overlays/*/project.yaml` | Creates the tenant project with description, prompt, and labels |
| **Agent** | `base/agents/*.yaml` | Shared agent definitions (hello-world, pr-reviewer, etc.) |
| **Provider** | `base/providers/*.yaml` | Boilerplate integrations (vertex, github, jira) — shared by all tenants |
| **Gateway** | `overlays/*/gateway.yaml` | Project-scoped OpenShell gateway with tenant-specific DNS names |
| **Credential** | `overlays/*/credential-*.yaml` | Tenant-specific credentials with env-var token references |

## Prerequisites

### Provider Secrets

Each provider requires a Kubernetes Secret in the tenant namespace **before** running `acpctl apply`. These secrets are consumed by the provider integration at session start.

#### Vertex AI (required by all agents)

All agents use Vertex AI for inference. Create the secret with your Google Cloud credentials:

**Option A — Service Account key file:**
```bash
kubectl create secret generic vertex-sa-key \
  --from-literal=token="$(cat /path/to/your-service-account.json)" \
  -n tenant-a
```

**Option B — Application Default Credentials (ADC):**
```bash
kubectl create secret generic vertex-sa-key \
  --from-literal=token="$(cat ~/.config/gcloud/application_default_credentials.json)" \
  -n tenant-a
```

The secret key must be `token`. The value must be the raw JSON content of a Google Service Account key file or an ADC `authorized_user` credential file.

> Repeat for `tenant-b` by replacing `-n tenant-a` with `-n tenant-b`.

#### GitHub (required by `pr-reviewer`)

Create the secret with a GitHub Personal Access Token (classic or fine-grained):

```bash
kubectl create secret generic github-creds \
  --from-literal=token="<your-github-pat>" \
  -n tenant-a
```

The token needs at minimum: `repo` (read), `pull_requests` (read).

> Repeat for `tenant-b` by replacing `-n tenant-a` with `-n tenant-b`.

#### Jira (required by `jira-simple-whoami`, `jira-simple-whoami-with-skill-payload`, and `jira-issue-categorizer`)

```bash
kubectl create secret generic jira \
  --from-literal=JIRA_USERNAME="your-email@redhat.com" \
  --from-literal=JIRA_API_TOKEN=$(cat ~/jira-token.txt) \
  -n tenant-a
```

Store your API token in `~/jira-token.txt` before running the command. Generate one at: https://id.atlassian.com/manage-profile/security/api-tokens

> Repeat for `tenant-b` by replacing `-n tenant-a` with `-n tenant-b`.

### Credential Environment Variables

Credential YAML files reference tokens via environment variables (expanded by `acpctl apply` at apply time):

| Variable | Used by | Value |
|----------|---------|-------|
| `$VERTEX_SA_KEY` | `credential-vertex.yaml` | Vertex AI service account JSON |
| `$GITHUB_PAT` | `credential-github.yaml` | GitHub Personal Access Token |
| `$JIRA_API_TOKEN` | `credential-jira.yaml` | Jira API token |
| `$JIRA_EMAIL` | `credential-jira.yaml` | Jira account email |

Export these before running `acpctl apply`.

---

## Policies

### `permissive`

A wide-open sandbox policy that allows network access to most common services. Defines filesystem access (read-only system paths, read-write `/sandbox` and `/tmp`), Landlock LSM settings, process identity, and network policies for:

- **Claude Code + Vertex AI** — Vertex AI inference, Google auth, Anthropic API
- **gcloud** — OAuth and IAM token refresh
- **GitHub** — Git Smart HTTP (read-only clone/fetch) and REST API (read-only)
- **PyPI** — Python package installation
- **VS Code / Cursor** — IDE remote server downloads
- **OpenCode** — npm registry and inference
- **Atlassian** — Jira and Confluence REST APIs

> **Note:** ACP internal traffic (runner-to-control-plane and runner-to-API-server) is automatically injected by the control plane at sandbox creation time and does not need to be declared in user-facing policies.

Agents reference the policy by name via `sandbox_policy: permissive`. Agents that omit `sandbox_policy` get the gateway's built-in locked-down default (no external network access beyond ACP internal traffic).

To apply the policy independently:

```bash
acpctl apply -f examples/base/policies/permissive.yaml
```

---

## Agents

### `hello-world`

The simplest possible agent. Sends a greeting and demonstrates payload injection and environment variables.

**Providers:** `vertex`

**What it does:** Says hello world, and — thanks to an injected payload — also tells you how to say hello in a different language.

**Session prompt example:**
```
Say hello
```

---

### `security-reviewer`

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

### `jira-simple-whoami`

Demonstrates Jira MCP integration. Connects to Jira and looks up the authenticated user's profile.

**Providers:** `vertex`, `jira`

**Prerequisites:** `jira` secret in the tenant namespace (see above).

**What it does:** Uses the Jira MCP tools to call the Jira API and return the current user's username and profile information.

**Session prompt example:**
```
Who am I in Jira?
```

---

### `jira-simple-whoami-with-skill-payload`

Same as `jira-simple-whoami` but demonstrates the payload injection pattern: a skill file is injected into the sandbox at `/sandbox/SKILL.md` and the agent follows its instructions.

**Providers:** `vertex`, `jira`

**Prerequisites:** `jira` secret in the tenant namespace (see above).

**What it does:** Looks up the Jira user profile and responds in olde English, as instructed by the injected skill payload.

**Session prompt example:**
```
Who am I in Jira?
```

---

### `pr-reviewer`

A GitHub Pull Request reviewer. Fetches PR metadata, diffs, and comments via the GitHub MCP and produces a structured review report.

**Providers:** `vertex`, `github`

**Prerequisites:** `github-creds` secret in the tenant namespace (see above).

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

### `jira-issue-categorizer`

Automatically categorizes Jira issues into Sankey Activity Types using AI. Inspired by the [jira-ai-categorizer](https://gitlab.cee.redhat.com/hcm-engprod/jira-ai-categorizer) project, reimplemented as an agent — eliminating the need for a separate Python script and external LLM endpoint.

**Providers:** `vertex`, `jira`

**Prerequisites:** `jira` secret in the tenant namespace (see above). The Jira URL is pre-configured to `https://redhat.atlassian.net` in the agent definition.

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

## Gateway

Each overlay declares a project-scoped OpenShell gateway in `gateway.yaml`. The gateway is reconciled by the GatewayReconciler into Kubernetes resources (StatefulSet, Service, RBAC, certgen Job).

Key fields:
- `image` — gateway container image (defaults to `OPENSHELL_GATEWAY_IMAGE` if omitted)
- `server_dns_names` — DNS names for TLS certificate generation, scoped to the tenant namespace
- `config` — optional TOML configuration for the gateway

The base `gateways/openshell-gateway.yaml` serves as a reference template. Each overlay declares its own gateway with the correct namespace in `server_dns_names`.

---

## Tenants

### `tenant-a` — Development

Permissive sandbox mode for rapid iteration. Use this tenant for testing new prompts, provider integrations, and agent configurations.

**Providers configured:** `vertex`, `jira`, `github`
**Credentials:** Vertex AI, Jira, GitHub
**Gateway:** OpenShell gateway at `openshell-gateway.tenant-a.svc.cluster.local`

### `tenant-b` — Staging

Restricted sandbox policies matching production. Use this tenant to validate agent behavior and provider configs before promoting to production.

**Providers configured:** `vertex`, `github`, `jira` (from base)
**Credentials:** Vertex AI, GitHub (no Jira credential — agents requiring Jira will not run)
**Gateway:** OpenShell gateway at `openshell-gateway.tenant-b.svc.cluster.local`
