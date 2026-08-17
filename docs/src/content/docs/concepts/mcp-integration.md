---
title: "MCP Integration"
---

The platform exposes an MCP server so that external AI tools — Claude Code, IDE extensions, custom agents — can manage ACP resources (sessions, agents, projects) as MCP tools. Any MCP-compatible client can create sessions, push messages, delegate work between agents, and read project state without calling the REST API directly.

## What is MCP

The [Model Context Protocol](https://modelcontextprotocol.io) is an open standard that lets AI applications discover and call tools exposed by external servers using a structured JSON-RPC interface.

## Available tools

The MCP server registers tools across three resource types:

| Category | Tools |
|----------|-------|
| Sessions | `list_sessions`, `get_session`, `create_session`, `push_message`, `watch_session_messages`, `unwatch_session_messages`, `patch_session_labels`, `patch_session_annotations` |
| Agents | `list_agents`, `get_agent`, `create_agent`, `update_agent`, `patch_agent_annotations` |
| Projects | `list_projects`, `get_project`, `patch_project_annotations` |

`create_session` creates and starts a session in one call. `push_message` supports `@agent` mentions to delegate work to another agent automatically.

Annotation tools (`patch_*_annotations`) let you store arbitrary key-value metadata on sessions, agents, and projects. This acts as a scoped state store that any agent or external system can read and write.

## Run modes

The MCP server supports two transports:

**Stdio** — the client launches the server process directly. Best for local development and CLI tools like Claude Code.

```bash
AMBIENT_API_URL=https://acp.example.com \
AMBIENT_TOKEN=<your-token> \
MCP_TRANSPORT=stdio \
./ambient-mcp
```

**SSE** — the server runs as a long-lived HTTP service. Best for browser-based clients and remote connections.

```bash
AMBIENT_API_URL=https://acp.example.com \
AMBIENT_TOKEN=<your-token> \
MCP_TRANSPORT=sse \
MCP_BIND_ADDR=:8090 \
./ambient-mcp
```

In SSE mode, the server exposes `/sse` for the event stream and `/message` for client requests.

`watch_session_messages` requires SSE transport. In stdio mode it returns `TRANSPORT_NOT_SUPPORTED`.

## Sidecar mode

When a session runs on the platform, the control plane can inject `ambient-mcp` as a sidecar container alongside the runner. The runner connects to it at `http://localhost:8090` and gains access to all platform tools without needing its own API token — the sidecar handles authentication via short-lived tokens exchanged with the control plane.

This is how agents on the platform create child sessions, delegate to other agents with `@mentions`, and read project state during execution.

## How to connect

**Claude Code (local)** — add the server to your MCP configuration:

```json
{
  "mcpServers": {
    "acp": {
      "command": "./ambient-mcp",
      "env": {
        "AMBIENT_API_URL": "https://acp.example.com",
        "AMBIENT_TOKEN": "<your-token>",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

**CLI** — use `acpctl` to list tools or call them directly:

```bash
acpctl mcp tools
acpctl mcp call list_sessions --input '{"phase": "Running"}'
acpctl mcp call push_message --input '{"session_id": "abc123", "text": "@code-review check auth.go"}'
```

**Any MCP client (SSE)** — point your client at the SSE endpoint:

```
GET  /sse       → event stream
POST /message   → send JSON-RPC requests
```

All operations go through the platform REST API and inherit its RBAC model. The MCP server has no direct Kubernetes access.
