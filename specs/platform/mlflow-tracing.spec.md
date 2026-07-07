# MLflow Tracing

**Date:** 2026-07-01
**Last Updated:** 2026-07-07
**Status:** Partially Implemented
**Related:** `runner.spec.md` — runner lifecycle and observability; `credential-binding.spec.md` — credential resolution hierarchy; `openshell-sandbox-provisioning.spec.md` — gateway credential providers and provider type mapping; `agent-sandbox-config.spec.md` — agent sandbox provider declarations

---

## Purpose

The platform MUST support MLflow tracing of Claude SDK interactions. When an `mlflow` credential is available (bound at project scope, or inherited from the global credential in the ACP deployment namespace), the runner MUST activate MLflow's Claude Agent SDK autologging, sending traces (prompts, responses, tool calls, token usage, latency) to the MLflow tracking server. This replaces the manual span-tracking approach in `mlflow_observability.py` with the SDK-native autologging integration (`mlflow.anthropic.autolog()`), which captures the full call graph automatically.

Tracing is enabled by default when all three MLflow environment variables are present in the runner's environment, injected via the `mlflow` credential provider. Platform maintainers are responsible for ensuring the `mlflow` credential is present either globally or at project scope. When the `MLFLOW_REQUIRED` environment variable is set to `true`, sandboxes MUST fail to start if any of the three MLflow environment variables are missing, indicating a configuration error.

---

## Requirements

### Requirement: Runner Image Red Hat IT Root CA

The openshell runner image (built from `Dockerfile.openshell`) MUST include the Red Hat IT Root CA certificate in the system trust store when built for internal use. This is required because MLflow tracking servers deployed on Red Hat internal infrastructure use certificates signed by this CA.

The Dockerfile MUST accept an `INTERNAL_BUILD` build argument that defaults to `true`. When `INTERNAL_BUILD=true`, the CA certificate MUST be fetched from `https://certs.corp.redhat.com/certs/2022-IT-Root-CA.pem` and installed into the system certificate trust store. If the fetch fails during an internal build, the image build MUST fail. When `INTERNAL_BUILD` is explicitly set to `false`, the CA fetch MUST be skipped silently.

#### Scenario: CA certificate is trusted (internal build)

- GIVEN a runner image built from `Dockerfile.openshell` with `INTERNAL_BUILD=true`
- WHEN the runner makes an HTTPS connection to a server whose certificate chain includes the Red Hat 2022 IT Root CA
- THEN the TLS handshake MUST succeed without certificate verification errors

#### Scenario: CA fetch failure fails internal build

- GIVEN a `Dockerfile.openshell` build with `INTERNAL_BUILD=true`
- WHEN the CA certificate fetch from `https://certs.corp.redhat.com/certs/2022-IT-Root-CA.pem` fails
- THEN the image build MUST fail with a descriptive error

#### Scenario: CA fetch skipped when INTERNAL_BUILD=false

- GIVEN a `Dockerfile.openshell` build with `INTERNAL_BUILD=false`
- WHEN the image build runs
- THEN the CA certificate fetch MUST be skipped
- AND the build MUST succeed without the Red Hat IT Root CA

#### Scenario: CA does not affect non-Red Hat connections

- GIVEN a runner pod built from `Dockerfile.openshell`
- WHEN the runner makes an HTTPS connection to a public server (e.g., `api.anthropic.com`)
- THEN the connection MUST succeed using the existing system CA bundle (the Red Hat CA is additive)

### Requirement: MLflow Package Dependency

The runner MUST depend on `mlflow>=3.10`. This is the minimum version shipped by Red Hat and the minimum required for the `mlflow.anthropic.autolog()` integration with the Claude Agent SDK.

#### Scenario: MLflow autolog available

- GIVEN a runner environment with the `mlflow` package installed
- WHEN Python executes `import mlflow; mlflow.anthropic.autolog()`
- THEN the call MUST succeed without `ImportError` or `AttributeError`

### Requirement: MLflow Credential Provider

The platform SHALL support an `mlflow` credential provider. The credential MUST be of type `generic` and MUST provide the following environment variables to the runner:

| Environment Variable | Purpose |
|---|---|
| `MLFLOW_TRACKING_URI` | URL of the MLflow tracking server (must be HTTPS, e.g., `https://mlflow.example.com`) |
| `MLFLOW_TRACKING_TOKEN` | Authentication token for the MLflow tracking server |
| `MLFLOW_EXPERIMENT_NAME` | Name of the MLflow experiment to log traces to |

The credential provider follows the existing credential binding hierarchy defined in `credential-binding.spec.md` — it can be bound at agent, project, or global scope. The platform MUST also support a global `mlflow` credential in the ACP deployment namespace. If no `mlflow` credential is bound in the tenant namespace, the platform MUST fall back to the global credential.

