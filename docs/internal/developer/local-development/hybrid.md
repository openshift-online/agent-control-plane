# Hybrid Local Development

Run components locally (outside cluster) while using kind for dependencies. **Fastest iteration cycle.**

## Overview

Choose which components to run locally based on what you're developing:

| Scenario | Local | In Cluster | Port-Forward | Best For |
|----------|-------|------------|--------------|----------|
| **UI Only** | Frontend | API Server, Control Plane, PostgreSQL, MinIO | API Server → 8000 | UI/UX work |
| **UI + API Server** | UI, API Server | Control Plane, PostgreSQL, MinIO | PostgreSQL → 5432 | API development |
| **Full Stack** | UI, API Server, Control Plane | PostgreSQL, MinIO | PostgreSQL → 5432 | Control plane work |

**Benefits:**
- ⚡ Instant reloads (no image build/push)
- 🐛 Better debugging (direct logs, breakpoints)
- 🚀 Faster iteration (seconds vs minutes)

---

## Scenario 1: UI Only

**Best for:** UI/UX work, React components, styling

Run Next.js dev server locally, connect to API server in cluster via port-forward.

```
Frontend (localhost:3000) → API Server (cluster:8000) → PostgreSQL
```

### Setup

**Terminal 1 - Port-forward API server:**
```bash
# Forward API server service to localhost:8000
kubectl port-forward -n ambient-code svc/ambient-api-server 8000:8000
```

**Terminal 2 - Run frontend:**
```bash
cd components/ambient-ui

# Set backend URL to port-forwarded API server
export BACKEND_URL=http://localhost:8000/api

# Run dev server
npm run dev

# Access at http://localhost:3000
```

### What's Happening

- Frontend talks to API server via port-forward tunnel
- API server runs in cluster, persists sessions in PostgreSQL
- Control plane in cluster watches API server via gRPC, creates runner jobs

### Fast Iteration

- Edit React components → instant hot reload
- Edit styles → instant update
- No backend restarts needed

---

## Scenario 2: UI + API Server

**Best for:** Backend API work, handler logic, new endpoints

Run frontend and API server locally, control plane stays in cluster.

```
Frontend (localhost:3000) → API Server (localhost:8000) → PostgreSQL (cluster)
                                                          ↓ gRPC events
                                          Control Plane (cluster) → creates K8s Jobs
```

### Setup

**One-time: Create minimal cluster**
```bash
# Start kind, scale down components we'll run locally
make kind-up
kubectl scale -n ambient-code deployment/ambient-api-server deployment/ambient-ui --replicas=0
```

**Terminal 1 - API Server:**
```bash
cd components/ambient-api-server
# API server connects to PostgreSQL (in cluster via port-forward or local)
# Port-forward PostgreSQL if using the in-cluster instance:
# kubectl port-forward -n ambient-code svc/ambient-api-server-db 5432:5432
go run ./cmd/ambient-api-server
# Listens on localhost:8000 by default (development environment)
```

**Terminal 2 - Frontend:**
```bash
cd components/ambient-ui
export BACKEND_URL=http://localhost:8000/api
npm run dev

# Access at http://localhost:3000
```

### What's Happening

- API server runs locally, persists sessions in PostgreSQL
- Control plane in cluster watches API server via gRPC, creates runner jobs
- Frontend talks to local API server
- You may need to port-forward PostgreSQL from the cluster, or run it locally

### Fast Iteration

- Edit API server code → restart (few seconds)
- Edit frontend code → instant hot reload
- See logs directly in terminal
- Full debugging with breakpoints

---

## Scenario 3: Full Local Stack

**Best for:** Control Plane development, reconciliation logic, full integration testing

Run everything locally except MinIO and runner jobs.

```
Frontend (localhost:3000) → API Server (localhost:8000) → PostgreSQL (cluster or local)
                                                          ↓ gRPC events
                                          Control Plane (localhost) → K8s API (via KUBECONFIG)
                                                                ↓
                                                   Creates runner jobs in cluster
```

### Setup

**One-time: Create minimal cluster**
```bash
# Start kind, scale down all components we'll run locally
make kind-up
kubectl scale -n ambient-code deployment/ambient-api-server deployment/ambient-ui deployment/ambient-control-plane --replicas=0
```

**Terminal 1 - API Server:**
```bash
cd components/ambient-api-server
# Ensure PostgreSQL is accessible (port-forward or local)
go run ./cmd/ambient-api-server
# Listens on localhost:8000 (REST) and localhost:9000 (gRPC) by default
```

**Terminal 2 - Control Plane:**
```bash
cd components/ambient-control-plane
export KUBECONFIG=~/.kube/config
export AMBIENT_API_SERVER_URL=http://localhost:8000   # local API server
export AMBIENT_GRPC_SERVER_ADDR=localhost:9000         # local gRPC
export AMBIENT_GRPC_USE_TLS=false                      # no TLS for local dev
export AMBIENT_API_TOKEN=<your-token>                  # or set OIDC_CLIENT_ID + OIDC_CLIENT_SECRET
export RUNNER_IMAGE=quay.io/ambient_code/acp_claude_runner:latest
go run ./cmd/ambient-control-plane
```

**Terminal 3 - Frontend:**
```bash
cd components/ambient-ui
export BACKEND_URL=http://localhost:8000/api
npm run dev

# Access at http://localhost:3000
```

### What's Happening

