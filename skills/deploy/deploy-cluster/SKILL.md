---
name: ambient
description: >-
  Install and verify Ambient Code Platform on an OpenShift cluster using quay.io images.
  Use when deploying Ambient to any OpenShift namespace — production, ephemeral PR test
  instances, or developer clusters. Covers secrets, kustomize deploy, rollout verification,
  and troubleshooting.
---

# Ambient Installer Skill

You are an expert in deploying the Ambient Code Platform to OpenShift clusters. This skill covers everything needed to go from an empty namespace to a running Ambient installation using images from quay.io.

> **Developer registry override:** If you need to use images from the OpenShift internal registry instead of quay.io (e.g. for local dev builds), see `docs/internal/developer/local-development/openshift.md`.

---

## Platform Components

| Deployment | Image | Purpose |
|-----------|-------|---------|
| `ambient-api-server` | `quay.io/ambient_code/acp_api_server` | Stateless API server |
| `ambient-api-server-db` | (postgres sidecar) | API server database |
| `postgresql` | (upstream) | Unleash feature flag DB |
| `minio` | (upstream) | S3 object storage |
| `unleash` | (upstream) | Feature flag service |

Runner pods (`acp_claude_runner`, `acp_state_sync`) are spawned dynamically by the operator — they are not standing deployments.

Credential sidecar containers are injected into session pods when the corresponding credential type is configured:

 < /dev/null |  Sidecar Container | Image | Port | Provider |
|-------------------|-------|------|----------|
| `credential-github` | `quay.io/ambient_code/acp_credential_github` | 8091 | GitHub PAT / App |
| `credential-jira` | `quay.io/ambient_code/acp_credential_jira` | 8092 | Jira / Atlassian |
| `credential-k8s` | `quay.io/ambient_code/acp_credential_k8s` | 8093 | Kubeconfig |
| `credential-google` | `quay.io/ambient_code/acp_credential_google` | 8094 | Google Workspace |

---

## Prerequisites

- `oc` CLI installed and logged in to the target cluster
- `kustomize` installed (`curl -s https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh | bash`)
- Target namespace already exists and is Active
- Quay.io images are accessible from the cluster (public repos or image pull secret in place)

---

## Step 1: Apply RBAC (cluster-scoped, once per cluster)

```bash
oc apply -k components/manifests/base/crds/
oc apply -k components/manifests/base/rbac/
```

These are idempotent and safe to re-run on shared clusters.

---

## Step 2: Create Required Secrets

All secrets must exist **before** applying the kustomize overlay. The deployment will fail if any are missing.

```bash
NAMESPACE=<target-namespace>

oc create secret generic minio-credentials -n $NAMESPACE \
  --from-literal=root-user=<MINIO_ROOT_USER> \
  --from-literal=root-password=<MINIO_ROOT_PASSWORD>

oc create secret generic postgresql-credentials -n $NAMESPACE \
  --from-literal=db.host=postgresql \
  --from-literal=db.port=5432 \
  --from-literal=db.name=postgres \
  --from-literal=db.user=postgres \
  --from-literal=db.password=<POSTGRES_PASSWORD>

oc create secret generic unleash-credentials -n $NAMESPACE \
  --from-literal=database-url=postgres://postgres:<POSTGRES_PASSWORD>@postgresql:5432/unleash \
  --from-literal=database-ssl=false \
  --from-literal=admin-api-token='*:*.<UNLEASH_ADMIN_TOKEN>' \
  --from-literal=client-api-token=default:development.<UNLEASH_CLIENT_TOKEN> \
  --from-literal=frontend-api-token=default:development.<UNLEASH_FRONTEND_TOKEN> \
  --from-literal=default-admin-password=<UNLEASH_ADMIN_PASSWORD>

oc create secret generic github-app-secret -n $NAMESPACE \
  --from-literal=GITHUB_APP_ID="<GITHUB_APP_ID>" \
  --from-literal=GITHUB_PRIVATE_KEY="<GITHUB_PRIVATE_KEY>" \
  --from-literal=GITHUB_CLIENT_ID="<GITHUB_CLIENT_ID>" \
  --from-literal=GITHUB_CLIENT_SECRET="<GITHUB_CLIENT_SECRET>" \
  --from-literal=GITHUB_STATE_SECRET=<GITHUB_STATE_SECRET>
```

