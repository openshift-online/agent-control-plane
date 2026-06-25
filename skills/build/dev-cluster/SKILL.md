---
name: dev-cluster
description: >
  Manages Ambient Code Platform development clusters (kind) for testing changes
  locally. Use when deploying PRs to kind, bringing up local clusters, rebuilding
  images, troubleshooting pod issues, or running benchmarks. Triggers on: "test
  in kind", "deploy locally", "kind cluster", "rebuild images", "pod crashing",
  "bring up cluster", "kind-up", "dev environment", "local dev".
---

# Development Cluster Management Skill

> **Multi-cluster support:** Each worktree/branch gets its own Kind cluster via `CLUSTER_SLUG`. The Makefile derives `KIND_CLUSTER_NAME` and port variables from the slug. Run `make kind-status` to see assignments. Never hardcode cluster names or ports.

## Platform Components

| Component | Location | Image | Deployment |
|-----------|----------|-------|------------|
| Backend | `components/ambient-api-server` | `acp_api_server:latest` | `ambient-api-server` |
| Frontend | `components/ambient-ui` | `acp_ambient_ui:latest` | `ambient-ui` |
| Control Plane | `components/ambient-control-plane` | `acp_control_plane:latest` | `ambient-control-plane` |
| Runner | `components/runners/ambient-runner` | `acp_claude_runner:latest` | (spawned as Jobs) |

## Cluster Lifecycle

```bash
make kind-up                          # Create cluster with Quay.io images
make kind-up LOCAL_IMAGES=true        # Create cluster with locally-built images
make kind-up LOCAL_IMAGES=true LOCAL_VERTEX=true  # With Vertex AI
make kind-down                        # Destroy cluster
make kind-rebuild                     # Rebuild all + reload + restart
make kind-status                      # Show cluster status and port assignments
make kind-port-forward                # Setup port forwarding
```

**If `make kind-up` fails partway through**, fix the root cause and re-run (`make kind-down && make kind-up`). Never manually patch deployments to recover — the Makefile handles bucket creation, secrets, and port forwarding in order.

## Reloading Individual Components (Hot Deploy)

Use `make kind-reload-*` to rebuild and deploy a single component to a running cluster. These targets build the image with a unique tag (`git-hash-epoch`), load it into kind via `ctr images import`, and use `kubectl set image` to trigger a rollout.

```bash
make kind-reload-ambient-control-plane   # Rebuild + deploy control plane
make kind-reload-ambient-api-server      # Rebuild + deploy API server
make kind-reload-ambient-ui              # Rebuild + deploy frontend
```

### How image loading works in kind

Kind clusters do **not** run a container registry. Images are loaded directly into containerd via `ctr images import` (piped from `podman save` or `docker save`). This means:

- **`imagePullPolicy` must be `IfNotPresent`** (the default for kind deployments). Setting it to `Always` causes `ErrImagePull` because there is no registry to pull from.
- **Unique image tags are required** for Deployment rollouts. With `IfNotPresent`, Kubernetes won't re-pull an image if the tag hasn't changed, so `kind-reload-*` generates a unique tag per build (`<git-short>-<epoch>`).
- **Never use `kubectl rollout restart`** alone to pick up a new image — it only adds a restart annotation. Use `kubectl set image` (which `kind-reload-*` does) to update the image reference in the Deployment spec.

### Manual single-component reload (without make targets)

```bash
CONTAINER_ENGINE=podman  # or docker
TAG=$(git rev-parse --short HEAD)-$(date +%s)
IMG=localhost/acp_control_plane:$TAG

$CONTAINER_ENGINE build -t $IMG -f components/ambient-control-plane/Containerfile components/ambient-control-plane
$CONTAINER_ENGINE save $IMG | $CONTAINER_ENGINE exec -i $(kind get clusters | head -1)-control-plane ctr --namespace=k8s.io images import -
kubectl set image deployment/ambient-control-plane -n ambient-code ambient-control-plane=$IMG
kubectl rollout status deployment/ambient-control-plane -n ambient-code --timeout=60s
```

## Vertex AI / GCP Configuration

```bash
make kind-up LOCAL_IMAGES=true LOCAL_VERTEX=true
```

Requires shell env vars: `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `GOOGLE_APPLICATION_CREDENTIALS`. The `LOCAL_VERTEX=true` flag runs `scripts/setup-vertex-kind.sh` — do not do these steps manually.

## Feature Flags (Unleash)

Unleash runs in-cluster. If an endpoint returns unexpected 404, check if it's behind `requireFeatureFlag()` middleware. Admin token: `*:*.unleash-admin-token`, API at `http://localhost:4242` inside the cluster.

## Workflow: Testing Changes in Kind

