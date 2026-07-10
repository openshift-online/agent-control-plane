# E2E Test Tooling

**Date:** 2026-07-10
**Status:** Design
**Related:** `openshell-sandbox-provisioning.spec.md` — gateway sandbox provisioning; `agent-sandbox-config.spec.md` — agent/provider/policy schema; [PR #318](https://github.com/openshift-online/agent-control-plane/pull/318) — sandbox policy support
**Skill:** `skills/build/full-stack-pipeline/` — wave-based implementation pipeline

---

## Purpose

The gateway e2e test (`tests/e2e/gateway-e2e-test.sh`) validates platform plumbing — session creation, sandbox provisioning, payload delivery, environment injection — but cannot test the full LLM inference round-trip. The existing `smoke-test-llm.sh` requires real Vertex AI credentials, making it impossible to run in CI without secrets.

This spec defines a mock LLM inference service and its integration into the kind development cluster. The mock enables fully self-contained e2e testing of the LLM response path without external API credentials. The implementation is a custom, minimal server that speaks the Anthropic Messages API (`POST /v1/messages`) with streaming SSE support — the wire protocol Claude Code actually uses when `ANTHROPIC_BASE_URL` redirects its calls.

### Scope

- Mock LLM server (FastAPI, Dockerfile, Kubernetes manifests)
- Makefile targets to build, load, and deploy the mock during `make kind-up`
- Example agent, provider, credential, and policy configurations for the mock
- Credential secret provisioning in tenant namespaces
- OpenShell sandbox network policy allowing sandbox-to-mock connectivity

### Dependencies

The sandbox network policy (Requirement 7) depends on PR #318 for `kind: Policy` and the `sandbox_policy` field on agents. All other requirements can land independently.

---

## Requirements

### Requirement: Mock LLM Server

The platform SHALL include a mock LLM server at `tests/mock-llm/` that implements the Anthropic Messages API with deterministic responses. The server exists solely for e2e testing and is not deployed outside of kind development clusters.

The server SHALL be a minimal FastAPI application with the following endpoints:

- `POST /v1/messages` — accepts an Anthropic Messages API request body, extracts the last user message, and returns a deterministic response. Supports both non-streaming and streaming modes (see [Streaming Support](#requirement-streaming-support))
- `GET /health` — liveness/readiness probe returning HTTP 200

When `stream` is absent or `false`, the non-streaming response format SHALL match the Anthropic Messages API schema:

```json
{
  "id": "msg_mock-<uuid>",
  "type": "message",
  "role": "assistant",
  "content": [{"type": "text", "text": "Mock LLM response: <last_user_message>"}],
  "model": "<requested-model>",
  "stop_reason": "end_turn",
  "usage": {"input_tokens": 0, "output_tokens": 0}
}
```

The response content SHALL echo the last user message with a `"Mock LLM response: "` prefix. This makes test assertions deterministic and verifiable.

The server SHALL NOT implement token counting, YAML-based response configuration, or tool use. These are unnecessary for e2e plumbing validation.

#### Scenario: Valid non-streaming messages request

- GIVEN the mock LLM server is running
- WHEN a client sends `POST /v1/messages` with body `{"model": "claude-3-5-sonnet-20241022", "max_tokens": 1024, "messages": [{"role": "user", "content": "What is 2+2?"}]}`
- THEN the server SHALL return HTTP 200
- AND the response body SHALL contain `content[0].text` equal to `"Mock LLM response: What is 2+2?"`
- AND the response SHALL be valid Anthropic Messages API JSON

#### Scenario: Health check

- GIVEN the mock LLM server is running
- WHEN a client sends `GET /health`
- THEN the server SHALL return HTTP 200

#### Scenario: Empty messages array

- GIVEN the mock LLM server is running
- WHEN a client sends `POST /v1/messages` with an empty `messages` array
- THEN the server SHALL return HTTP 200
- AND `content[0].text` SHALL contain a default response (e.g., `"Mock LLM response: "`)

### Requirement: Streaming Support

Claude Code sends `stream: true` by default when calling the Anthropic Messages API. The mock server SHALL support streaming responses via Server-Sent Events (SSE) to exercise the full response path.

When a request includes `"stream": true`, the server SHALL:
- Return `Content-Type: text/event-stream`
- Emit the following SSE event sequence:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_mock-<uuid>","type":"message","role":"assistant","content":[],"model":"<requested-model>","stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Mock LLM response: <last_user_message>"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}

event: message_stop
data: {"type":"message_stop"}

```

The mock MAY emit the full response text in a single `content_block_delta` event rather than splitting it across multiple deltas. This is sufficient for e2e plumbing validation — the goal is to exercise the SSE framing and event type handling, not to simulate realistic token-by-token streaming.

#### Scenario: Streaming messages request

- GIVEN the mock LLM server is running
- WHEN a client sends `POST /v1/messages` with `"stream": true` and `"messages": [{"role": "user", "content": "hello"}]`
- THEN the server SHALL return HTTP 200 with `Content-Type: text/event-stream`
- AND the response SHALL contain a `message_start` event followed by `content_block_start`, `content_block_delta` (containing `"Mock LLM response: hello"`), `content_block_stop`, `message_delta` (with `stop_reason: end_turn`), and `message_stop` events
- AND each event SHALL be framed as `event: <type>\ndata: <json>\n\n`

#### Scenario: Non-streaming fallback

- GIVEN the mock LLM server is running
- WHEN a client sends `POST /v1/messages` without `"stream"` or with `"stream": false`
- THEN the server SHALL return a standard JSON response (not SSE)

### Requirement: Mock LLM Container Image

The mock LLM server SHALL be containerized via a Dockerfile at `tests/mock-llm/Dockerfile`. The image SHALL use `python:3.12-slim` as the base, install only `fastapi` and `uvicorn[standard]` as dependencies, and run as a non-root user. The `uvicorn[standard]` extra is required for SSE streaming support.

#### Scenario: Image builds successfully

- GIVEN the Dockerfile at `tests/mock-llm/Dockerfile`
- WHEN `podman build -t mock-llm:latest tests/mock-llm/` is executed
- THEN the build SHALL succeed
- AND the resulting image SHALL listen on port 8000

#### Scenario: Container runs as non-root

- GIVEN a container started from the mock-llm image
- WHEN the process starts
- THEN the uvicorn process SHALL run as UID 1000 (non-root)

### Requirement: Mock LLM Kubernetes Deployment

The mock LLM server SHALL be deployed as a Kubernetes Deployment with a ClusterIP Service in the `ambient-code` namespace. The deployment manifests SHALL live at `tests/mock-llm/manifests/`.

The Deployment SHALL:
- Run 1 replica with `imagePullPolicy: IfNotPresent` (image loaded locally via `ctr import`)
- Apply a restricted SecurityContext: `runAsNonRoot: true`, drop `ALL` capabilities, `readOnlyRootFilesystem: true`, `seccompProfile: { type: RuntimeDefault }`
- Mount an `emptyDir` volume at `/tmp` — Python and uvicorn write bytecode cache and temporary files to `/tmp`, which is required when `readOnlyRootFilesystem` is `true`
- Configure liveness and readiness probes on `/health`
- Set resource requests and limits

The Service SHALL:
- Be a ClusterIP Service named `mock-llm` on port 8000
- Be reachable cluster-internally at `mock-llm.ambient-code.svc.cluster.local:8000`

#### Scenario: Mock LLM is reachable from within the cluster

- GIVEN `make kind-up` has completed with `OPENSHELL_USE_GATEWAY=true`
- WHEN a pod in the cluster sends a request to `http://mock-llm.ambient-code.svc.cluster.local:8000/health`
- THEN the request SHALL return HTTP 200

#### Scenario: Pod runs with restricted security context

- GIVEN the mock-llm Deployment is applied
- WHEN the pod starts
- THEN the container SHALL run as non-root with all capabilities dropped, a read-only root filesystem, and `seccompProfile: RuntimeDefault`

### Requirement: Makefile Integration

The Makefile SHALL include targets to build, load, and deploy the mock LLM server as part of the `kind-up` flow when `OPENSHELL_USE_GATEWAY=true`.

New targets:
- `build-mock-llm` — builds the container image from `tests/mock-llm/Dockerfile`
- `kind-load-mock-llm` — loads the image into the kind cluster via `ctr import` (following the existing `kind-reload-component` pattern using `podman save` piped through `podman exec`)

The `kind-up` target SHALL call these targets inside the `OPENSHELL_USE_GATEWAY=true` block, after `setup-kind-openshell.sh` completes:
1. Build the mock-llm image
2. Load the image into kind
3. Apply the mock-llm manifests (`kubectl apply -k tests/mock-llm/manifests/`)
4. Wait for the mock-llm Deployment to become ready

#### Scenario: kind-up deploys mock LLM

- GIVEN a developer runs `make kind-up` with `OPENSHELL_USE_GATEWAY=true`
- WHEN the kind-up target completes
- THEN `kubectl get pods -n ambient-code -l app=mock-llm` SHALL show a Running pod
- AND `kubectl get svc -n ambient-code mock-llm` SHALL show a ClusterIP Service on port 8000

#### Scenario: Mock LLM is not deployed without gateway mode

- GIVEN a developer runs `make kind-up` without `OPENSHELL_USE_GATEWAY=true`
- WHEN the kind-up target completes
- THEN no mock-llm Deployment or Service SHALL exist in the `ambient-code` namespace

### Requirement: Mock LLM Agent Configuration

The examples SHALL include a test agent configured to use the mock LLM server via a generic provider. The configuration uses the standard `kind: Provider`, `kind: Agent`, and `kind: Credential` resources applied via `acpctl apply -k`.

**Provider** (`examples/base/providers/mock-llm.yaml`):

```yaml
kind: Provider
name: mock-llm
type: generic
secret: mock-llm-creds
```

The `type: generic` ensures that all keys in the `mock-llm-creds` secret are passed through as environment variables in the sandbox via `ProviderCredentialsFromSecret()` ([`provider_mapping.go:113`](../../components/ambient-control-plane/internal/openshell/provider_mapping.go)).

**Agent** (`examples/base/agents/test-agent-mock-llm.yaml`):

```yaml
kind: Agent
name: test-agent-mock-llm
sandbox_policy: mock-llm-permissive
prompt: "Say hello world"
providers:
  - mock-llm
payloads:
  - sandbox_path: /sandbox/CLAUDE.md
    content: "You are a test agent using a mock LLM backend."
environment:
  ANTHROPIC_BASE_URL: http://mock-llm.ambient-code.svc.cluster.local:8000
  CLAUDE_CODE_ATTRIBUTION_HEADER: "0"
labels:
  purpose: e2e-testing
```

`ANTHROPIC_BASE_URL` redirects Claude Code's Anthropic SDK calls to the mock server. `CLAUDE_CODE_ATTRIBUTION_HEADER` set to `"0"` disables attribution reporting headers that are unnecessary in test runs and would otherwise add noise to mock request validation. Both are set on the agent's `environment` block — they are configuration, not secrets. The auth token is stored in a K8s secret (see [Credential Secret Provisioning](#requirement-credential-secret-provisioning)).

The `sandbox_policy: mock-llm-permissive` field references the OpenShell sandbox policy (see [OpenShell Sandbox Network Policy](#requirement-openshell-sandbox-network-policy)). This field requires PR #318.

**Credential** (`examples/overlays/tenant-a/credential-mock-llm.yaml`):

```yaml
kind: Credential
name: mock-llm-cred
provider: mock-llm
token: mock-llm-token
description: Mock LLM credentials for e2e testing
```

The base `kustomization.yaml` SHALL include the provider, agent, and policy resources. Each tenant overlay that uses the mock SHALL include the credential resource.

#### Scenario: Agent is visible after tenant overlay apply

- GIVEN `make kind-up` has completed with `OPENSHELL_USE_GATEWAY=true`
- AND tenant overlays have been applied via `acpctl apply -k`
- WHEN a user runs `acpctl get agents --project tenant-a`
- THEN `test-agent-mock-llm` SHALL appear in the agent list

#### Scenario: Agent sandbox receives correct environment variables

- GIVEN a session is created for `test-agent-mock-llm` in `tenant-a`
- WHEN the sandbox starts
- THEN the sandbox environment SHALL contain `ANTHROPIC_BASE_URL=http://mock-llm.ambient-code.svc.cluster.local:8000` (from the agent environment block)
- AND `CLAUDE_CODE_ATTRIBUTION_HEADER=0` (from the agent environment block)
- AND `ANTHROPIC_AUTH_TOKEN=mock-llm-token` (from the generic provider secret passthrough)

### Requirement: Credential Secret Provisioning

The `scripts/setup-kind-openshell.sh` script SHALL create a `mock-llm-creds` Kubernetes Secret in each tenant namespace during kind cluster setup. The secret provides the mock auth token that the generic provider passes through to the sandbox.

```bash
kubectl create secret generic mock-llm-creds \
  --namespace="$TENANT" \
  --from-literal=ANTHROPIC_AUTH_TOKEN=mock-llm-token \
  --dry-run=client -o yaml | kubectl apply -f -
```

The secret key `ANTHROPIC_AUTH_TOKEN` is the env var name. Because the provider type is `generic`, `ProviderCredentialsFromSecret()` returns the secret data as-is — all keys become sandbox environment variables. The mock LLM server does not validate the token, so the value `mock-llm-token` is arbitrary.

#### Scenario: Secret exists in tenant namespace

- GIVEN `setup-kind-openshell.sh` has run for `tenant-a`
- WHEN `kubectl get secret mock-llm-creds -n tenant-a -o jsonpath='{.data}'` is executed
- THEN the secret SHALL contain the key `ANTHROPIC_AUTH_TOKEN` with value `mock-llm-token` (base64-encoded)

#### Scenario: Secret creation is idempotent

- GIVEN `mock-llm-creds` already exists in `tenant-a`
- WHEN `setup-kind-openshell.sh` runs again
- THEN the secret SHALL be updated without error (via `--dry-run=client | kubectl apply -f -`)

### Requirement: OpenShell Sandbox Network Policy

> **Dependency:** This requirement depends on PR #318 for `kind: Policy` resource support and the `sandbox_policy` field on agents. The mock LLM infrastructure (server, Dockerfile, manifests, Makefile targets) can land independently of this requirement.

The mock-llm agent's sandbox SHALL have an OpenShell network policy that allows the sandbox to reach the mock LLM service. This uses the `kind: Policy` resource (PR #318), not a Kubernetes NetworkPolicy.

**Policy** (`examples/base/policies/mock-llm-permissive.yaml`):

```yaml
kind: Policy
name: mock-llm-permissive
spec:
  version: 1
  filesystem:
    include_workdir: true
    read_only:
      - /usr
      - /lib
      - /opt
      - /proc
      - /dev/urandom
      - /app
      - /runner
      - /etc
      - /var/log
    read_write:
      - /sandbox
      - /tmp
      - /dev/null
  landlock:
    compatibility: best_effort
  process:
    run_as_user: sandbox
    run_as_group: sandbox
  network_policies:
    mock_llm_inference:
      name: mock-llm-inference
      endpoints:
        - host: mock-llm.ambient-code.svc.cluster.local
          port: 8000
      binaries:
        - path: /usr/local/bin/claude
        - path: /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
        - path: /usr/bin/node
```

The `mock_llm_inference` network rule allows the Claude Code binary (and its Node.js runtime) to reach the mock LLM service endpoint. The policy is otherwise identical to the permissive base policy. Platform-injected rules (`_acp_internal`, `_mlflow_rh`) are merged server-side via `mergePlatformRules()` and do not need to be declared here.

The `test-agent-mock-llm` agent references this policy via `sandbox_policy: mock-llm-permissive`.

#### Scenario: Sandbox can reach mock LLM

- GIVEN a session running `test-agent-mock-llm` in `tenant-a`
- AND the `mock-llm-permissive` policy is applied to the sandbox
- WHEN the Claude Code process inside the sandbox sends a request to `http://mock-llm.ambient-code.svc.cluster.local:8000/v1/messages`
- THEN the request SHALL succeed
- AND the sandbox SHALL receive a valid streamed mock LLM response

#### Scenario: Policy blocks other egress

- GIVEN a session running `test-agent-mock-llm` with the `mock-llm-permissive` policy
- WHEN the Claude Code process attempts to reach an endpoint not listed in the network policy (e.g., `api.anthropic.com:443`)
- THEN the request SHALL be blocked by the OpenShell sandbox network policy

---

## Implementation Notes

### File Locations

| Component | Path |
|---|---|
| Mock LLM server | `tests/mock-llm/server.py` |
| Dockerfile | `tests/mock-llm/Dockerfile` |
| Requirements | `tests/mock-llm/requirements.txt` |
| K8s manifests | `tests/mock-llm/manifests/` |
| Provider | `examples/base/providers/mock-llm.yaml` |
| Agent | `examples/base/agents/test-agent-mock-llm.yaml` |
| Policy | `examples/base/policies/mock-llm-permissive.yaml` |
| Credential | `examples/overlays/tenant-a/credential-mock-llm.yaml` |

### Files to Modify

| File | Change |
|---|---|
| `Makefile` | Add `build-mock-llm`, `kind-load-mock-llm` targets; call from `kind-up` |
| `examples/base/kustomization.yaml` | Add provider, agent, and policy resources |
| `examples/overlays/tenant-a/kustomization.yaml` | Add credential resource |
| `scripts/setup-kind-openshell.sh` | Create `mock-llm-creds` secret in each tenant namespace |

### Generic Provider Credential Flow

The mock-llm provider uses `type: generic`. When the control plane resolves credentials for a generic provider, `ProviderCredentialsFromSecret()` (`provider_mapping.go`) returns the full `secretData` map as-is. Every key in the `mock-llm-creds` K8s secret becomes an environment variable in the sandbox. This is the same mechanism used by the `jira`, `google`, `kubeconfig`, and `mlflow` provider types.

### Image Loading in Kind

The mock-llm image follows the existing pattern for loading locally-built images into podman-based kind clusters:

```bash
podman save ${IMAGE} -o /tmp/mock-llm.tar
podman cp /tmp/mock-llm.tar ${KIND_CONTAINER}:/tmp/mock-llm.tar
podman exec ${KIND_CONTAINER} ctr --namespace=k8s.io images import /tmp/mock-llm.tar
```

This is the same flow used by the `kind-reload-component` Makefile macro. `imagePullPolicy: IfNotPresent` on the Deployment ensures Kubernetes uses the locally-loaded image.