Use `--dry-run=client -o yaml | oc apply -f -` to make secret creation idempotent on re-runs.

### Credential Encryption Key (required for production)

Credential tokens are encrypted at rest with AES-256-GCM. Generate a key and create the secret:

```bash
ENCRYPTION_KEY=$(openssl rand -base64 32)
oc create secret generic credential-encryption-key -n $NAMESPACE \
  --from-literal=keyring="{\"1\":\"$ENCRYPTION_KEY\"}" \
  --from-literal=version=1
```

The hcmais overlay mounts this as `CREDENTIAL_ENCRYPTION_KEYRING` and `CREDENTIAL_ENCRYPTION_KEY_VERSION`. After first deploy, encrypt existing tokens:

```bash
oc exec deploy/ambient-api-server -n $NAMESPACE -- ambient-api-server encrypt-credentials
```

To rotate: add new key to keyring JSON, bump version, restart, re-run `encrypt-credentials`. To skip in dev: set `CREDENTIAL_ENCRYPTION_ALLOW_PLAINTEXT=true`. See `specs/security/credential-encryption.spec.md`.

### Anthropic API Key (required for runner pods)

```bash
oc create secret generic ambient-runner-secrets -n $NAMESPACE \
  --from-literal=ANTHROPIC_API_KEY=<key>
```

### Vertex AI (optional, instead of direct Anthropic)

```bash
oc create secret generic ambient-vertex -n $NAMESPACE \
  --from-file=ambient-code-key.json=/path/to/service-account-key.json
```

If using Vertex, set `USE_VERTEX=1` in the operator ConfigMap (see Step 4).

---

## Step 3: Deploy with Kustomize

### Scripted (preferred for ephemeral/PR namespaces)

`components/pr-test/install-openshift.sh` deploys a self-contained ACP stack (namespace, secrets, Keycloak, PostgreSQL, API server, control plane, UI, Routes, RBAC) into a single namespace:

```bash
bash components/pr-test/install-openshift.sh <namespace> [image-sha]
```

For dev-mode deployments without SSO:

```bash
bash components/pr-test/install-standard.sh <pr-number>
```

### Production deploy (`make deploy`)

For the production namespace (`ambient-code`), use:

```bash
make deploy
# applies components/manifests/overlays/production via kubectl apply -k
```


### Manual (for debugging or one-off namespaces)

Use a temp dir to avoid modifying the git working tree:

```bash
IMAGE_TAG=<tag>   # e.g. latest, pr-42-amd64, abc1234
NAMESPACE=<target-namespace>

TMPDIR=$(mktemp -d)
cp -r components/manifests/overlays/production/. "$TMPDIR/"
pushd "$TMPDIR"

kustomize edit set namespace $NAMESPACE

kustomize edit set image \
  quay.io/ambient_code/acp_claude_runner:latest=quay.io/ambient_code/acp_claude_runner:$IMAGE_TAG \
  quay.io/ambient_code/acp_api_server:latest=quay.io/ambient_code/acp_api_server:$IMAGE_TAG \

oc apply -k . -n $NAMESPACE

oc set env deployment/ambient-control-plane -n $NAMESPACE \
  GITHUB_MCP_IMAGE=quay.io/ambient_code/acp_credential_github:$IMAGE_TAG \
  JIRA_MCP_IMAGE=quay.io/ambient_code/acp_credential_jira:$IMAGE_TAG \
  K8S_MCP_IMAGE=quay.io/ambient_code/acp_credential_k8s:$IMAGE_TAG \
  GOOGLE_MCP_IMAGE=quay.io/ambient_code/acp_credential_google:$IMAGE_TAG
popd
rm -rf "$TMPDIR"
```

---

## Step 4: Configure the Operator ConfigMap

The operator needs to know which runner images to spawn and whether to use Vertex AI:

