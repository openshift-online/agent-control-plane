# Rubber on Road — acp-01 OpenShell Gateway Deployment

## Objective

Deploy the `acp-01` project with a full OpenShell gateway stack on the `vteam-stage` ROSA cluster,
proving end-to-end that agents can access GitHub, Jira, and the target OpenShift cluster through
credential-injected sandboxes.

## Cluster State (2026-07-26)

- **Cluster**: vteam-stage ROSA (6x m5.2xlarge)
- **ACP deployment**: `acp-api-01` namespace (API server, control plane, UI, Keycloak)
- **Existing project**: `tenant-a` — has a working gateway, used for prior e2e validation
- **Target project**: `acp-01` — fully operational with gateway, providers, and running agents
- **CP image**: `quay.io/ambient_code/acp_control_plane:oidc-gateway-auth-fix`
- **Gateway image**: `ghcr.io/nvidia/openshell/gateway:21da343c9f838bd9ac85dc61bf44889de1a72873` (v0.0.91)

## Gitops Overlay State (current)

| Resource | Count | Status |
|----------|-------|--------|
| Project | 1 (`acp-01`) | Created in API, namespace exists |
| Agents | 4 (lead, engineer, amber, shelly) | Applied, amber validated end-to-end |
| Credentials | 4 (github, jira, kubeconfig, vertex) | Applied |
| Providers | 4 (github, jira, kubeconfig, vertex) | Applied, github + vertex confirmed working |
| Gateway | 1 (`openshell-gateway`) | Running, OIDC + Postgres, v0.0.91 |
| RoleBindings | 12 | Token-reader grants for all agents × providers |

## Gap Analysis: Gitops Overlay vs. e2e-openshell.sh

The e2e script validates:
1. Gateway Deployment exists (`oc get deployment openshell-gateway -n $TENANT`)
2. Postgres DB Deployment exists (`oc get deployment openshell-gateway-db -n $TENANT`)
3. Gateway Service exists (`oc get service openshell-gateway -n $TENANT`)
4. TLS certs provisioned (`oc get secret openshell-server-tls -n $TENANT`)
5. Keycloak OIDC auth works
6. Gateway discoverable via `acpctl get gateways`
7. Route or port-forward connectivity
8. Sandbox lifecycle (create, exec, stop)

The overlay is missing the **Gateway** resource entirely — without it, the control plane has nothing
to reconcile, so no Deployment, no DB, no Service, no TLS certs.

Also missing: **Provider** resources that tell the gateway which credential secrets to inject into
sandboxes, and **K8s Secrets** backing those providers.

## Design: Declarative Config for acp-01

### Resources needed:

```
acp-01/
├── kustomization.yaml          # Updated to include all resources
├── project-patch.yaml          # Existing — patches project name to acp-01
├── agents-patch.yaml           # Existing — patches agent project + sandbox_policy
├── gateway.yaml                # NEW — OpenShell gateway with OIDC + Postgres
├── provider-github.yaml        # NEW — maps github provider to K8s secret
├── provider-jira.yaml          # NEW — maps jira provider to K8s secret
├── provider-kubeconfig.yaml    # NEW — maps kubeconfig provider to K8s secret
├── credential-github.yaml      # Existing — env var substituted at apply time
├── credential-jira.yaml        # Existing — env var substituted at apply time
├── credential-kubeconfig.yaml  # Existing — env var substituted at apply time
├── rolebindings.yaml           # NEW — token-reader grants for agents
├── lead.yaml                   # Existing
├── engineer.yaml               # Existing
├── amber.yaml                  # Existing
└── shelly.yaml                 # Existing
```

### Credential → Provider → Gateway → Sandbox flow:

```
Credential (API)          Provider (API)           K8s Secret            Gateway (gRPC)
┌───────────────┐    ┌─────────────────┐    ┌──────────────────┐    ┌──────────────┐
│ acp-01-github │    │ github          │    │ ambient-github   │    │ openshell-   │
│ token=$GH_TOK │───▶│ type=github     │───▶│ token=<value>    │───▶│ gateway      │
│               │    │ secret=ambient- │    │                  │    │ providers:   │
│               │    │   github        │    │                  │    │  [github]    │
└───────────────┘    └─────────────────┘    └──────────────────┘    └──────┬───────┘
                                                                          │
                                                                    ┌─────▼───────┐
                                                                    │ Sandbox Pod  │
                                                                    │ GITHUB_TOKEN │
                                                                    │ JIRA_TOKEN   │
                                                                    │ KUBECONFIG   │
                                                                    └─────────────┘
```

## Deployment Steps

1. Create K8s secrets in `acp-01` namespace (backing the Provider resources)
2. Apply the full kustomize overlay via `acpctl apply -k`
3. Wait for gateway reconciliation (Deployment, DB, TLS certs)
4. Run e2e-openshell.sh against `acp-01`

## Progress Log

