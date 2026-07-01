# MLflow Tracing

**Date:** 2026-07-01
**Status:** Proposed
**Related:** `runner.spec.md` — runner lifecycle and observability; `credential-binding.spec.md` — credential resolution hierarchy; `openshell-sandbox-provisioning.spec.md` — gateway credential providers and provider type mapping; `agent-sandbox-config.spec.md` — agent sandbox provider declarations

---

## Purpose

The platform SHALL support opt-in MLflow tracing of Claude SDK interactions. When a user binds an `mlflow` credential to their project, the runner SHALL activate MLflow's Claude Agent SDK autologging, sending traces (prompts, responses, tool calls, token usage, latency) to the user's MLflow tracking server. This replaces the manual span-tracking approach in `mlflow_observability.py` with the SDK-native autologging integration (`mlflow.anthropic.autolog()`), which captures the full call graph automatically.

Tracing is disabled by default. It activates only when all three MLflow environment variables are present in the runner's environment, injected via the `mlflow` credential provider.

---

## Requirements

### Requirement: Runner Image Red Hat IT Root CA

The openshell runner image (built from `Dockerfile.openshell`) SHALL include the Red Hat IT Root CA certificate in the system trust store. This is required because MLflow tracking servers deployed on Red Hat internal infrastructure use certificates signed by this CA.

The CA certificate SHALL be fetched from `https://certs.corp.redhat.com/certs/2022-IT-Root-CA.pem` and installed into the system certificate trust store during the image build.

#### Scenario: CA certificate is trusted

- GIVEN a runner pod built from `Dockerfile.openshell`
- WHEN the runner makes an HTTPS connection to a server whose certificate chain includes the Red Hat 2022 IT Root CA
- THEN the TLS handshake SHALL succeed without certificate verification errors

#### Scenario: CA does not affect non-Red Hat connections

- GIVEN a runner pod built from `Dockerfile.openshell`
- WHEN the runner makes an HTTPS connection to a public server (e.g., `api.anthropic.com`)
- THEN the connection SHALL succeed using the existing system CA bundle (the Red Hat CA is additive)

### Requirement: MLflow Package Dependency

The runner SHALL depend on `mlflow>=3.5`. This version is the minimum required for the `mlflow.anthropic.autolog()` integration with the Claude Agent SDK.

#### Scenario: MLflow autolog available

- GIVEN a runner environment with the `mlflow` package installed
- WHEN Python executes `import mlflow; mlflow.anthropic.autolog()`
- THEN the call SHALL succeed without `ImportError` or `AttributeError`

### Requirement: MLflow Credential Provider

Users MAY bind an `mlflow` credential provider to their project. The credential SHALL be of type `generic` and SHALL provide the following environment variables to the runner:

| Environment Variable | Purpose |
|---|---|
| `MLFLOW_TRACKING_URI` | URL of the MLflow tracking server (e.g., `https://mlflow.example.com`) |
| `MLFLOW_TRACKING_TOKEN` | Authentication token for the MLflow tracking server |
| `MLFLOW_EXPERIMENT_NAME` | Name of the MLflow experiment to log traces to |

The credential provider follows the existing credential binding hierarchy defined in `credential-binding.spec.md` — it can be bound at agent, project, or global scope.

#### Scenario: MLflow credential bound to project

- GIVEN a user creates a credential with provider type `mlflow` containing `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_TOKEN`, and `MLFLOW_EXPERIMENT_NAME`
- AND the user binds the credential to project P
- WHEN a session starts in project P
- THEN the runner pod SHALL have `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_TOKEN`, and `MLFLOW_EXPERIMENT_NAME` set in its environment

#### Scenario: No MLflow credential bound

- GIVEN no `mlflow` credential is bound to project P
- WHEN a session starts in project P
- THEN the runner pod SHALL NOT have `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_TOKEN`, or `MLFLOW_EXPERIMENT_NAME` in its environment (unless set by other means)
- AND tracing SHALL remain disabled

#### Scenario: OpenShell gateway provider type mapping

- GIVEN `OPENSHELL_USE_GATEWAY` is `true`
- AND an `mlflow` credential is bound to a project
- WHEN the control plane creates an OpenShell provider for this credential
- THEN the provider type SHALL be `generic`
- AND the provider SHALL inject `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_TOKEN`, and `MLFLOW_EXPERIMENT_NAME` into the sandbox environment

### Requirement: Conditional Tracing Activation

The runner SHALL activate MLflow Claude SDK autologging if and only if all three of the following environment variables are set to non-empty values:

1. `MLFLOW_TRACKING_URI`
2. `MLFLOW_TRACKING_TOKEN`
3. `MLFLOW_EXPERIMENT_NAME`

When any of the three is missing or empty, tracing SHALL be disabled. There is no separate toggle — the presence of the credential is the toggle.

#### Scenario: All three env vars present — tracing enabled

- GIVEN `MLFLOW_TRACKING_URI` is set to `https://mlflow.example.com`
- AND `MLFLOW_TRACKING_TOKEN` is set to a non-empty value
- AND `MLFLOW_EXPERIMENT_NAME` is set to `my-experiment`
- WHEN the runner initializes the Claude SDK bridge
- THEN the runner SHALL call `mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)`
- AND it SHALL call `mlflow.set_experiment(MLFLOW_EXPERIMENT_NAME)`
- AND it SHALL call `mlflow.anthropic.autolog()` before creating the `ClaudeSDKClient`
- AND all subsequent Claude SDK interactions SHALL be automatically traced to the MLflow tracking server

#### Scenario: Missing MLFLOW_TRACKING_URI — tracing disabled