```bash
NAMESPACE=<target-namespace>
IMAGE_TAG=<tag>

oc patch configmap operator-config -n $NAMESPACE --type=merge -p "{
  \"data\": {
    \"AMBIENT_CODE_RUNNER_IMAGE\": \"quay.io/ambient_code/acp_claude_runner:$IMAGE_TAG\",
    \"USE_VERTEX\": \"0\",
    \"CLOUD_ML_REGION\": \"\",
    \"ANTHROPIC_VERTEX_PROJECT_ID\": \"\",
    \"GOOGLE_APPLICATION_CREDENTIALS\": \"\"
  }
}"
```

Also patch the agent registry ConfigMap so runner image refs point to the PR tag:

```bash
REGISTRY=$(oc get configmap ambient-agent-registry -n $NAMESPACE \
  -o jsonpath='{.data.agent-registry\.json}')

REGISTRY=$(echo "$REGISTRY" | sed \
  "s|quay.io/ambient_code/acp_claude_runner[@:][^\"]*|quay.io/ambient_code/acp_claude_runner:$IMAGE_TAG|g")
REGISTRY=$(echo "$REGISTRY" | sed \

oc patch configmap ambient-agent-registry -n $NAMESPACE --type=merge \
  -p "{\"data\":{\"agent-registry.json\":$(echo "$REGISTRY" | jq -Rs .)}}"
```

---

## Step 5: Wait for Rollout

```bash
NAMESPACE=<target-namespace>

for deploy in backend-api frontend agentic-operator postgresql minio unleash public-api; do
  oc rollout status deployment/$deploy -n $NAMESPACE --timeout=300s
done
```

`ambient-api-server-db` and `ambient-api-server` may take longer due to DB init:

```bash
oc rollout status deployment/ambient-api-server-db -n $NAMESPACE --timeout=300s
oc rollout status deployment/ambient-api-server -n $NAMESPACE --timeout=300s
```

---

## Step 6: Verify Installation

### Pod Status

```bash
oc get pods -n $NAMESPACE
```

Expected — all pods `Running`:
```
NAME                                  READY   STATUS    RESTARTS
agentic-operator-xxxxx                1/1     Running   0
ambient-api-server-xxxxx              1/1     Running   0
ambient-api-server-db-xxxxx           1/1     Running   0
backend-api-xxxxx                     1/1     Running   0
frontend-xxxxx                        2/2     Running   0
minio-xxxxx                           1/1     Running   0
postgresql-xxxxx                      1/1     Running   0
public-api-xxxxx                      1/1     Running   0
unleash-xxxxx                         1/1     Running   0
```

Frontend shows `2/2` because of the oauth-proxy sidecar in the production overlay.

### Routes

```bash
oc get route -n $NAMESPACE
```

### Health Check

```bash
BACKEND_HOST=$(oc get route backend-route -n $NAMESPACE -o jsonpath='{.spec.host}')
curl -s https://$BACKEND_HOST/health
```

Expected: `{"status":"healthy"}`

### Database Tables

```bash
oc exec deployment/ambient-api-server-db -n $NAMESPACE -- \
  psql -U ambient -d ambient_api_server -c "\dt"
```

Expected: 6 tables (events, migrations, project_settings, projects, sessions, users).

### API Server gRPC Streams

```bash
oc logs deployment/ambient-api-server -n $NAMESPACE --tail=20 | grep "gRPC stream"
```

Expected:
```
gRPC stream started /ambient.v1.ProjectService/WatchProjects
gRPC stream started /ambient.v1.SessionService/WatchSessions
```

### SDK Environment Setup

```bash
export AMBIENT_TOKEN="$(oc whoami -t)"
export AMBIENT_PROJECT="$(oc project -q)"
export AMBIENT_API_URL="$(oc get route public-api-route -n $NAMESPACE \
  --template='https://{{.spec.host}}')"
```

---

## Cross-Namespace Image Pull (Required for Runner Pods)

The operator creates runner pods in dynamically-created project namespaces. Those pods pull images from quay.io directly — no cross-namespace image access issue with quay. However, if you're using the OpenShift internal registry, grant pull access:

```bash
oc policy add-role-to-group system:image-puller system:serviceaccounts --namespace=$NAMESPACE
```

---

## Troubleshooting

### ImagePullBackOff

```bash
oc describe pod <pod-name> -n $NAMESPACE | grep -A5 "Events:"
```

