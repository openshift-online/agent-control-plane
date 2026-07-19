# Agent Control Plane

[![Lint](https://github.com/openshift-online/agent-control-plane/actions/workflows/lint.yml/badge.svg)](https://github.com/openshift-online/agent-control-plane/actions/workflows/lint.yml)
[![Unit Tests](https://github.com/openshift-online/agent-control-plane/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/openshift-online/agent-control-plane/actions/workflows/unit-tests.yml)
[![Docs](https://github.com/openshift-online/agent-control-plane/actions/workflows/docs.yml/badge.svg)](https://openshift-online.github.io/agent-control-plane/)

> A secure, multi-tenant platform for running AI agents at scale on Kubernetes

## Why ACP?

Running AI agents on your laptop is easy. Running them securely for your team is not. You need multi-tenancy, managed credentials, integration with internal systems, and a deployment story that doesn't require every engineer to be a platform expert.

Agent Control Plane (ACP) solves this by giving teams a platform where they can:

- **Define agent workflows using GitOps** — agents, credentials, and schedules are declared in YAML and synced from git repositories
- **Operate securely in a multi-tenant model** — each team gets an isolated project with its own agents, credentials, and sandboxed execution
- **Run agents in OpenShell sandboxes** — credentials are masked and resolved by the sandbox supervisor, never exposed to agent code
- **Go from laptop to deployed quickly** — bring your agent config, point it at ACP, and it handles the rest (namespaces, gateways, credential wiring, sandbox lifecycle)

## Overview

ACP organizes work around a few core concepts:

- **Projects** are scoped to teams. Each team gets its own project with isolated agents and credentials — tenant A and tenant B never see each other's resources.
- **Agents** are configured per project. A team might have a PR reviewer, a Jira automation agent, or a research assistant — each defined as a YAML configuration with a prompt, model, and provider bindings.
- **Providers** are sets of credentials that allow agents to reach external services like GitHub, Jira, GitLab, or Vertex AI. Credentials are stored as Kubernetes secrets and managed through OpenShell providers so agents never see raw tokens.
- **Sessions** are individual agent runs. Start them on demand from the UI or CLI, or configure **scheduled sessions** (cron-based) for recurring tasks like reviewing PRs every 30 minutes. Active sessions can be observed and interacted with in real time — multiple team members can watch a session's progress, and in development environments, users can steer the agent mid-run by sending messages to the session.
- **Sandboxes** are OpenShell-isolated environments where agents execute. Each sandbox gets the credentials it needs through masked provider bindings, with full network and filesystem isolation.

### How It Works

1. Teams define their agents and providers in YAML and store them in a git repo
2. ACP syncs those definitions and sets up the agents in the team's project
3. When a session starts, ACP spins up an OpenShell sandbox, wires in the team's credentials, and uploads any skills or payloads
4. The AI agent runs inside the sandbox with access to configured tools (MCP servers for Jira, GitHub, etc.)
5. Results stream back through the API server — viewable in the UI with full logs, tool call history, and MLflow traces

### Key Capabilities

- **Multi-Tenant Isolation**: Projects scoped to teams with separate credentials, agents, and sandboxes
- **GitOps Fleet Management**: Argo CD-style Applications that continuously sync agent fleet definitions from git repositories
- **Managed Credentials**: Per-tenant OpenShell providers with credential masking — agents never touch raw tokens
- **Scheduled Sessions**: Cron-based recurring agent triggers with overlap policies and timezone support
- **Sandbox Security**: OpenShell-based defense-in-depth (network namespace, TLS proxy, Landlock, seccomp-BPF, OPA policy)
- **Observability**: Session logs, tool call history, sandbox audit logs, and MLflow tracing out of the box
- **AG-UI Event Streaming**: Real-time event streaming via the [AG-UI protocol](https://github.com/anthropics/ag-ui) with dual APIs (human-readable Messages API + comprehensive Events API with compression)
- **SSO Authentication**: OpenID Connect with Red Hat SSO / Keycloak, BFF token relay, and Kubernetes user impersonation
- **RBAC**: Scope-aware authorization (global, project, agent, session, credential) with role bindings and permission matrix
- **CLI and SDK**: `acpctl` CLI and generated SDKs (Go, Python, TypeScript) for automation
- **MCP Integration**: Model Context Protocol server exposing platform resources as tools, deployed as sidecar or public endpoint

### OpenShell as a Service

ACP can also provide self-service OpenShell gateway provisioning — users request a gateway through the CLI and the control plane handles the full lifecycle on Kubernetes. This turns OpenShell into a managed service where platform teams configure the infrastructure once and users get isolated sandbox environments on demand.

**How it works:**

1. A platform admin creates a namespace on the cluster (e.g., `oc new-project tenant-c`)
2. A user creates a project in ACP and requests a gateway:
   ```bash
   acpctl create project --name my-project
   acpctl create gateway --project my-project
   ```
3. The control plane reconciles and provisions:
   - An OpenShell gateway pod in the project namespace
   - cert-manager certificates for gateway TLS
   - A GRPCRoute with BackendTLSPolicy for end-to-end encryption from the edge to the gateway
4. The user retrieves gateway connection details and registers it with their local OpenShell CLI:
   ```bash
   acpctl get gateway --project my-project
   acpctl gateway setup-cli --project my-project --print
   ```
5. OIDC authentication gates access — users log in through the configured identity provider
6. Users create and manage sandboxes through the gateway:
   ```bash
   openshell sandbox create
   openshell sandbox list
   ```

Each sandbox runs as an isolated pod on the cluster, with credentials managed through OpenShell providers.

**POC on OpenShift:**

This flow has been validated on OpenShift Local (CRC). The [gateway lifecycle demo script](components/ambient-cli/demo-gateway-lifecycle.sh) walks through the full provisioning flow in a split-pane tmux session — platform admin actions on top, user actions on the bottom. See [Setup for OpenShift Local](#setup-for-openshift-local-crc) for prerequisites.

## Getting Started

**Try it locally** — spin up ACP in a Kind cluster and run agents on your machine:

```bash
make kind-up
make kind-login                  # port-forward services, configure acpctl, print access info
```

Once the cluster is running, you can configure your local openshell CLI to add a gateway:

```bash
acpctl gateway setup-cli --project <namespace> --gateway-url https://localhost:<port> --kubectl
```

The gateway URL and port are printed by `make kind-login`. If you've already run `setup-cli` before, it will re-authenticate using your existing acpctl credentials instead of re-registering.

To remove a gateway registration:

```bash
acpctl gateway remove-cli --project <namespace>
```

See [examples/README.md](examples/README.md) to deploy starter agents and vTeam lab environments.

See [CONTRIBUTING.md](CONTRIBUTING.md#local-development-setup) for full local development setup.

### OpenShell Gateway (Kind)

The control plane delegates sandbox creation to an OpenShell gateway by default. `make kind-up` automatically installs all prerequisites: the tenant namespace, and the [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) CRD (v0.5.1). ACP will automatically install configuration similar to the [OpenShell gateway Helm chart](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell) when it is configured to manage a namespace.

Override defaults with:

| Variable                     | Default  | Description                                                |
| ---------------------------- | -------- | ---------------------------------------------------------- |
| `OPENSHELL_TENANT_NAMESPACE` | `tenant` | Namespace for the gateway and sandboxes                    |
| `AGENT_SANDBOX_VERSION`      | `v0.5.1` | Agent Sandbox CRD release (must match gateway API version) |

After the sandbox reaches Ready, the control plane executes commands inside it via the `ExecSandbox` gRPC RPC — the runner starts through exec, not the container entrypoint.

See [OpenShell Sandbox Provisioning Spec](specs/platform/openshell-sandbox-provisioning.spec.md) for full details on gateway mode, CRD version compatibility, and configuration.

### Setup for OpenShift Local (CRC)

If this is a fresh CRC install, run initial setup first:

```bash
crc setup                      # Downloads VM image, configures hypervisor (first-time only)
```

Recommended CRC configuration (run before `crc start`):

```bash
crc config set memory 16384    # 16 GB memory
crc config set disk-size 64    # 64 GB storage
```

Deploy ACP to an OpenShift Local cluster:

```bash
crc start
eval $(crc oc-env)
oc login -u kubeadmin https://api.crc.testing:6443
make crc-up
```

`make crc-up` installs all prerequisites including Agent Sandbox Controller, cert-manager. It also configures Gateway API networking Gateway with HTTPS/TLS so that GRPCRoutes can be set up. BackendTLSPolicy (used for re-encryption to the gateway pod) requires OpenShift 4.22+.

**Trust store setup (CRC-only prerequisite):**

After `make crc-up`, download the CRC CA certificates and install them into your system trust store. This is only needed on CRC — production clusters use a real CA whose certs are already trusted.

```bash
# Download CRC CA certificates
oc get secret acpgw-ca -n openshift-ingress -o jsonpath='{.data.ca\.crt}' | base64 -d > crc-ca-bundle.crt
oc get secret router-ca -n openshift-ingress-operator -o jsonpath='{.data.tls\.crt}' | base64 -d >> crc-ca-bundle.crt

# Install into system trust store

# Fedora / RHEL / CentOS
sudo cp crc-ca-bundle.crt /etc/pki/ca-trust/source/anchors/crc-ca-bundle.crt
sudo update-ca-trust

# Ubuntu / Debian
sudo cp crc-ca-bundle.crt /usr/local/share/ca-certificates/crc-ca-bundle.crt
sudo update-ca-certificates

# macOS
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain crc-ca-bundle.crt
```

The bundle contains two CAs:

- **Gateway CA** (`acpgw-ca`) — for `*.acpgw.apps-crc.testing` (openshell gateway connections via Gateway API)
- **CRC router CA** (`router-ca`) — for `*.apps-crc.testing` (Keycloak, API server, UI)

**Gateway traffic flow on CRC:**

```
Client ──TLS/H2──▶ HAProxy (passthrough Route) ──▶ Gateway API (Envoy)
                    │                                 │ terminates TLS
                    │ raw TCP, no inspection          │ ALPN → HTTP/2
                    │ simulates Cloud LoadBalancer    │ GRPCRoute w/
                                                      │ BackendTLSPolicy
                                                      ▼
                                             openshell-gateway pod (TLS)
```

The passthrough Route is a CRC-only bridge — it exists because CRC has no cloud LoadBalancer provisioner. In a real deployment, an L4 cloud LoadBalancer replaces it; everything from Envoy onward is identical.

## vTeam Lab

The [examples/](examples/) directory contains starter agents and multi-agent virtual team definitions. See the [examples README](examples/README.md) for prerequisites, tenant setup, and the full vTeam catalog.

## Architecture

![Architecture](docs/architecture.png)

ACP has three high-level pieces:

1. **Agent repos** — git repositories containing YAML definitions for agents, providers, and schedules
2. **ACP application** — the API server, control plane, UI, and runner components running on Kubernetes
3. **External management** — the OpenShell agent sandbox controller, tenant namespaces, secrets, and platform configuration

### Tenant Onboarding

1. Configure a namespace with role bindings and credential secrets
2. Add the namespace to ACP's platform config — a project is created automatically
3. ACP installs an OpenShell gateway into the namespace (one per tenant)
4. ACP reads secrets from the namespace and sets up OpenShell providers on the gateway
5. Add your agent config repo to the platform config — ACP imports it and sets up your agents
6. Agents are ready to run — on demand or on a schedule

### Components

| Component                                   | Technology              | Description                                                                                          |
| ------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| **API Server** (`ambient-api-server`)       | Go + rh-trex-ai         | REST + gRPC API, PostgreSQL-backed. Source of truth for all platform state.                          |
| **Control Plane** (`ambient-control-plane`) | Go                      | Watches API server via gRPC streams, reconciles sessions into K8s Jobs, manages gateway provisioning |
| **UI** (`ambient-ui`)                       | NextJS + Shadcn         | BFF-pattern web application with OIDC authentication for session management and agent authoring      |
| **Runner** (`ambient-runner`)               | Python + FastAPI        | Executes AI agents inside pods; bridges AG-UI protocol to gRPC message store                         |
| **MCP Server** (`ambient-mcp`)              | Go                      | MCP tool definitions for platform resources, deployed as credential sidecar or public API endpoint   |
| **CLI** (`ambient-cli`)                     | Go                      | `acpctl` command-line tool with declarative `apply -f/-k` for fleet management                       |
| **SDK** (`ambient-sdk`)                     | Go, Python, TypeScript  | Generated from the OpenAPI spec                                                                      |
| **Credential Sidecars**                     | Per-provider containers | Isolated credential containers for GitHub, GitLab, Jira, Google, Kubernetes                          |
| **Manifests**                               | Kustomize               | Deployment manifests with base and overlay structure                                                 |

### Data Model

The core domain model stored in PostgreSQL:

- **Project** — workspace grouping agents with shared context prompt
- **Agent** — project-scoped, mutable definition with configurable prompt, LLM model, repo, and sandbox settings
- **Session** — ephemeral Kubernetes execution run, created via agent start (one active per agent)
- **SessionMessage** — human-readable conversation summary (Messages API)
- **SessionEvent** — comprehensive AG-UI event stream with compression (Events API)
- **Inbox** — persistent message queue on agents, surviving across sessions
- **Credential** — global encrypted secret store for external provider tokens (GitHub, GitLab, Jira, Google, Vertex AI, Kubeconfig)
- **RoleBinding** — scope-aware RBAC binding (global, project, agent, session, credential)
- **ScheduledSession** — project-scoped cron trigger for recurring agent runs
- **Application** — GitOps binding that syncs agent fleet definitions from git (Argo CD pattern)

See [Data Model Spec](specs/platform/data-model.spec.md) for the full entity relationship diagram and field reference.

### Runner Bridges

The runner uses a bridge abstraction (`PlatformBridge` ABC) to support multiple AI backends:

| Bridge            | Status      | Description                                     |
| ----------------- | ----------- | ----------------------------------------------- |
| `ClaudeBridge`    | Production  | Claude Code CLI via Claude Agent SDK subprocess |
| `GeminiCLIBridge` | Implemented | Gemini CLI bridge                               |
| `LangGraphBridge` | Stub        | LangGraph bridge                                |

### Security

- **Identity Boundaries**: Six identity types — control plane SA, per-session SAs, user SSO tokens, global credentials, project-scoped build agents, pipeline SAs
- **SSO Authentication**: OIDC with Keycloak/Red Hat SSO, JWT validation, BFF token relay
- **RBAC Enforcement**: Scope-aware authorization on all API endpoints (HTTP and gRPC)
- **Credential Encryption**: AES-256-GCM at rest for all credential tokens in PostgreSQL
- **Credential Isolation**: Integration credentials confined to sidecar containers; runner never holds external provider tokens
- **Sandbox Isolation**: Five defense-in-depth layers via OpenShell Supervisor (network namespace, TLS proxy, Landlock LSM, seccomp-BPF, OPA policy)

See [Security Spec](specs/security/) for full details.

## Documentation

- **[Documentation site](https://openshift-online.github.io/agent-control-plane/)** — user-facing docs (Astro Starlight)
- **[docs/internal/](docs/internal/)** — developer and architecture docs
- **[CLAUDE.md](CLAUDE.md)** — development standards and conventions
- **[BOOKMARKS.md](BOOKMARKS.md)** — developer reference index
- **[specs/](specs/)** — desired state specifications (platform, security, UI, standards)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, code standards, and local development setup.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
