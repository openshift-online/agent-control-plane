---
title: vTeam Lab
description: Apply the bundled multi-agent catalog examples to an ACP project
---

The vTeam lab shows how to model a coordinated group of agents with current
ACP resources. Each lab team uses a `Project` as the workspace, `Agent`
records as team members, shared `Provider` records for runtime integrations,
and a project-scoped `Gateway` for OpenShell sandbox execution.

If you use hosted ACP, your platform administrators provide Vertex AI access.
You only need to provide personal or team integration credentials, such as
GitHub and Jira, for examples that use those providers.

## Catalog options

ACP ships two catalog examples:

| Team | Project | Use it for |
| --- | --- | --- |
| Product swarm | `vteam-product-swarm` | Cross-functional product delivery work with product, engineering, design, research, and writing roles. |
| Codebase maintainers | `codebase-maintainers` | Internal codebase upkeep across implementation, runtime readiness, CI, security, docs, and release gates. |

The manifests live in `examples/vteam-catalog/`.

## Apply a catalog team

Log in to ACP with `acpctl`, then apply one catalog directory to its matching
project.

```bash
acpctl apply -k examples/vteam-catalog/product-swarm \
  --project vteam-product-swarm
```

```bash
acpctl apply -k examples/vteam-catalog/codebase-maintainers \
  --project codebase-maintainers
```

The apply step creates or updates ACP records. Provider credentials become
runtime requirements when a session starts.

## Gateway and namespace behavior

Each catalog team declares an OpenShell `Gateway` named `openshell-gateway`.
ACP deploys that gateway into the project namespace, not into a namespace named
after the gateway.

For example, the `product-swarm` catalog uses:

```yaml
kind: Project
name: vteam-product-swarm
```

```yaml
kind: Gateway
name: openshell-gateway
server_dns_names:
  - openshell-gateway.vteam-product-swarm.svc.cluster.local
```

The control plane resolves the project namespace as `vteam-product-swarm` and
creates the gateway Kubernetes resources there.

## Verify

After applying a catalog team, check the ACP records:

```bash
acpctl get project vteam-product-swarm
acpctl agent list --project-id vteam-product-swarm
acpctl provider list --project-id vteam-product-swarm
```

On a local Kind cluster, also check the project namespace:

```bash
kubectl get namespace vteam-product-swarm
kubectl get statefulset openshell-gateway -n vteam-product-swarm
```

For a hand-run local reload flow, use
`examples/vteam-catalog/QUICKSTART.md`.
