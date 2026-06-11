# System Overview

High-level architectural overview of the Ambient Code Platform showing all major components and their relationships.

## Architecture at a Glance

```mermaid
--8<-- "system-overview.mmd"
```

## Component Layers

### User Layer
The entry point where users interact with the platform through a web browser.

### Frontend Layer
**NextJS + Shadcn UI** provides the user interface for:
- Creating and managing agentic sessions
- Monitoring execution status in real-time
- Viewing results and artifacts
- Handling WebSocket connections for live updates

### API Layer
**Go + Gin backend** manages:
- RESTful API endpoints for session creation and management
- User token validation and authentication
- RBAC enforcement for namespace-scoped access
- Git operations (clone, fork, PR creation)
- WebSocket support for real-time updates

### Kubernetes Control Plane
The orchestration layer consisting of:

**Kubernetes API**: Manages Jobs, Namespaces, and RBAC enforcement

**Control Plane**: A Go service that watches the API server via gRPC and:
- Receives session events via gRPC watch streams
- Creates corresponding Kubernetes Jobs
- Monitors execution status
- Handles timeout enforcement
- Performs cleanup when sessions complete

### Execution Layer
Where AI tasks actually run:

**Kubernetes Job**: Manages the lifecycle of execution pods with:
- Resource limits and requests
- Retry policies
- Pod scheduling

**Claude Code Runner**: A Python service running in the execution pod that:
- Executes the Claude Code CLI
- Handles multi-agent collaboration
- Invokes MCP (Model Context Protocol) servers
- Streams results back to Kubernetes

### Storage & Configuration
**ProjectSettings**: API server resource storing project-specific configuration like API keys, model preferences, and timeout settings

**Results Storage**: Persistent storage for:
- Execution artifacts
- Logs and output
- Session metadata

## Data Flow

1. **User Request**: User submits session via frontend
2. **API Processing**: Frontend sends REST request to backend API
3. **CR Creation**: API server validates and persists session to PostgreSQL
4. **Job Creation**: Control plane receives gRPC event and creates Kubernetes Job
5. **Execution**: Pod spawns with Claude Code Runner
6. **Task Execution**: Runner executes prompt using Claude Code CLI and MCP
7. **Results**: Output streamed back to API server
8. **Cleanup**: Control plane cleans up Job and Pod
9. **Frontend Update**: UI polls API server for completion
10. **User Display**: Frontend displays results to user

## Key Design Principles

- **Kubernetes-Native**: API server is source of truth; control plane reconciles via gRPC streams
- **Multi-Tenancy**: Each project maps to a Kubernetes namespace with RBAC isolation
- **Async Processing**: Sessions execute asynchronously via Jobs, avoiding HTTP timeout issues
- **Real-Time Updates**: WebSocket support provides live status updates without polling
- **Declarative**: PostgreSQL stores desired state; control plane ensures K8s matches

## When to Reference This Diagram

Use this diagram when:
- Understanding the overall platform architecture
- Onboarding new team members
- Planning infrastructure deployments
- Debugging cross-layer issues
- Explaining the platform to stakeholders
