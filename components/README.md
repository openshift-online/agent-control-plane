# Agent Control Plane Components

This directory contains the core components of the Agent Control Plane.

See the main [README.md](../README.md) for complete documentation.

## Component Directory Structure

```
components/
├── ambient-api-server/         # Go REST + gRPC API (rh-trex-ai, PostgreSQL)
├── ambient-control-plane/      # Go service, watches API server via gRPC, creates K8s Jobs
├── ambient-ui/                 # NextJS + Shadcn web interface
├── ambient-mcp/                # MCP server integration
├── ambient-cli/                # Go CLI (acpctl)
├── ambient-sdk/                # Go, Python, TypeScript SDKs (generated from OpenAPI)
├── credential-sidecars/        # Per-provider credential containers (GitHub, Jira, K8s, Google)
├── runners/
│   └── ambient-runner/         # Python runner executing AI agents in Job pods
├── manifests/                  # Kustomize deployment manifests
└── README.md
```

## Session Flow

1. **Create Session**: User creates a session via UI or CLI
2. **API Server**: Persists session to PostgreSQL
3. **Control Plane**: Receives gRPC event, creates Kubernetes Job
4. **Execution**: Job pod runs AI agent with configured bridge
5. **Results**: Runner streams results back to API server via gRPC
6. **UI Update**: UI displays progress

## Quick Start

```bash
# Start local Kind cluster with all components
make kind-up

# Rebuild after code changes
make kind-rebuild
```

## Build Targets

```bash
make build-all                # Build all container images
make build-api-server         # API server only
make build-control-plane      # Control plane only
make build-ambient-ui         # UI only
make build-mcp                # MCP server only
make build-runner             # Runner only
```
