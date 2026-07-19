# PR Test — Ephemeral ACP Environments

Deploys a self-contained ACP instance per pull request on a shared OpenShift Stage cluster. Each PR gets its own namespace (`pr-<number>`), fully isolated with its own PostgreSQL, Keycloak, API server, control plane, and UI.

## How It Works

```
/pr-test comment on PR
  → GHA builds all component images tagged pr-<N>-amd64 → Quay
  → install-openshift.sh deploys full stack to pr-<N> namespace
  → e2e-smoke.sh validates the deployment end-to-end
  → PR comment posted with URLs + credential retrieval instructions
  → On PR close: teardown-openshift.sh deletes namespace + RBAC
```

Random passwords are generated at deploy time and stored in `secret/pr-test-credentials` in the namespace — never logged or exposed in CI output.

## Scripts

| Script | Purpose |
|--------|---------|
| `install-openshift.sh` | Full self-contained deploy: namespace, secrets, Keycloak (with realm import), PostgreSQL, API server, control plane, UI, Routes, RBAC. Idempotent on re-runs. |
| `install-standard.sh` | Lightweight deploy without SSO (dev mode, no JWT validation). For manual testing on any OpenShift cluster. |
| `build.sh` | Local build and push of all component images to Quay, tagged `pr-<N>`. |
| `e2e-smoke.sh` | 9-step end-to-end validation: pod health, routes, API health, Keycloak auth, acpctl login, session lifecycle, LLM inference, UI health, cleanup. |
| `teardown-openshift.sh` | Deletes namespace, ClusterRole, and ClusterRoleBinding by namespace name. |
| `teardown-standard.sh` | Same teardown, accepts PR URL or number as input. |

## Usage

### Automated (via GitHub Actions)

Comment `/pr-test` on any open PR. The pipeline builds, deploys, tests, and posts results back as a PR comment. Teardown happens automatically when the PR is closed.

Workflows:
- `.github/workflows/pr-test-trigger.yml` — entry point (issue_comment trigger)
- `.github/workflows/pr-test-stage.yml` — deploy + smoke test + PR comment
- `.github/workflows/pr-test-cleanup.yml` — teardown on PR close

### Manual

```bash
# Build and push images from your local checkout
bash components/pr-test/build.sh https://github.com/openshift-online/agent-control-plane/pull/123

# Deploy to a cluster (full stack with Keycloak SSO)
bash components/pr-test/install-openshift.sh pr-123 pr-123-amd64

# Deploy without SSO (dev mode)
bash components/pr-test/install-standard.sh 123

# Run smoke tests
bash components/pr-test/e2e-smoke.sh pr-123

# Tear down
bash components/pr-test/teardown-openshift.sh pr-123
```

### Environment Variables

`install-openshift.sh` supports:

| Variable | Default | Description |
|----------|---------|-------------|
| `REGISTRY` | `quay.io/ambient_code` | Image registry prefix |
| `OC` | `oc` | CLI binary |
| `VERTEX_SA_KEY_FILE` | (none) | Path to Vertex AI service account JSON key |
| `VERTEX_PROJECT_ID` | (auto-detected) | GCP project ID |
| `VERTEX_REGION` | `global` | Vertex AI region |
| `SKIP_RBAC` | (unset) | Set to `1` to skip ClusterRole creation |
| `SKIP_KEYCLOAK` | (unset) | Set to `1` to use an external IdP (requires `KEYCLOAK_REALM_URL`) |
| `KC_DEV_PASSWORD` | `developer` | Keycloak developer user password |
| `KC_ADMIN_PASSWORD` | `admin` | Keycloak admin user password |
| `DRY_RUN` | (unset) | Set to `1` to print manifests without applying |

## Accessing a Deployed Instance

Credentials are in the namespace secret:

```bash
oc get secret pr-test-credentials -n pr-123 -o jsonpath='{.data.developer-password}' | base64 -d
oc get secret pr-test-credentials -n pr-123 -o jsonpath='{.data.admin-password}' | base64 -d
```

Login via browser OAuth flow:

```bash
acpctl login --use-auth-code \
  --client-id ambient-cli \
  --issuer-url https://keycloak-pr-123.<cluster-domain>/realms/ambient-code \
  --url https://ambient-api-pr-123.<cluster-domain> --insecure-skip-tls-verify
```