#### Scenario: MLflow credential bound to project

- GIVEN a user creates a credential with provider type `mlflow` containing `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_TOKEN`, and `MLFLOW_EXPERIMENT_NAME`
- AND the user binds the credential to project P
- WHEN a session starts in project P
- THEN the runner pod MUST have `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_TOKEN`, and `MLFLOW_EXPERIMENT_NAME` set in its environment

#### Scenario: Global credential fallback

- GIVEN no `mlflow` credential is bound to project P
- AND a global `mlflow` credential exists in the ACP deployment namespace
- WHEN a session starts in project P
- THEN the runner pod MUST inherit `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_TOKEN`, and `MLFLOW_EXPERIMENT_NAME` from the global credential

#### Scenario: No MLflow credential at any scope

- GIVEN no `mlflow` credential is bound to project P
- AND no global `mlflow` credential exists in the ACP deployment namespace
- WHEN a session starts in project P
- THEN the runner pod SHALL NOT have `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_TOKEN`, or `MLFLOW_EXPERIMENT_NAME` in its environment
- AND tracing SHALL remain disabled

#### Scenario: OpenShell gateway provider type mapping

- GIVEN an `mlflow` credential is bound to a project
- WHEN the control plane creates an OpenShell provider for this credential
- THEN the provider type MUST be `generic`
- AND the provider MUST inject `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_TOKEN`, and `MLFLOW_EXPERIMENT_NAME` into the sandbox environment

#### Scenario: Malformed MLFLOW_TRACKING_URI rejected at bind time

- GIVEN a user creates a credential with provider type `mlflow`
- AND the `MLFLOW_TRACKING_URI` value is empty, uses a non-HTTPS scheme (e.g., `http://`), or is otherwise malformed
- WHEN the user attempts to bind the credential
- THEN the API MUST return HTTP 400 with a descriptive error indicating the URI must be a valid HTTPS URL

#### Scenario: MLFLOW_TRACKING_URI validated against domain allowlist

- GIVEN the platform maintains a domain allowlist for MLflow tracking server endpoints
- AND a user creates a credential with an `MLFLOW_TRACKING_URI` whose host does not appear in the allowlist
- WHEN the user attempts to bind the credential
- THEN the API MUST return HTTP 400 with a descriptive error indicating the tracking server domain is not permitted

### Requirement: Conditional Tracing Activation

The runner MUST activate MLflow Claude SDK autologging if and only if all three of the following environment variables are set to non-empty values:

1. `MLFLOW_TRACKING_URI`
2. `MLFLOW_TRACKING_TOKEN`
3. `MLFLOW_EXPERIMENT_NAME`

When any of the three is missing or empty, tracing MUST be disabled.

The `MLFLOW_REQUIRED` environment variable serves as the enforcement toggle. When `MLFLOW_REQUIRED` is set to `true` (e.g., in staging/production environments), sandboxes MUST fail to start if any of the three MLflow environment variables are missing or empty, indicating an environment configuration error. When `MLFLOW_REQUIRED` is not set or is `false` (e.g., in development environments), missing variables simply disable tracing without blocking the session.

#### Scenario: All three env vars present (standard) — tracing enabled

- GIVEN `MLFLOW_TRACKING_URI` is set to `https://mlflow.example.com` (a real URL, not an openshell resolve token)
- AND `MLFLOW_TRACKING_TOKEN` is set to a non-empty value
- AND `MLFLOW_EXPERIMENT_NAME` is set to `my-experiment`
- WHEN the runner initializes the Claude SDK bridge
- THEN the runner MUST call `mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)`
- AND it MUST call `mlflow.set_experiment(MLFLOW_EXPERIMENT_NAME)`
- AND it MUST call `mlflow.anthropic.autolog()` before creating the `ClaudeSDKClient`
- AND all subsequent Claude SDK interactions MUST be automatically traced to the MLflow tracking server

#### Scenario: OpenShell resolve tokens — deferred configuration

- GIVEN `MLFLOW_TRACKING_URI` is set to a value prefixed with `openshell:resolve:env:` (an openshell lazy-resolve token)
- AND `MLFLOW_TRACKING_TOKEN` is set to a non-empty value
- AND `MLFLOW_EXPERIMENT_NAME` is set to a non-empty value
- WHEN the runner initializes the Claude SDK bridge
- THEN the runner MUST NOT call `mlflow.set_tracking_uri()` or `mlflow.set_experiment()` explicitly
- AND the runner MUST defer tracking URI and experiment configuration to runtime environment resolution by the openshell supervisor (which intercepts `getenv()` at the C library level and returns real values)
- AND the runner MUST still call `mlflow.anthropic.autolog()` before creating the `ClaudeSDKClient`
- AND tracing MUST be enabled, relying on MLflow's native environment variable reading through supervisor-intercepted `getenv()`