- API server stores sessions in PostgreSQL (in-cluster or local)
- Control plane connects to local API server via gRPC watch streams
- Control plane uses `KUBECONFIG` to create runner jobs in cluster
- MinIO stays in cluster (for session artifact storage)
- Runner jobs still run as pods (containerized execution)

### Fast Iteration

- Edit control plane code → restart (~10 seconds)
- Edit API server code → restart (~5 seconds)
- Edit frontend code → instant hot reload
- See all logs in separate terminals
- Full debugging across entire stack

---

## VS Code Tasks

We've created VS Code tasks for quick access:

**Kind Cluster:**
- `Kind: Start Cluster` - Create kind cluster with all components
- `Kind: Stop Cluster` - Delete kind cluster
- `Kind: Port-Forward Backend` - Forward API server to localhost:8000
- `Kind: Port-Forward Frontend` - Forward frontend to localhost:3000

**Hybrid Development:**
- `Hybrid: UI Only` - Run frontend + port-forward API server
- `Hybrid: UI + API Server` - Run frontend + API server locally
- `Hybrid: Full Local Stack` - Run all three locally

Access via `Cmd+Shift+P` → "Tasks: Run Task"

---

## Understanding KUBECONFIG vs Port-Forwarding

**Common confusion:** Many think `export KUBECONFIG=~/.kube/config` is port-forwarding. It's not!

**`KUBECONFIG`:**
- Gives the control plane direct access to the Kubernetes API
- The control plane uses it to create/manage runner jobs, namespaces, secrets, etc.
- The API server does NOT use KUBECONFIG -- it talks to PostgreSQL, not K8s

**Port-forwarding (`kubectl port-forward`):**
- Tunnels traffic to a **service** running inside the cluster
- Only needed when you want to access a service's HTTP endpoint from localhost
- Example: Frontend needs to call API server running in cluster, or API server needs PostgreSQL in cluster

**When you need port-forwarding:**
- ✅ Scenario 1 (UI Only) - frontend needs to reach API server in cluster
- ⚠️ Scenario 2 (UI + API Server) - may need port-forward for PostgreSQL if using in-cluster DB
- ⚠️ Scenario 3 (Full Stack) - may need port-forward for PostgreSQL if using in-cluster DB

---

## Tips & Troubleshooting

### Required Environment Variables

**Frontend:**
- `BACKEND_URL=http://localhost:8000/api` - API server URL for Next.js server-side routes
- `NEXT_PUBLIC_API_BASE_URL=/api` - Client-side API base (use `/api` for Next.js proxy)

**API Server:**
- Requires PostgreSQL connection (configured via `--db-*` flags or environment defaults)
- Listens on `localhost:8000` (REST) and gRPC port by default in development mode

**Control Plane:**
- `KUBECONFIG=~/.kube/config` - Path to kubeconfig (for creating K8s jobs/namespaces)
- `AMBIENT_API_SERVER_URL=http://localhost:8000` - API server REST endpoint
- `AMBIENT_GRPC_SERVER_ADDR=localhost:9000` - API server gRPC endpoint
- `AMBIENT_GRPC_USE_TLS=false` - Disable TLS for local dev
- `AMBIENT_API_TOKEN` - API token (or set `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET`)
- `RUNNER_IMAGE` - Runner image (e.g., `quay.io/ambient_code/acp_claude_runner:latest`)

### Debugging

Local processes are much easier to debug:
- **VS Code Go Debugger**: Set breakpoints in API server/control plane code
- **Browser DevTools**: Full React component inspection, network tab
- **Direct logs**: See logs in terminal, no `kubectl logs` needed
- **Fast iteration**: Change code → see results in seconds

### Common Issues

**API server can't connect to PostgreSQL:**
```bash
# Check if PostgreSQL is running in-cluster
kubectl get pods -n ambient-code -l app=ambient-api-server-db

# If running API server locally, port-forward PostgreSQL
kubectl port-forward -n ambient-code svc/ambient-api-server-db 5432:5432
```

**Frontend can't reach API server:**
```bash
# Scenario 1: Check port-forward is running
lsof -i:8000

# Scenario 2/3: Check API server is running locally
curl http://localhost:8000/api/ambient
```

**Control plane not creating jobs:**
```bash
# Check control plane logs for gRPC watch stream status
# Should see "session watch stream established"

# Verify API server is reachable from control plane
curl http://localhost:8000/api/ambient

# Verify KUBECONFIG is set and valid (needed for creating K8s jobs)
echo $KUBECONFIG
kubectl get pods -n ambient-code

# Check that AMBIENT_API_TOKEN or OIDC credentials are set
echo $AMBIENT_API_TOKEN
```

---

## When to Use Each Scenario

| Task | Recommended Scenario | Why |
|------|---------------------|-----|
| **UI/UX changes** | UI Only | Fastest - only need frontend hot reload |
| **New API endpoint** | UI + API Server | Test backend logic with fast restarts |
| **API handler debugging** | UI + API Server | Set breakpoints in API server code |
| **Control plane logic** | Full Stack | See control plane logs directly |
| **Integration testing** | Full Kind Cluster | Test real container behavior |
| **E2E testing** | Full Kind Cluster | Run Cypress tests |

**General rule:** Run the minimum number of components locally that you need to work on.

---

## See Also

- [Kind Local Dev](kind.md) - Full cluster in kind
- [VS Code Tasks](.vscode/tasks.json) - Quick access to dev commands
- [Testing Strategy](../testing/e2e-guide.md) - E2E testing