### Step 1: Analyze Changes
```bash
git diff --name-only main...HEAD
```

Map changed files to components:
- `components/ambient-api-server/` → backend
- `components/ambient-ui/` → frontend
- `components/ambient-control-plane/` → control plane
- `components/runners/ambient-runner/` → runner

### Step 2: Build and Deploy

**If cluster doesn't exist:** `make kind-up LOCAL_IMAGES=true`

**If cluster exists, reload changed components:**
```bash
make kind-reload-ambient-api-server      # backend changes
make kind-reload-ambient-ui              # frontend changes
make kind-reload-ambient-control-plane   # control plane changes
```

Or rebuild everything: `make kind-rebuild`

### Step 3: Verify Deployment
```bash
kubectl get pods -n ambient-code
kubectl rollout status deployment/<name> -n ambient-code
kubectl get events -n ambient-code --sort-by='.lastTimestamp'
```

### Step 4: Validate Frontend

Always verify before reporting success — port forwarding silently dies on restarts:

```bash
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$KIND_FWD_FRONTEND_PORT 2>/dev/null)
CURL_EXIT=$?
```

If connection refused (`$CURL_EXIT` = 7): `pkill -f "port-forward.*ambient-code"` then `make kind-port-forward &`

## Workflow: Setting Up from a PR

```bash
gh pr view <PR_NUMBER> --json title,headRefName,files,state
git fetch origin <branch_name> && git checkout <branch_name>
# Then follow "Testing Changes in Kind" above
```

## Fast Inner-Loop: Frontend Locally

For frontend-only changes, skip image rebuilds — run NextJS with hot-reload against the kind backend:

```bash
kubectl port-forward svc/ambient-api-server $KIND_FWD_BACKEND_PORT:8080 -n ambient-code &
cd components/ambient-ui && npm install
TOKEN=$(kubectl get secret test-user-token -n ambient-code -o jsonpath='{.data.token}' | base64 -d)
echo "OC_TOKEN=$TOKEN\nBACKEND_URL=http://localhost:$KIND_FWD_BACKEND_PORT/api" > .env.local
npm run dev  # http://localhost:3000
```

## Google OAuth for Integrations

```bash
kubectl set env deployment/ambient-api-server -n ambient-code \
  GOOGLE_OAUTH_CLIENT_ID="..." GOOGLE_OAUTH_CLIENT_SECRET="..." \
  OAUTH_STATE_SECRET="$(openssl rand -hex 32)" BACKEND_URL="http://localhost:$KIND_HTTP_PORT"
```

## Custom Workflow Branches

```bash
kubectl set env deployment/ambient-api-server -n ambient-code OOTB_WORKFLOWS_BRANCH="your-branch"
kubectl rollout restart deployment/ambient-api-server -n ambient-code
```

## Benchmarking

```bash
make benchmark                                    # Human-friendly summary
make benchmark FORMAT=tsv                         # Agent-friendly output
make benchmark COMPONENT=ambient-control-plane MODE=cold  # Single component
```

- `cold` = first-contributor setup cost; `warm` = incremental rebuild cost
- `FORMAT=tsv` preferred for agents; `budget_ok=false` means >60s contributor budget exceeded

## Troubleshooting

### Pods in ImagePullBackOff
Kind has no registry. Ensure `imagePullPolicy: IfNotPresent` and images are loaded:
```bash
make kind-rebuild  # or kind-reload-* for individual components
```

### Pods in CrashLoopBackOff
```bash
kubectl logs -l app=<label> -n ambient-code --tail=100
kubectl describe pod -l app=<label> -n ambient-code
```

### Sessions fail with init-hydrate exit code 1
MinIO bucket missing — `make kind-down && make kind-up` to recreate.

### Changes not reflected
Old image cached. Use `make kind-reload-*` which generates unique tags:
```bash
make kind-reload-ambient-api-server
kubectl describe pod -l app=ambient-api-server -n ambient-code | grep Image:
```

### Port forwarding not working
```bash
pkill -f "port-forward.*ambient-code"
make kind-port-forward
```

## Container Engine Detection

Before manual builds (not needed for `make` targets which auto-detect):
```bash
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    CONTAINER_ENGINE=docker
elif command -v podman &>/dev/null && podman info &>/dev/null 2>&1; then
    CONTAINER_ENGINE=podman
fi
```

## Quick Reference

| Task | Command |
|------|---------|
| Create cluster | `make kind-up` |
| Create with local images | `make kind-up LOCAL_IMAGES=true` |
| Rebuild all | `make kind-rebuild` |
| Reload single component | `make kind-reload-ambient-control-plane` |
| Check status | `make kind-status` |
| View logs | `kubectl logs -f -l app=<label> -n ambient-code` |
| Tear down | `make kind-down` |