#### Scenario: Missing MLFLOW_TRACKING_URI — tracing disabled

- GIVEN `MLFLOW_TRACKING_URI` is not set
- AND `MLFLOW_TRACKING_TOKEN` is set
- AND `MLFLOW_EXPERIMENT_NAME` is set
- AND `MLFLOW_REQUIRED` is not set or is `false`
- WHEN the runner initializes the Claude SDK bridge
- THEN the runner MUST NOT call `mlflow.anthropic.autolog()`
- AND no traces MUST be sent to any MLflow server

#### Scenario: Missing MLFLOW_TRACKING_TOKEN — tracing disabled

- GIVEN `MLFLOW_TRACKING_URI` is set
- AND `MLFLOW_TRACKING_TOKEN` is not set
- AND `MLFLOW_EXPERIMENT_NAME` is set
- AND `MLFLOW_REQUIRED` is not set or is `false`
- WHEN the runner initializes the Claude SDK bridge
- THEN the runner MUST NOT call `mlflow.anthropic.autolog()`

#### Scenario: Missing MLFLOW_EXPERIMENT_NAME — tracing disabled

- GIVEN `MLFLOW_TRACKING_URI` is set
- AND `MLFLOW_TRACKING_TOKEN` is set
- AND `MLFLOW_EXPERIMENT_NAME` is not set
- AND `MLFLOW_REQUIRED` is not set or is `false`
- WHEN the runner initializes the Claude SDK bridge
- THEN the runner MUST NOT call `mlflow.anthropic.autolog()`

#### Scenario: MLFLOW_REQUIRED enforces env var presence

- GIVEN `MLFLOW_REQUIRED` is set to `true`
- AND one or more of `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_TOKEN`, or `MLFLOW_EXPERIMENT_NAME` is missing or empty
- WHEN the sandbox attempts to start
- THEN the sandbox MUST fail to start
- AND the error MUST indicate which MLflow environment variables are missing

#### Scenario: MLFLOW_REQUIRED with all env vars present

- GIVEN `MLFLOW_REQUIRED` is set to `true`
- AND all three MLflow environment variables are set to non-empty values
- WHEN the sandbox starts
- THEN tracing MUST activate normally

#### Scenario: Tracing activation is best-effort (standard env)

- GIVEN all three MLflow environment variables are set to real values (not openshell resolve tokens)
- WHEN `mlflow.set_tracking_uri()`, `mlflow.set_experiment()`, or `mlflow.anthropic.autolog()` raises an exception (e.g., network unreachable, invalid URI)
- THEN the runner MUST log a warning
- AND the runner MUST continue operating normally without tracing
- AND the session MUST NOT fail due to a tracing initialization error
- AND autologging MUST NOT be retried after initialization failure — tracing remains disabled for the lifetime of the session

#### Scenario: Autolog called before ClaudeSDKClient creation

- GIVEN tracing activation conditions are met
- WHEN the runner sets up the Claude SDK bridge
- THEN `mlflow.anthropic.autolog()` MUST be called before the `ClaudeSDKClient` is instantiated
- AND this ordering is required because MLflow patches the SDK at autolog time — calling it after client creation results in untraced interactions

### Requirement: Tracing Token Security

The `MLFLOW_TRACKING_TOKEN` MUST be treated as a secret. It MUST NOT appear in logs, error messages, or API responses. ACP MUST use regex redaction (configured to match arbitrary multi-part/base64-encoded JWT tokens) to ensure tokens are not presented in logs, error messages, or API responses.

#### Scenario: Token not logged

- GIVEN `MLFLOW_TRACKING_TOKEN` is set in the runner environment
- WHEN the runner logs tracing initialization status
- THEN the log output MUST NOT contain the token value
- AND the runner MAY log the token length or a redacted indicator (e.g., `MLFLOW_TRACKING_TOKEN=<set>`)

#### Scenario: Token redacted by regex filter

- GIVEN `MLFLOW_TRACKING_TOKEN` contains a multi-part base64-encoded JWT token
- WHEN the token value appears in any log line, error message, or API response
- THEN the regex redaction filter MUST replace the token with a redacted placeholder
- AND the original token value MUST NOT be recoverable from the output

### Requirement: OPA Network Policy for MLflow Traffic (Gateway Mode)

When operating in gateway mode with MLflow tracing enabled, the sandbox OPA network policy MUST permit the runner process to reach the MLflow tracking server through the supervisor proxy. The MLflow network policy is defined as a static entry in the runner's `policy.yaml` file with a known endpoint, prefixed with `_` to indicate it is a platform-managed (non-tenant) policy. The policy entry uses the key `_mlflow_rh` and the name `mlflow-tracking`.

#### Scenario: MLflow tracking server egress