- If private: create an image pull secret and link it to the default service account

### API Server TLS Certificate Missing

```bash
oc annotate service ambient-api-server \
  service.beta.openshift.io/serving-cert-secret-name=ambient-api-server-tls \
  -n $NAMESPACE
sleep 15
oc rollout restart deployment/ambient-api-server -n $NAMESPACE
```

### JWT Configuration

Production uses Red Hat SSO JWKS (`--jwk-cert-url=https://sso.redhat.com/...`). For ephemeral test instances, JWT validation may need to be disabled or pointed at a different issuer. Check the `ambient-api-server-jwt-args-patch.yaml` in the production overlay and adjust as needed for non-production contexts.

### CrashLoopBackOff

```bash
oc logs deployment/<name> -n $NAMESPACE --tail=100
oc describe pod -l app=<name> -n $NAMESPACE
```

Common causes: missing secret, wrong DB credentials, missing ConfigMap key.

### Rollout Timeout

```bash
oc get events -n $NAMESPACE --sort-by='.lastTimestamp' | tail -20
```

---

## CLI Access

```bash
acpctl login \
  --url https://$(oc get route ambient-api-server -n $NAMESPACE -o jsonpath='{.spec.host}') \
  --token $(oc whoami -t)
```

---

## Ambient UI Deployment (from deploy/deploy-ui)

Instructions for deploying the ambient-ui component across environments.

## Architecture

The ambient-ui is a Next.js BFF (Backend-for-Frontend) that handles OIDC
authentication as a confidential client, manages server-side sessions,
and proxies API requests to the ambient-api-server with JWT relay.

```
Route (port 443, TLS edge termination)
  → Service (port 3000)
    → Next.js BFF (port 3000)
      ├── OIDC auth (Authorization Code Flow + PKCE against Red Hat SSO)
      ├── Server-side session (iron-session, httpOnly cookie)
      ├── JWT relay to ambient-api-server (Authorization: Bearer <jwt>)
      └── ambient-api-server (port 8000, HTTPS, validates JWT against same issuer)
```

No sidecar proxy. The BFF IS the confidential OIDC client. The browser
never receives a raw JWT — only an httpOnly session cookie.

## Manifest File Map

| File | Purpose |
|------|---------|
| `components/manifests/base/core/ambient-ui-deployment.yaml` | Base Deployment, ServiceAccount, Service |
| `components/manifests/overlays/kind/kustomization.yaml` | Kind overlay (Quay images, no auth) |
| `components/manifests/overlays/kind-local/kustomization.yaml` | Kind-local overlay (localhost images) |
| `components/ambient-ui/Dockerfile` | Multi-stage Docker build |
| `.github/workflows/components-build-deploy.yml` | CI build matrix entry |
| `components/manifests/overlays/hcmais/kustomization.yaml` | HCMAIS overlay (ambient-api namespace, Keycloak SSO) |

Production overlay files exist (`ambient-ui-oauth-patch.yaml`, etc.) but are
disabled — they used origin-oauth-proxy which can't produce JWTs. See Auth section.

## Docker Build

**Build context** is `./components` (not `./components/ambient-ui`), because
the Dockerfile references `ambient-sdk/ts-sdk` as a sibling.

### Critical details

1. **SDK dist/ is gitignored.** The Dockerfile must build it:
   ```dockerfile
   COPY ambient-sdk/ts-sdk /ambient-sdk/ts-sdk
   RUN cd /ambient-sdk/ts-sdk && npm install --ignore-scripts && npm run build
   ```

2. **Standalone output path.** `outputFileTracingRoot: ../..` in next.config.js
   resolves to `/` in Docker (WORKDIR `/app`), so standalone nests under `app/`:
   ```dockerfile
   cp -r .next/standalone/app/. /app-output/
   ```
   Locally it nests under `components/ambient-ui/`. Always verify with:
   ```bash
   find .next/standalone -name server.js -not -path '*/node_modules/*'
   ```

3. **Webpack, not Turbopack.** The build script is `next build --webpack`.
   Turbopack cannot resolve `file:` linked dependencies.

4. **OpenShift permissions.** The builder stage must run:
   ```dockerfile
   chmod -R g=u /app-output && chgrp -R 0 /app-output
   ```
   The runner image (Red Hat Hardened Image) is distroless — no shell at runtime.

