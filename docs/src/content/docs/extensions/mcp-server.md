---
title: MCP Server
---

import { Badge } from '@astrojs/starlight/components';

<Badge text="Stable" variant="success" />

`components/ambient-mcp` is a Go MCP server for ACP. It exposes project, agent, session, message, label, and annotation tools over stdio or SSE.

## Run modes

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AMBIENT_API_URL` | `http://localhost:8080` | ACP base URL. |
| `AMBIENT_TOKEN` | none | Bearer token for API calls when not using control-plane token exchange. |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `sse`. |
| `MCP_BIND_ADDR` | `:8090` | SSE bind address. |
| `AMBIENT_CP_TOKEN_URL` | none | Control-plane token endpoint for sidecar mode. |
| `AMBIENT_CP_TOKEN_PUBLIC_KEY` | none | RSA public key used by sidecar token exchange. |
| `SESSION_ID` | none | Session ID used by sidecar token exchange. |

If the control-plane token exchange variables and `SESSION_ID` are set, the MCP server fetches a short-lived token from the control plane and refreshes it in the background. Otherwise `AMBIENT_TOKEN` is required.

## Stdio

```bash
AMBIENT_API_URL=https://acp.example.com \
AMBIENT_TOKEN="$AMBIENT_TOKEN" \
MCP_TRANSPORT=stdio \
./ambient-mcp
```

Use stdio for local MCP clients that launch the server process directly.

## SSE

```bash
AMBIENT_API_URL=https://acp.example.com \
AMBIENT_TOKEN="$AMBIENT_TOKEN" \
MCP_TRANSPORT=sse \
MCP_BIND_ADDR=:8090 \
./ambient-mcp
```

The server exposes SSE at `/sse` and messages at `/message` on its own bind address.

The current API server code does not register `/api/ambient/v1/mcp` routes, so do not configure clients against an API-server MCP endpoint unless your deployment adds one separately.

## Tools

Session tools:

- `list_sessions`
- `get_session`
- `create_session`
- `push_message`
- `patch_session_labels`
- `patch_session_annotations`
- `watch_session_messages`
- `unwatch_session_messages`

Agent tools:

- `list_agents`
- `get_agent`
- `create_agent`
- `update_agent`
- `patch_agent_annotations`

Project tools:

- `list_projects`
- `get_project`
- `patch_project_annotations`

`create_session` creates a session and then starts it. `push_message` can also resolve `@agent` mentions and create a delegated child session.

`watch_session_messages` requires SSE transport. In stdio mode it returns `TRANSPORT_NOT_SUPPORTED`.

## Runner sidecar

The control plane can inject `ambient-mcp` as a sidecar when `MCP_IMAGE`, `CP_TOKEN_URL`, and the token public key are configured. The runner receives `AMBIENT_MCP_URL` and can add the sidecar as an MCP server for Claude.
