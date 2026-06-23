# OpenShell Sandbox Provisioning Specification

**Date:** 2026-06-23
**Status:** Draft — proposed addition to control plane provisioning

---

## Purpose

When the platform operates in OpenShell mode, the control plane SHALL delegate agent pod creation to an OpenShell gateway running in each project namespace, instead of creating Kubernetes pods directly. This provides policy-enforced sandboxing (network, filesystem, process controls) for all agent sessions through OpenShell's security layer.

The OpenShell gateway exposes a gRPC service (`openshell.v1.OpenShell`) that manages sandbox lifecycle. Each project namespace has an OpenShell gateway pre-installed via Helm chart. The control plane discovers it via Kubernetes Service DNS.

For this iteration, ACP will not create the gateway. It will be assumed that the gateway has already been deployed in the namespace.

For this iteration, credentials are still stored in ACP vs being stored within the kubernetes namespace as a Secret.

---

## Requirements

### Requirement: Gateway-Based Sandbox Creation

When `OpenShellEnabled` is true, the control plane SHALL create agent sandboxes by calling the OpenShell gateway's `CreateSandbox` gRPC RPC instead of creating Kubernetes pods directly. The direct pod creation path SHALL be preserved unchanged when `OpenShellEnabled` is false.

#### Scenario: Session provisioning with OpenShell enabled

- GIVEN `OpenShellEnabled` is `true`
- AND an OpenShell gateway is running in the project namespace
- WHEN a session transitions to `Pending` phase
- THEN the control plane SHALL call `CreateSandbox` on the gateway in the session's project namespace
- AND the sandbox SHALL be created with the runner image, session environment variables, and attached credential providers
- AND the session phase SHALL transition to `Running`

#### Scenario: Session provisioning with OpenShell disabled

- GIVEN `OpenShellEnabled` is `false`
- WHEN a session transitions to `Pending` phase
- THEN the control plane SHALL create a Kubernetes pod directly (existing behavior)
- AND no interaction with the OpenShell gateway SHALL occur

#### Scenario: Gateway unreachable

- GIVEN `OpenShellEnabled` is `true`
- AND the OpenShell gateway in the project namespace is unreachable
- WHEN the control plane attempts to create a sandbox
- THEN the operation SHALL fail with an error
- AND the control plane SHALL NOT fall back to direct pod creation

### Requirement: Gateway Discovery via Service DNS

The control plane SHALL discover the OpenShell gateway in each project namespace using Kubernetes Service DNS with a configurable service name and port.

#### Scenario: Default discovery

- GIVEN no override configuration is set
- WHEN the control plane needs to reach the gateway in namespace `my-project`
- THEN it SHALL connect to `openshell-gateway.my-project.svc.cluster.local:8080`

#### Scenario: Custom service name

- GIVEN `OPENSHELL_GATEWAY_SERVICE` is set to `my-gateway`
- AND `OPENSHELL_GATEWAY_PORT` is set to `9090`
- WHEN the control plane needs to reach the gateway in namespace `my-project`
- THEN it SHALL connect to `my-gateway.my-project.svc.cluster.local:9090`

### Requirement: Sandbox Identity and Naming

Each sandbox SHALL have a deterministic name derived from the session ID, and SHALL carry labels that identify the owning session and project.

#### Scenario: Sandbox naming

- GIVEN a session with ID `abc123`
- WHEN a sandbox is created for this session
- THEN the sandbox name SHALL be `session-<safe_name>` where `<safe_name>` is the session ID truncated to 40 characters and lowercased
- AND the sandbox SHALL carry labels `ambient-code.io/session-id`, `ambient-code.io/project-id`, `ambient-code.io/managed=true`, and `ambient-code.io/managed-by=ambient-control-plane`

#### Scenario: Idempotent creation

- GIVEN a sandbox already exists for a session
- WHEN the control plane reconciles the same session again
- THEN it SHALL detect the existing sandbox via `GetSandbox` and skip creation

### Requirement: Credential Mapping to OpenShell Providers

The control plane SHALL map ambient platform credentials to OpenShell providers and attach them to sandboxes, replacing the credential sidecar container pattern.

#### Scenario: Creating providers from ambient credentials

- GIVEN a session has resolved credentials for `github` and `anthropic`
- WHEN the control plane provisions the sandbox
- THEN it SHALL create an OpenShell provider for each credential via the `CreateProvider` RPC
- AND the `github` credential SHALL map to OpenShell provider type `github`
- AND the `anthropic` credential SHALL map to OpenShell provider type `claude`
- AND providers for unrecognized types SHALL use the `generic` OpenShell provider type
- AND each provider name SHALL be scoped to the session (e.g., `session-<safe_id>-github`)

#### Scenario: Attaching providers to sandbox

- GIVEN providers have been created for a session's credentials
- WHEN the sandbox is created
- THEN the `CreateSandboxRequest.Spec.Providers` field SHALL list all provider names
- AND the OpenShell gateway SHALL inject credentials transparently via its egress proxy

#### Scenario: Provider type mapping

- GIVEN the following ambient credential provider names
- THEN they SHALL map to OpenShell provider types as follows:

| Ambient Provider | OpenShell Type |
|---|---|
| `github` | `github` |
| `anthropic` | `claude` |
| `claude` | `claude` |
| `jira` | `generic` |
| `google` | `generic` |
| `vertex` | `vertex-prod` |
| `kubeconfig` | `generic` |
| (unknown) | `generic` |

### Requirement: Sandbox Environment Variables

The control plane SHALL pass session configuration to the sandbox as environment variables in the `CreateSandboxRequest.Spec.Template.Environment` map.

#### Scenario: Environment variable translation

- GIVEN a session with LLM model, prompt, repo URL, and proxy settings
- WHEN the sandbox is created
- THEN all environment variables from `buildEnv()` that have literal string values SHALL be included
- AND Kubernetes-specific `valueFrom` / `fieldRef` entries (e.g., `POD_IP`) SHALL be omitted

### Requirement: Sandbox Deprovisioning

When a session is stopped or deleted, the control plane SHALL delete the sandbox and its associated providers via the OpenShell gateway.

#### Scenario: Session stopping

- GIVEN a running session with an active sandbox
- WHEN the session phase transitions to `Stopping`
- THEN the control plane SHALL call `DeleteSandbox` with the session's sandbox name
- AND the control plane SHALL call `DeleteProvider` for each provider created for the session
- AND the session phase SHALL transition to `Stopped`

#### Scenario: Session deletion

- GIVEN a session with associated sandbox and providers
- WHEN the session is deleted
- THEN the control plane SHALL delete the sandbox and all session-scoped providers
- AND the control plane SHALL continue to clean up Kubernetes resources (service accounts, secrets, services) as before

### Requirement: Sandbox Status Syncing

The control plane SHALL poll sandbox status from the OpenShell gateway and map it to session phases.

#### Scenario: Sandbox phase mapping

- GIVEN a running session with an active sandbox
- WHEN the status syncer polls the gateway
- THEN sandbox phases SHALL map to session phases as follows:

| Sandbox State | Session Phase |
|---|---|
| Sandbox exists, phase `PROVISIONING` | (no change) |
| Sandbox exists, phase `READY` | (no change) |
| Sandbox exists, phase `ERROR` | `Failed` |
| Sandbox not found | `Completed` |

#### Scenario: Sandbox disappearance indicates completion

- GIVEN a running session with an active sandbox
- WHEN the status syncer calls `GetSandbox` and receives a not-found response
- THEN the session phase SHALL transition to `Completed`

#### Scenario: Gateway unreachable during sync

- GIVEN the gateway is temporarily unreachable
- WHEN the status syncer polls
- THEN it SHALL log a warning and retry on the next sync cycle
- AND it SHALL NOT change the session phase

### Requirement: Proto Vendoring and Code Generation

The control plane SHALL vendor OpenShell proto definitions and generate Go gRPC client stubs using buf v2, following the same pattern as the ambient-api-server.

#### Scenario: Proto file structure

- GIVEN the OpenShell proto files (`openshell.proto`, `datamodel.proto`, `sandbox.proto`)
- WHEN vendored into the control plane
- THEN they SHALL be placed at `components/ambient-control-plane/proto/openshell/v1/`
- AND each file SHALL have a `go_package` option added
- AND generated Go stubs SHALL be output to `pkg/openshell/grpc/`

### Requirement: gRPC Connection Management

The control plane SHALL maintain a cache of gRPC connections to OpenShell gateways, one per namespace, with lazy initialization.

#### Scenario: Connection caching

- GIVEN multiple sessions in the same project namespace
- WHEN the control plane creates sandboxes for each
- THEN it SHALL reuse a single gRPC connection per namespace
- AND connections SHALL be created lazily on first use

#### Scenario: Shutdown cleanup

- WHEN the control plane shuts down
- THEN it SHALL close all cached gRPC connections

### Requirement: Configuration

The control plane SHALL expose configuration for OpenShell gateway discovery.

#### Scenario: Configuration fields

- GIVEN the control plane configuration
- THEN the following environment variables SHALL be supported:

| Variable | Default | Purpose |
|---|---|---|
| `OPENSHELL_ENABLED` | `false` | Enable gateway-based sandbox provisioning |
| `OPENSHELL_GATEWAY_SERVICE` | `openshell` | Kubernetes Service name of the gateway |
| `OPENSHELL_GATEWAY_PORT` | `8080` | Port of the gateway gRPC service |

---

## Migration

### Existing consumers

| Consumer | Impact |
|---|---|
| `kube_reconciler.go` `ensurePod()` | Preserved unchanged for `OpenShellEnabled=false` path |
| `kube_reconciler.go` credential sidecars | Replaced by OpenShell providers when gateway mode is active |
| `pod_sync.go` | Extended with sandbox sync branch |
| `main.go` | Extended to create and wire `GatewayClient` |
| `config.go` | Extended with 2 new fields |
| Runner pod | No changes — same image, same env vars, running inside OpenShell sandbox instead of bare pod |

### Backward compatibility

When `OpenShellEnabled=false` (the default), all behavior is identical to the current system. No existing deployment is affected unless the operator explicitly enables the feature and installs OpenShell gateways.