### Local build & test

```bash
podman build -t ambient-ui-test -f components/ambient-ui/Dockerfile components/
podman run --rm ambient-ui-test node -e 'require("fs").statSync("/app/server.js"); console.log("server.js found")'
podman run -d --name ambient-ui-test -e HOSTNAME=0.0.0.0 ambient-ui-test
podman exec ambient-ui-test node -e "require('http').get('http://localhost:3000/', r => { console.log(r.statusCode); r.on('data',()=>{}); r.on('end',()=>process.exit(0)); })"
podman stop ambient-ui-test && podman rm ambient-ui-test
```

## Environment Configuration

| Env Var | kind / local | Production |
|---------|-------------|------------|
| `API_SERVER_URL` | `http://ambient-api-server:8000` | `https://ambient-api-server:8000` |
| `NODE_EXTRA_CA_CERTS` | (unset) | `/etc/ssl/service-ca/service-ca.crt` (from service-ca ConfigMap) |
| `SSO_ISSUER_URL` | Keycloak realm URL (auto-generated by `make dev COMPONENT=ambient-ui`) | `https://sso.redhat.com/auth/realms/redhat-external` |
| `SSO_CLIENT_ID` | `ambient-frontend` (Kind Keycloak) | OIDC client ID |
| `SSO_CLIENT_SECRET` | `dev-secret-do-not-use-in-prod` (Kind Keycloak) | OIDC client secret (from Secret) |
| `SESSION_SECRET` | auto-generated from cluster name | Random 32+ byte string (from Secret) |
| `NEXT_PUBLIC_PREVIEW_ALLOWED_HOSTS` | (unset, defaults `localhost:*`) | target domains |

## Authentication

### Native SSO (target architecture)

The BFF handles OIDC directly using Authorization Code Flow with PKCE:

1. User visits ambient-ui → BFF redirects to SSO issuer authorize endpoint
2. User authenticates at Red Hat SSO → redirected back with auth code
3. BFF exchanges code for tokens (access token = JWT, refresh token, ID token)
4. BFF stores tokens in an iron-session encrypted httpOnly cookie
5. On API requests, BFF extracts JWT from session and forwards as `Authorization: Bearer`
6. ambient-api-server validates JWT against `sso.redhat.com` JWKS endpoint

This is already implemented in:
- `src/lib/oidc.ts` — OIDC discovery, auth URL, code exchange, token refresh
- `src/lib/session.ts` — iron-session storage, token expiry, auto-refresh
- `src/lib/auth.ts` — `resolveAccessToken()` extracts JWT from session
- `src/app/api/auth/sso/login/route.ts` — initiates OIDC flow
- `src/app/api/auth/sso/callback/route.ts` — handles callback, stores tokens
- `src/app/api/auth/sso/logout/route.ts` — destroys session

### What's needed to enable native SSO

An OIDC confidential client on `sso.redhat.com/auth/realms/redhat-external`:
- Client protocol: `openid-connect`, access type: `confidential`
- Valid redirect URI: `https://<ambient-ui-route>/api/auth/sso/callback`
- Scopes: `openid`, `email`, `profile`

Then set the env vars: `SSO_ISSUER_URL`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`,
`SESSION_SECRET`, and `AUTH_MODE=native-sso`.

### Why origin-oauth-proxy doesn't work

The OpenShift `origin-oauth-proxy` issues opaque `sha256~` tokens, not JWTs.
The ambient-api-server requires Red Hat SSO JWTs (`--enable-jwt=true`).
Confirmed via source code audit: origin-oauth-proxy has zero JWT support.
The upstream OIDC id_token is decoded for claims and permanently discarded
by the OpenShift OAuth server. No configuration can change this.

Production overlay files for oauth-proxy exist as reference but are disabled.

## Prerequisites (Manual Steps)

### 1. Quay.io repository

`quay.io/ambient_code/acp_ambient_ui` with push access for `acprobbit`.

### 2. OIDC client (REQUIRED for production)

Create on `sso.redhat.com/auth/realms/redhat-external`:
- Client protocol: `openid-connect`, access type: `confidential`
- Redirect URI: `https://<route>/api/auth/sso/callback`
- Scopes: `openid`, `email`, `profile`

