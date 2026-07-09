# vTeam Catalog Manual Reload Quickstart

Use this when you want to recreate the current vTeam Catalog lab environment
from the manifests by hand.

## 0. Start From The Feature Worktree

```bash
cd "$(git rev-parse --show-toplevel)"
git status --short --branch
```

Expected branch:

```text
acp-mvp-lab
```

## 1. Create The Local Kind Cluster

```bash
make kind-up CONTAINER_ENGINE=docker OPENSHELL_USE_GATEWAY=true
```

After it finishes, check the assigned ports:

```bash
make kind-status
```

Look for the `backend` port in the output. The examples below call it
`$API_PORT`.

If `acpctl` is not already on `PATH`, build and install it:

```bash
make build-cli
```

Use this helper in the commands below so either the installed CLI or a local
binary works:

```bash
if command -v acpctl >/dev/null 2>&1; then
  ACPCTL=acpctl
elif [ -x components/ambient-cli/acpctl ]; then
  ACPCTL=components/ambient-cli/acpctl
else
  echo "acpctl not found; run: make build-cli" >&2
  return 1 2>/dev/null || exit 1
fi
```

## 2. Start Port-Forwarding

Run this in a second terminal and leave it running:

```bash
cd "$(git rev-parse --show-toplevel)"
make kind-port-forward
```

If you prefer to background it:

```bash
cd "$(git rev-parse --show-toplevel)"
make kind-port-forward > /tmp/acp-kind-port-forward.log 2>&1 &
```

## 3. Log `acpctl` Into The Local API

In the first terminal, log in with the Makefile helper:

```bash
make kind-acpctl-login
export AMBIENT_PROJECT=vteam-product-swarm
```

If you need to do the same steps manually, derive the backend port from
`make kind-status` and read the local test token:

```bash
API_PORT=$(make -s kind-status | awk '
  /Forward:/ {
    for (i = 1; i <= NF; i++) {
      if ($i == "(backend)") {
        print $(i - 1)
      }
    }
  }
')
TOKEN=$(kubectl get secret test-user-token -n ambient-code \
  -o jsonpath='{.data.token}' | base64 -d)

"$ACPCTL" login \
  --url "http://localhost:${API_PORT}" \
  --token "$TOKEN"
```

Quick check:

```bash
export AMBIENT_PROJECT=vteam-product-swarm
"$ACPCTL" get projects
```

## 4. Optional Runtime Secrets

Applying the catalog does not require provider secrets. Starting real sessions
needs the provider backing secrets in namespace `vteam-product-swarm`:

- `vertex-sa-key`
- `github-creds`
- `jira`

If you want Vertex credentials from the repo workflow, run:

```bash
make kind-setup-vertex
```

Then create or copy any missing provider secrets into the vTeam namespace after
the project exists.

## 5. Apply The Current vTeam Catalog Manifests

```bash
export AMBIENT_PROJECT=vteam-product-swarm
"$ACPCTL" apply \
  -k examples/vteam-catalog/product-swarm \
  --project vteam-product-swarm
```

Verify ACP records:

```bash
export AMBIENT_PROJECT=vteam-product-swarm
"$ACPCTL" get project vteam-product-swarm
"$ACPCTL" agent list --project-id vteam-product-swarm
"$ACPCTL" provider list --project-id vteam-product-swarm
```

Verify Kubernetes-side objects:

```bash
kubectl get namespace vteam-product-swarm
kubectl get all,configmap,secret,pvc,serviceaccount,role,rolebinding \
  -n vteam-product-swarm
```

## 6. Troubleshooting

Common causes when ACP commands do not show the vTeam records:

- `make kind-port-forward` is not running.
- `acpctl` is logged into the wrong backend port.
- The lab worktree cluster is not running.
- The vTeam manifests have not been applied yet.

Useful reset commands:

```bash
make kind-status
"$ACPCTL" login --url "http://localhost:${API_PORT}" --token "$TOKEN"
"$ACPCTL" apply -k examples/vteam-catalog/product-swarm --project vteam-product-swarm
```

If `acpctl` is still trying an old URL, re-run the login command with the
current backend port from `make kind-status`.

## 7. Optional: Start A Work Packet Session

Starting real sessions needs provider secrets and an OpenShell gateway for the
`vteam-product-swarm` namespace. The default `OPENSHELL_TENANTS` includes
`vteam-product-swarm`, so the namespace and gateway are provisioned
automatically during `make kind-up`.

After those runtime prerequisites are available, start Stella with the demo work
packet:

```bash
export AMBIENT_PROJECT=vteam-product-swarm
"$ACPCTL" agent start stella \
  --project-id vteam-product-swarm \
  --prompt "Add dark mode to the calculator"
```

Then inspect sessions:

```bash
export AMBIENT_PROJECT=vteam-product-swarm
"$ACPCTL" agent sessions stella --project-id vteam-product-swarm
```
