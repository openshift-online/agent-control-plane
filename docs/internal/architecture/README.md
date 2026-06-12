# Architecture Documentation

Technical architecture documentation for the Ambient Code Platform.

## Overview

The platform uses a PostgreSQL-backed API server as the source of truth, with a Kubernetes control plane that watches via gRPC streams and reconciles sessions into Jobs.

```
User → UI → API Server (PostgreSQL) → Control Plane (gRPC watch) → Kubernetes Jobs → Runner Pods
```

## Architecture Documentation

### Diagrams
**[Architecture Diagrams](diagrams/)** - Visual system representations
- [UX Feature Workflow](./diagrams/ux-feature-workflow.md) - Multi-agent workflow

### Key Components

#### API Server (Go + rh-trex-ai)
**Purpose:** REST + gRPC microservice, source of truth for all platform data

**Key Features:**
- PostgreSQL-backed session, project, and settings storage
- gRPC watch streams consumed by the control plane
- User token-based authentication via OIDC/Keycloak
- OpenAPI-generated SDK clients (Go, Python, TypeScript)

**Documentation:** [components/ambient-api-server/README.md](../../components/ambient-api-server/README.md)

---

#### Control Plane (Go)
**Purpose:** Watches the API server via gRPC and reconciles sessions into Kubernetes resources

**Key Features:**
- gRPC stream-based watch (not CRD-based — no controller-runtime)
- Creates Jobs, Secrets, and namespaces for sessions
- Pod status syncing back to the API server
- Namespace provisioning (standard K8s and MPP modes)

**Documentation:** [components/ambient-control-plane/](../../components/ambient-control-plane/)

---

#### UI (NextJS + Shadcn)
**Purpose:** Web interface for session management and monitoring

**Key Features:**
- Project and session CRUD operations
- Real-time status updates
- Repository browsing
- Multi-agent chat interface

**Documentation:** [components/ambient-ui/README.md](../../components/ambient-ui/README.md)

---

#### Runner (Python)
**Purpose:** Job pod executing AI agents

**Key Features:**
- Polymorphic bridge architecture (Claude Agent SDK, Gemini CLI, LangGraph)
- AG-UI event protocol streaming
- Workspace synchronization via PVC
- MCP tool integration via credential sidecars

**Documentation:** [components/runners/ambient-runner/README.md](../../components/runners/ambient-runner/README.md)

---

#### MCP Server (Go)
**Purpose:** MCP tool definitions for AI agent integration

**Documentation:** [components/ambient-mcp/](../../components/ambient-mcp/)

---

## Multi-Tenancy

- Each **project** maps to a Kubernetes **namespace**
- RBAC enforces namespace-scoped access
- User tokens determine permissions via OIDC/Keycloak
- No cross-project data access

## Authentication & Authorization

- **Authentication:** OIDC via Keycloak (production) or test tokens (dev)
- **Authorization:** Namespace-scoped RBAC
- **Security:** Token redaction, credential sidecars for provider secrets

See [ADR-0002: User Token Authentication](../adr/0002-user-token-authentication.md)

## Architectural Decision Records

**[ADR Directory](../adr/)** - Why we made key technical decisions

| ADR | Title | Status |
|-----|-------|--------|
| [0001](../adr/0001-kubernetes-native-architecture.md) | Kubernetes-Native Architecture | Accepted (v2 supersedes CRD data model) |
| [0002](../adr/0002-user-token-authentication.md) | User Token Authentication | Accepted |
| [0003](../adr/0003-multi-repo-support.md) | Multi-Repo Support | Accepted |
| [0004](../adr/0004-go-backend-python-runner.md) | Go Backend + Python Runner | Accepted |
| [0005](../adr/0005-nextjs-shadcn-react-query.md) | Next.js + Shadcn + React Query | Accepted |
| [0009](../adr/0009-rest-api-postgresql-trex-foundation.md) | REST API + PostgreSQL (rh-trex-ai) | Accepted |

## Request Flow

### Creating a Session

1. **User** submits session via UI or CLI
2. **UI/CLI** sends POST to `/api/ambient/v1/sessions`
3. **API Server** validates auth, persists session to PostgreSQL
4. **Control Plane** receives session event via gRPC watch stream
5. **Control Plane** creates Kubernetes Job with runner pod
6. **Runner** executes AI agent, streams results back via gRPC
7. **API Server** persists status updates
8. **UI** displays real-time updates

### Data Flow

```
User Input → UI (Next.js) or CLI (acpctl)
    ↓
API Server (Go + rh-trex-ai) → Auth validation → PostgreSQL
    ↓
Control Plane (Go) ← gRPC watch stream ← API Server
    ↓
Kubernetes → Job created → Runner Pod scheduled
    ↓
Runner Pod (Python) → Executes AI agent → Streams events via gRPC
    ↓
API Server → Persists results → UI/CLI polls updates
```

## Security Architecture

### Authentication Layers
1. **OIDC/Keycloak** (production) - Identity provider
2. **User Tokens** - Bearer tokens for API authentication
3. **Service Accounts** - Control plane service identity for K8s operations

### Authorization Model
- **Namespace-scoped RBAC** - Users only see their authorized projects
- **API Server auth** - All operations validated against OIDC tokens
- **Credential sidecars** - Provider secrets injected per-session, not stored in pods

## Testing Architecture

- **Unit Tests** - Component logic testing (Go, Python, TypeScript)
- **E2E Tests** - Full stack testing with Kind cluster
- **Runner Tests** - Python pytest suite with coverage

## Additional Resources

- **[Design Documents](../design/)** - Feature design proposals
- **[Proposals](../proposals/)** - Technical proposals
