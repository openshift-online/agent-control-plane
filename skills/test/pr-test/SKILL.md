---
name: ambient-pr-test
description: >-
  Deploy a PR's images (api-server, control-plane, runner) to any OpenShift
  namespace for integration testing.  Supports full SSO deployments
  (install-openshift.sh) and lightweight dev-mode deployments
  (install-standard.sh).
---

# Ambient PR Test Skill

Deploy PR-tagged Ambient images into an OpenShift namespace for integration testing.

**Invoke with a PR URL:**
```
with skills/control-plane/ambient-pr-test  https://github.com/ambient-code/platform/pull/1599
```

Optional modifiers:
- **`--keep-alive`** — skip teardown
- **`deploy-only`** / **`teardown-only`** — single phase
- **`--namespace <ns>`** — target namespace (defaults to current project)

---

## Deployment Modes

| | Full SSO (`install-openshift.sh`) | Dev Mode (`install-standard.sh`) |
|--|----------------------------------|----------------------------------|
| Auth | Keycloak OIDC | Development (no JWT) |
| Secrets | Auto-generated, stored in `pr-test-credentials` | Auto-generated |
| Components | PostgreSQL, Keycloak, API server, control plane, UI | PostgreSQL, API server, control plane |

---

## Standard OpenShift (Dev Mode)

For any cluster where you have `oc` access and an existing namespace.

### Prerequisites

- `oc` logged in with create permissions for deployments, services, routes, secrets, ClusterRoles
- Existing namespace (e.g. `mturansk`)
- PR images at `quay.io/ambient_code/acp_*:pr-<NUMBER>-amd64`

> **Selective builds:** CI only builds images for components with source changes in the PR. Unchanged components are not built — the cluster uses `:latest` for those. Check which components were built in the "Build and Push" workflow run.

### Deploy

```bash
PR_NUMBER=1599
NAMESPACE=$(oc project -q)
bash components/pr-test/install-standard.sh "$NAMESPACE" "pr-${PR_NUMBER}"
```

The script:
1. Creates DB and app secrets (auto-generated)
2. Creates CP ServiceAccount + ClusterRole + ClusterRoleBinding
3. Deploys PostgreSQL, api-server (dev mode), control-plane (standard mode)
4. Creates Route (auto-assigned `.apps.*` host)
5. Waits for rollouts, smoke-checks health

### Verify

```bash
API_HOST=$(oc get route ambient-api-server -n "$NAMESPACE" -o jsonpath='{.spec.host}')
curl -sk "https://${API_HOST}/api/ambient"
acpctl login --url "https://${API_HOST}"
```

### Teardown

```bash
NAMESPACE=$(oc project -q)
oc delete deployment,svc,route,configmap,secret -l app=ambient-api-server -n "$NAMESPACE"
oc delete deployment,svc -l app=ambient-control-plane -n "$NAMESPACE"
oc delete secret ambient-control-plane-token ambient-cp-token-keypair -n "$NAMESPACE" --ignore-not-found
oc delete clusterrole,clusterrolebinding "ambient-control-plane-${NAMESPACE}" --ignore-not-found
```

---

---

## Troubleshooting

### Images not found

Check quay.io for the tag: `https://quay.io/repository/ambient_code/acp_control_plane?tab=tags`

### CP can't reach api-server

```bash
oc get deployment ambient-control-plane -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].env}' | python3 -m json.tool | grep AMBIENT
```

### JWT errors in standard mode

Verify `AMBIENT_ENV=development`:
```bash
oc get deployment ambient-api-server -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="api-server")].env[?(@.name=="AMBIENT_ENV")].value}'
```

### Route not resolving

```bash
oc get route ambient-api-server -n "$NAMESPACE" -o jsonpath='{.spec.host}'
```

### CP keypair secret

Auto-generated on first start as `ambient-cp-token-keypair`. Check CP logs:
```bash
oc logs deployment/ambient-control-plane -n "$NAMESPACE" | grep keypair
```

### Build fails

```bash
docker login quay.io  # or: podman login quay.io
```
