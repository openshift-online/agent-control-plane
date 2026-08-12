# Platform Specification

Platform spec covering the data model, API, session lifecycle, control plane, runner, and MCP server.

## Sub-Specs

### [Data Model](data-model.spec.md)

Sessions, projects, agents, credentials, role bindings, applications, and their relationships. Defines the PostgreSQL-backed domain model that the API server exposes under `/api/ambient/v1/`.

### [Control Plane](control-plane.spec.md)

Reconciler that watches the API server via gRPC and spawns Kubernetes Jobs for each session. Covers job lifecycle, token provisioning, credential injection, and per-session RBAC setup.

### [Runner](runner.spec.md)

Python runner executing Claude Code CLI inside Job pods. Covers start context assembly, AG-UI event streaming, credential mounting, sidecar coordination, and OpenShell sandbox isolation.

### [Runner Constitution](runner-constitution.md)

Behavioral rules and versioned governance for the runner component. Inherits from the platform constitution.

### [Agent Sandbox Configuration](agent-sandbox-config.spec.md)

Declarative agent YAML schema for ConfigMap-based agent definitions. Covers entrypoint, providers (namespace-scoped shared resources), payloads, sandbox policies, sandbox templates, and environment variables for OpenShell Gateway-managed sandboxes.

### [Agent Configuration Reuse via Kustomize Overlays](agent-inheritance.spec.md) *(Draft)*

Configuration reuse patterns using Kustomize bases and overlays for agent, provider, and policy composition. Composition happens at apply time — the control plane only sees fully-resolved ConfigMaps. Extension to the Agent Sandbox Configuration spec.

### [MLflow Tracing](mlflow-tracing.spec.md)

MLflow tracing of Claude SDK interactions, enabled by default when credentials are present. Covers the `mlflow` credential provider, global credential fallback, runner image CA trust, conditional autologging activation, and OPA network policy for gateway mode.

### [MCP Server](mcp-server.spec.md)

Model Context Protocol server that exposes platform resources as MCP tools. Covers tool definitions, transport, authentication, @mention resolution, and sidecar deployment.

### [E2E Test Tooling](e2e-test-tooling.spec.md)

Mock LLM inference service for self-contained e2e testing in kind. Covers the mock server (OpenAI-compatible `/v1/chat/completions`), Kubernetes deployment, Makefile integration, example agent/provider/credential configurations, and OpenShell sandbox network policy for sandbox-to-mock connectivity.

### Multi-Cluster Scheduling

Cluster registration, placement strategy, and cross-cluster session routing. The `Cluster` Kind models registered clusters with roles (`workload`, `hybrid`). The `PlacementStrategy` interface determines which cluster a session runs on (default: round-robin). See [data-model.spec.md § Cluster](data-model.spec.md#cluster--multi-cluster-scheduling) and [control-plane.spec.md § ClusterReconciler](control-plane.spec.md#internal-reconciler-cluster_reconcilergo--clusterreconciler).