| Date | Action | Result |
|------|--------|--------|
| 2026-07-23 | Created gitops overlay with gateway, providers, rolebindings | Gateway, DB, TLS certs all reconciled successfully |
| 2026-07-23 | Fixed CP→gateway OIDC auth (was using K8s SA token, gateway expects OIDC) | CP authenticates via Keycloak JWT, gateway validates via `OidcAuthenticator` |
| 2026-07-24 | Fixed sandbox name length (19-char limit, not 40) | `SandboxName()` truncates to 11 chars of session ID |
| 2026-07-24 | Fixed DNS ndots CR name mismatch (`default--` workspace prefix) | `SandboxCRName()` adds `default--` prefix matching gateway workspace |
| 2026-07-24 | Installed agent-sandbox controller v0.5.1 | CRD + controller in `agent-sandbox-system` namespace |
| 2026-07-24 | Fixed empty Landlock policy (exit code 126) | Populated `ambient-dev-sandbox-policy` with filesystem/process/network rules |
| 2026-07-25 | Fixed L7 policy validation (`protocol: rest` requires `access` or `rules`) | Removed `protocol`/`enforcement`/`tls: terminate`, added `access: full` |
| 2026-07-25 | Fixed FQDN DNS for cross-namespace service URLs | All CP env vars patched with `.svc.cluster.local` suffix |
| 2026-07-25 | Added vertex provider/credential to gitops | Inference routing now works through Vertex AI |
| 2026-07-25 | Updated proto: `SetClusterInference` → `SetInferenceRoute` | Matches upstream OpenShell v0.0.91 |
| 2026-07-25 | Updated gateway image from v0.0.88 to v0.0.91 SHA | `21da343c9f838bd9ac85dc61bf44889de1a72873` |
| 2026-07-25 | Built and pushed CP image with all fixes | `quay.io/ambient_code/acp_control_plane:oidc-gateway-auth-fix` |
| 2026-07-25 | **First successful end-to-end session** | LLM responded, GITHUB_TOKEN injected, inference routing working |
| 2026-07-26 | Verified credential injection | GITHUB_TOKEN ✓, GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN ✓, ANTHROPIC_API_KEY ✓ |

## Credential Injection Results

| Provider | Type | OpenShell Type | Env Vars Injected | Status |
|----------|------|----------------|-------------------|--------|
| `acp-01-vertex` | `vertex` | `google-vertex-ai` | `GOOGLE_SERVICE_ACCOUNT_KEY`, `GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN` | Working — gateway auto-refreshes SA JWT |
| `acp-01-github` | `github` | `github` | `GITHUB_TOKEN`, `GH_TOKEN` | Working |
| `acp-01-jira` | `jira` | `generic` | (none) | **Not injected** — see below |
| `acp-01-kubeconfig` | `kubeconfig` | `generic` | (none) | Not tested |

### Jira Credential Gap

The gateway does not inject env vars for `generic` type providers. Gateway logs show:
`provider type has no profile; skipping provider policy layer` for `acp-01-jira`.

The CP sends the K8s secret data (`email`, `token`, `url`) as provider credentials, but the gateway's
supervisor has no env var mapping for generic providers. Only typed providers (github, claude-code,
google-vertex-ai, etc.) get automatic env var injection into sandboxes.

**Options:**
1. Upstream: Request `jira` provider type support in OpenShell
2. Workaround: Use the credential sidecar pattern (pre-gateway approach) for Jira
3. Workaround: Map Jira to a generic env var pattern via `ProviderCredentialsFromSecret` with keys matching the expected env var names (`JIRA_API_TOKEN`, `JIRA_URL`, `JIRA_USERNAME`)

## Deployment Learnings

### Sandbox Naming
- Gateway creates Sandbox CRs with a `default--` workspace prefix: `default--session-<truncated_id>`
- Sandbox name limit is **19 characters** (not 40 as originally spec'd)
- The CP's `SandboxName()` must truncate to 11 chars of session ID to stay within limits
- The CP's `SandboxCRName()` must prepend `default--` to match what the gateway creates

### Agent-Sandbox Controller
- **Required prerequisite**: Must install `agent-sandbox-controller` v0.5.1 cluster-wide
- Without it, Sandbox CRs are created but no pods are spawned
- Install: `kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.1/manifest.yaml`

### Sandbox Policy (Landlock)
- An empty policy (`{version:1}`) causes Landlock to block all filesystem access → exit code 126
- Policies MUST include `filesystem_policy` (read_only/read_write paths), `landlock` compatibility, `process` identity
- `tls: terminate` on endpoints is deprecated in current OpenShell — causes validation errors
- Endpoints with `protocol: rest` must include `access` (e.g., `full`) or explicit `rules`
- Removing `protocol`/`enforcement`/`tls` fields and adding `access: full` resolves L7 validation

### DNS Resolution
- Sandbox pods run in the project namespace but CP services are in the runtime namespace
- With `ndots:1`, short service names like `ambient-control-plane.acp-api-01.svc` fail
- All service URLs must be fully qualified: `ambient-control-plane.acp-api-01.svc.cluster.local`
- Affects `CP_TOKEN_URL`, `AMBIENT_API_SERVER_URL`, `AMBIENT_GRPC_SERVER_ADDR`, `MCP_API_SERVER_URL`

### Inference Proto (v0.0.91)
- Upstream OpenShell renamed `SetClusterInference`/`GetClusterInference` → `SetInferenceRoute`/`GetInferenceRoute`
- Added `workspace` field to request/response messages
- Old RPC returns `Unimplemented` on v0.0.91+ gateways
- Proto at `components/ambient-control-plane/proto/openshell/inference/v1/inference.proto`

### GHCR Image Tags
- OpenShell gateway images use commit-SHA tags only (no semver tags)
- v0.0.91 = `ghcr.io/nvidia/openshell/gateway:21da343c9f838bd9ac85dc61bf44889de1a72873`
- Gateway reconciler continuously reconciles the image — gitops overlay must be source of truth

### Gateway Authentication
- For ROSA/external deployments: CP authenticates via OIDC (Keycloak JWT), not K8s SA tokens
- Gateway OIDC config requires `issuer`, `audience`, `roles_claim`, `admin_role`, `user_role`
- `K8sServiceAccountAuthenticator` only works when CP runs in same cluster with accessible TokenReview API
