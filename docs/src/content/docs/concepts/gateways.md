---
title: "Gateways"
---

A gateway is a proxy that connects ACP sessions to a sandbox execution environment. ACP uses [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) gateways to provide isolated, network-controlled sandboxes where agents run code safely.

## What a gateway does

When an agent session starts, the control plane routes it through a gateway. The gateway manages:

- **Sandbox lifecycle** — creating, stopping, and cleaning up isolated execution environments for each session.
- **Network policy enforcement** — controlling which external endpoints the sandbox can reach, based on the session's sandbox policy.
- **Tool exposure** — providing IDE access (VS Code, Cursor) and MCP tool connections into the sandbox.
- **TLS termination** — securing communication between the runner pod and the gateway service.

## Gateway definition

A gateway is defined as an ACP resource and deployed per project:

```yaml
kind: Gateway
name: openshell-gateway
image: ghcr.io/nvidia/openshell/gateway:0.0.83
server_dns_names:
  - openshell-gateway.my-project.svc.cluster.local
labels:
  purpose: openshell
```

| Field | Purpose |
|-------|---------|
| `name` | Identifier within the project |
| `image` | OpenShell gateway container image and version |
| `server_dns_names` | Kubernetes DNS names for TLS certificate generation — must include the project namespace |

## How gateways relate to projects

Each project can have its own gateway deployment. The control plane creates the gateway's Kubernetes resources (Deployment, Service, certificates) in the project's namespace. The `server_dns_names` field must match the project namespace:

```
openshell-gateway.<project-namespace>.svc.cluster.local
```

## Gateway setup

For local Kind clusters, gateways are included automatically when using `make kind-up`. For production or custom setups:

```bash
# Apply a gateway to a project
acpctl apply -f examples/base/gateways/openshell-gateway.yaml --project my-project

# Check gateway status
acpctl get gateway --project my-project
```

## How it fits together

```
Session starts → Control plane finds project gateway → Gateway creates sandbox →
Agent runs in sandbox → Sandbox policy controls network access → Session ends →
Gateway cleans up sandbox
```

The gateway is transparent to the agent — the agent writes code and uses tools without knowing about the gateway layer. The sandbox policy (permissive or locked-down) determines what the sandbox can access.

## Learn more

For detailed OpenShell documentation, architecture, and advanced configuration, see the [NVIDIA OpenShell project](https://github.com/NVIDIA/OpenShell).
