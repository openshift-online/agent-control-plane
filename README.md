# Agent Control Plane

> Kubernetes-native AI automation platform for intelligent agentic sessions

## Overview

The Agent Control Plane combines Claude Code CLI with multi-agent collaboration capabilities. Teams create and manage intelligent agentic sessions through a modern web interface, backed by Kubernetes Custom Resources and operators.

### Key Capabilities

- **Intelligent Agentic Sessions**: AI-powered automation for analysis, research, content creation, and development tasks
- **Multi-Agent Workflows**: Specialized AI agents model realistic software team dynamics
- **Git Provider Support**: Native integration with GitHub and GitLab (SaaS and self-hosted)
- **Kubernetes Native**: Custom Resources, Operators, and proper RBAC for enterprise deployment
- **Real-time Monitoring**: Live status updates and job execution tracking

## Quick Start

See [CONTRIBUTING.md](CONTRIBUTING.md#local-development-setup) for full local development setup with Kind.

```bash
make kind-up
# Access at http://localhost:8080
```

## Architecture

The platform consists of containerized microservices orchestrated via Kubernetes:

| Component | Technology | Description |
|-----------|------------|-------------|
| **API Server** (`ambient-api-server`) | Go + rh-trex-ai | REST API microservice, PostgreSQL-backed |
| **Control Plane** (`ambient-control-plane`) | Go | Kubernetes controller that reconciles sessions and spawns Jobs |
| **UI** (`ambient-ui`) | NextJS + Shadcn | Web interface for managing agentic sessions |
| **Runner** (`ambient-runner`) | Python + Claude Code CLI | Pod that executes AI with multi-agent collaboration |
| **MCP Server** (`ambient-mcp`) | Go | MCP tool definitions and sidecar/public endpoint modes |

```
User Creates Session → API Server Persists to DB → Control Plane Spawns Job →
Pod Runs AI Agent → Results Stream to API Server → UI Displays Progress
```

See [docs/internal/architecture/](docs/internal/architecture/) for detailed architecture documentation.

## Documentation

- **User documentation** -- see the [documentation site](docs/) built with Astro Starlight
- **Developer/architecture docs** -- see [docs/internal/](docs/internal/)
- **Component READMEs** -- each component has its own README with development instructions

### Key Links

| Resource | Location |
|----------|----------|
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Development standards | [CLAUDE.md](CLAUDE.md) |
| Developer bookmarks | [BOOKMARKS.md](BOOKMARKS.md) |
| Architecture decisions | [docs/internal/adr/](docs/internal/adr/) |
| Testing | [docs/internal/testing/](docs/internal/testing/) |
| Local dev setup | [docs/internal/developer/local-development/](docs/internal/developer/local-development/) |

## Components

Each component has its own detailed README:

- [API Server](components/ambient-api-server/) -- Go REST API microservice (rh-trex-ai)
- [Control Plane](components/ambient-control-plane/) -- Kubernetes controller
- [UI](components/ambient-ui/) -- NextJS web application
- [Runner](components/runners/ambient-runner/) -- AI execution pods
- [MCP Server](components/ambient-mcp/) -- MCP integration
- [CLI](components/ambient-cli/) -- `acpctl` command-line tool
- [SDK](components/ambient-sdk/) -- Go, Python, and TypeScript clients generated from the OpenAPI spec
- [Manifests](components/manifests/) -- Kubernetes deployment resources

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines, code standards, and local development setup.

## License

This project is licensed under the MIT License -- see the [LICENSE](LICENSE) file for details.

---

**Note:** This project was formerly known as "vTeam". Some RBAC manifests still reference the `vteam.ambient-code` API group for backward compatibility.