### 3. Secrets

```bash
oc create secret generic ambient-ui-config \
  --from-literal=sso-client-id=<client-id> \
  --from-literal=sso-client-secret=<client-secret> \
  --from-literal=session-secret="$(openssl rand -base64 32)"
```

### 4. Route + TLS

OpenShift Route with TLS edge termination, targeting the ambient-ui Service on port 3000.

## Adding ambient-ui to a New Overlay

1. Include base: `resources: [../../base]` (ambient-ui-deployment.yaml is in base/core)
2. Add image entries for `quay.io/ambient_code/acp_ambient_ui`
3. Apply environment patches (auth mode, API URL, SSO config)
4. If auth: create OIDC client and secrets per Prerequisites
5. If OpenShift with HTTPS to ambient-api-server: trust the service-ca bundle.
   The API server TLS cert is signed by OpenShift service-ca, not the default
   SA CA. Create a ConfigMap with inject-cabundle annotation, mount it into the
   ambient-ui container, and set NODE_EXTRA_CA_CERTS=/etc/ssl/service-ca/service-ca.crt
6. Add a Route if external access is needed
7. Verify: `kustomize build overlays/<target> | grep -A5 "name: ambient-ui"`

## HCMAIS Environment (ambient-api namespace)

The `hcmais` overlay deploys to `ambient-api` namespace on the HCMAIS ROSA cluster.
It includes only: ambient-api-server, ambient-api-server-db, ambient-control-plane,
ambient-ui, and postgresql.

### Prerequisites

1. **Keycloak client** — create `ambient-ui` client in the `ambient-code` realm at
   `https://keycloak-ambient-keycloak.apps.rosa.hcmais01ue1.s9m2.p3.openshiftapps.com/admin`:
   - Client authentication: ON (confidential)
   - Root URL: `https://ambient-ui-ambient-api.apps.rosa.hcmais01ue1.s9m2.p3.openshiftapps.com`
   - Valid redirect URIs: `https://ambient-ui-ambient-api.apps.rosa.hcmais01ue1.s9m2.p3.openshiftapps.com/api/auth/sso/callback`
   - Valid post logout redirect URIs: `https://ambient-ui-ambient-api.apps.rosa.hcmais01ue1.s9m2.p3.openshiftapps.com/*`

2. **Secrets** (create in `ambient-api` namespace):
   ```bash
   # SSO credentials for ambient-ui
   oc create secret generic sso-credentials -n ambient-api \
     --from-literal=SSO_ISSUER_URL=https://keycloak-ambient-keycloak.apps.rosa.hcmais01ue1.s9m2.p3.openshiftapps.com/realms/ambient-code \
     --from-literal=SSO_CLIENT_ID=ambient-ui \
     --from-literal=SSO_CLIENT_SECRET=<from-keycloak> \
     --from-literal=SESSION_SECRET=$(head -c 32 /dev/urandom | base64 | head -c 32)
   ```

3. **Deploy**:
   ```bash
   kustomize build components/manifests/overlays/hcmais | oc apply -n ambient-api -f -
   ```

4. **Verify**:
   ```bash
   oc get pods -n ambient-api
   curl -s https://ambient-ui-ambient-api.apps.rosa.hcmais01ue1.s9m2.p3.openshiftapps.com/api/healthz
   ```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Cannot find module '/app/server.js'` | Copy from `.next/standalone/app/` |
| `Can't resolve 'ambient-sdk'` | Build SDK dist in Dockerfile deps stage |
| Liveness probe 401 | Use `/api/healthz`, not `/` |
| `Client sent HTTP request to HTTPS server` | Use `https://` in API_SERVER_URL |
| 401 `text/plain` from API server | Token format mismatch — ensure JWT, not opaque token |
| Turbopack build fails | Use `next build --webpack` |

## Verification

- [ ] `kustomize build overlays/<target>` valid YAML
- [ ] Image references consistent across kustomization, CI, Makefile
- [ ] Pod starts with 0 restarts
- [ ] `/api/healthz` returns 200
- [ ] API proxy returns data