- GIVEN `MLFLOW_TRACKING_URI` is not set
- AND `MLFLOW_TRACKING_TOKEN` is set
- AND `MLFLOW_EXPERIMENT_NAME` is set
- WHEN the runner initializes the Claude SDK bridge
- THEN the runner SHALL NOT call `mlflow.anthropic.autolog()`
- AND no traces SHALL be sent to any MLflow server

#### Scenario: Missing MLFLOW_TRACKING_TOKEN — tracing disabled

- GIVEN `MLFLOW_TRACKING_URI` is set
- AND `MLFLOW_TRACKING_TOKEN` is not set
- AND `MLFLOW_EXPERIMENT_NAME` is set
- WHEN the runner initializes the Claude SDK bridge
- THEN the runner SHALL NOT call `mlflow.anthropic.autolog()`

#### Scenario: Missing MLFLOW_EXPERIMENT_NAME — tracing disabled

- GIVEN `MLFLOW_TRACKING_URI` is set
- AND `MLFLOW_TRACKING_TOKEN` is set
- AND `MLFLOW_EXPERIMENT_NAME` is not set
- WHEN the runner initializes the Claude SDK bridge
- THEN the runner SHALL NOT call `mlflow.anthropic.autolog()`

#### Scenario: Tracing activation is best-effort

- GIVEN all three MLflow environment variables are set
- WHEN `mlflow.set_tracking_uri()`, `mlflow.set_experiment()`, or `mlflow.anthropic.autolog()` raises an exception (e.g., network unreachable, invalid URI)
- THEN the runner SHALL log a warning
- AND the runner SHALL continue operating normally without tracing
- AND the session SHALL NOT fail due to a tracing initialization error

#### Scenario: Autolog called before ClaudeSDKClient creation

- GIVEN tracing activation conditions are met
- WHEN the runner sets up the Claude SDK bridge
- THEN `mlflow.anthropic.autolog()` SHALL be called before the `ClaudeSDKClient` is instantiated
- AND this ordering is required because MLflow patches the SDK at autolog time — calling it after client creation results in untraced interactions

### Requirement: Tracing Token Security

The `MLFLOW_TRACKING_TOKEN` SHALL be treated as a secret. It SHALL NOT appear in logs, error messages, or API responses.

#### Scenario: Token not logged

- GIVEN `MLFLOW_TRACKING_TOKEN` is set in the runner environment
- WHEN the runner logs tracing initialization status
- THEN the log output SHALL NOT contain the token value
- AND the runner MAY log the token length or a redacted indicator (e.g., `MLFLOW_TRACKING_TOKEN=<set>`)

### Requirement: OPA Network Policy for MLflow Traffic (Gateway Mode)

When operating in gateway mode with MLflow tracing enabled, the sandbox OPA network policy SHALL permit the runner process to reach the MLflow tracking server through the supervisor proxy.

#### Scenario: MLflow tracking server egress

- GIVEN a sandbox with MLflow tracing enabled
- AND the MLflow tracking server is hosted at a URL requiring HTTPS egress
- WHEN the runner sends traces to the tracking server
- THEN the OPA policy SHALL include a network policy section permitting egress to the tracking server's host and port
- AND the allowed binaries SHALL include the runner's Python binaries (`/sandbox/.venv/bin/python`, `/sandbox/.venv/bin/python3`, `/sandbox/.venv/bin/uvicorn`)

---

## Migration

### Existing consumers

| Consumer | Current behavior | Required change |
|----------|-----------------|-----------------|
| `mlflow_observability.py` | Manual span tracking using `mlflow.start_span()` for turn/tool boundaries; activated by `OBSERVABILITY_BACKENDS=mlflow` + `MLFLOW_TRACING_ENABLED=true` | The existing manual tracing continues to work alongside autologging. The autologging activation (`mlflow.anthropic.autolog()`) is a separate code path that traces Claude SDK calls at the SDK level. The two are complementary — manual spans capture runner-level boundaries; autologging captures SDK-level call graphs |
| `observability_config.py` | Controls MLflow backend via `OBSERVABILITY_BACKENDS` env var and `MLFLOW_TRACING_ENABLED` flag | No change — the new autologging activation is independent of the `OBSERVABILITY_BACKENDS` config. It is gated solely on the three MLflow credential env vars |
| `Dockerfile.openshell` | No Red Hat IT Root CA | Add CA certificate fetch and trust store update |
| `pyproject.toml` | `mlflow[kubernetes]==3.13.0` in `mlflow-observability` extra | Verify `mlflow>=3.5` constraint is satisfied (current 3.13.0 already satisfies) |
| `openshell-sandbox-provisioning.spec.md` § Provider type mapping | Maps `jira`, `google`, `kubeconfig`, and unknown types to `generic` | Add `mlflow` → `generic` to the mapping table |
| `agent-sandbox-config.spec.md` § Provider type mapping | Maps credential types to OpenShell provider types | Add `mlflow` → `generic` to the mapping table |
| Control plane `provider_mapping.go` | Maps ambient credential providers to OpenShell provider types | Add `mlflow` → `generic` entry (follows existing pattern for `jira`, `google`, `kubeconfig`) |
| OPA policy (`policy.yaml`) | Network policy sections for known endpoints | Add MLflow tracking server endpoint when MLflow credential is present; tracking server URL is user-configurable, so the policy entry must be dynamically derived from `MLFLOW_TRACKING_URI` or use a wildcard approach |

### Specs requiring amendment

| Spec | Amendment |
|------|-----------|
| `openshell-sandbox-provisioning.spec.md` | Add `mlflow` → `generic` to the provider type mapping table |
| `agent-sandbox-config.spec.md` | Add `mlflow` → `generic` to the provider type mapping table |
| `runner.spec.md` | Add `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_TOKEN`, `MLFLOW_EXPERIMENT_NAME` to the environment variables table; document autologging activation in the startup sequence |