- GIVEN a sandbox with MLflow tracing enabled
- WHEN the runner sends traces to the tracking server
- THEN the OPA policy MUST include a `_mlflow_rh` network policy section permitting egress to the MLflow tracking server's `host:port`
- AND the allowed binaries MUST include the runner's Python binaries (`/sandbox/.venv/bin/python`, `/sandbox/.venv/bin/python3`, `/sandbox/.venv/bin/uvicorn`)
- AND the policy entry MUST be a static entry in `policy.yaml`, not dynamically generated at sandbox-creation time

#### Scenario: Platform-managed policy prefix convention

- GIVEN the runner's `policy.yaml` defines network policies
- WHEN a network policy is platform-managed (not tenant-specific)
- THEN the policy key MUST be prefixed with `_` (e.g., `_mlflow_rh`, `_acp_internal`)
- AND this convention distinguishes platform infrastructure policies from tenant-declared provider policies

---

## Migration

### Existing consumers

| Consumer | Current behavior | Required change |
|----------|-----------------|-----------------|
| `mlflow_observability.py` | Manual span tracking using `mlflow.start_span()` for turn/tool boundaries; activated by `OBSERVABILITY_BACKENDS=mlflow` + `MLFLOW_TRACING_ENABLED=true` | The autologging activation (`mlflow.anthropic.autolog()`) replaces the manual span-tracking approach. Autologging traces Claude SDK calls at the SDK level, capturing the full call graph automatically |
| `observability_config.py` | Controls MLflow backend via `OBSERVABILITY_BACKENDS` env var and `MLFLOW_TRACING_ENABLED` flag | No change — the new autologging activation is independent of the `OBSERVABILITY_BACKENDS` config. It is gated solely on the three MLflow credential env vars |
| `Dockerfile.openshell` | No Red Hat IT Root CA | Add `INTERNAL_BUILD` build arg (default `true`); when `true`, fetch CA certificate and update trust store; fail build if fetch fails |
| `pyproject.toml` | `mlflow[kubernetes]==3.13.0` in `mlflow-observability` extra | Verify `mlflow>=3.10` constraint is satisfied (current 3.13.0 already satisfies) |
| `openshell-sandbox-provisioning.spec.md` § Provider type mapping | Maps `jira`, `google`, `kubeconfig`, and unknown types to `generic` | Add `mlflow` → `generic` to the mapping table |
| `agent-sandbox-config.spec.md` § Provider type mapping | Maps credential types to OpenShell provider types | Add `mlflow` → `generic` to the mapping table |
| Control plane `provider_mapping.go` | Maps ambient credential providers to OpenShell provider types; contained `MLflowNetworkPolicy()` for dynamic OPA policy generation | Add `mlflow` → `generic` entry (follows existing pattern for `jira`, `google`, `kubeconfig`); remove `MLflowNetworkPolicy()` function (superseded by static `policy.yaml` entry) |
| OPA policy (`policy.yaml`) | Network policy sections for known endpoints | Add `_mlflow_rh` static entry with the MLflow tracking server endpoint; uses `_` prefix convention for platform-managed policies (matching `_acp_internal`) |
| `mlflow_observability.py` | Manual span tracking using `mlflow.start_span()` | Add openshell resolve token detection — when `MLFLOW_TRACKING_URI` starts with `openshell:resolve:env:`, skip explicit `mlflow.set_tracking_uri()` / `mlflow.set_experiment()` and defer to runtime env resolution by the openshell supervisor |
| Control plane `config.go` | No MLflow config fields | Add `MLflowTrackingURI` and `MLflowExperimentName` config fields read from `MLFLOW_TRACKING_URI` and `MLFLOW_EXPERIMENT_NAME` env vars (used for auto-creating default MLflow provider from CP namespace secret) |

### Specs requiring amendment

| Spec | Amendment |
|------|-----------|
| `openshell-sandbox-provisioning.spec.md` | Add `mlflow` → `generic` to the provider type mapping table |
| `agent-sandbox-config.spec.md` | Add `mlflow` → `generic` to the provider type mapping table |
| `runner.spec.md` | Add `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_TOKEN`, `MLFLOW_EXPERIMENT_NAME` to the environment variables table; document autologging activation in the startup sequence |

### TODO — not yet implemented

| Requirement | Reason |
|-------------|--------|
| Domain allowlist for `MLFLOW_TRACKING_URI` validation (§ Malformed MLFLOW_TRACKING_URI rejected at bind time, § MLFLOW_TRACKING_URI validated against domain allowlist) | Net-new API server capability — requires a configurable allowlist mechanism and HTTP 400 validation at credential-bind time; no existing pattern to extend |
| Token regex redaction for `MLFLOW_TRACKING_TOKEN` (§ Tracing Token Security) | Requires a runner-wide regex redaction filter capable of matching arbitrary multi-part/base64-encoded JWT tokens in logs, error messages, and API responses; no existing redaction infrastructure to extend |
