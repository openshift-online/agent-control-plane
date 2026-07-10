# MLflow Tracing

**Date:** 2026-07-01
**Last Updated:** 2026-07-10
**Status:** Implemented
**Related:** `runner.spec.md` — runner lifecycle and observability; `credential-binding.spec.md` — credential resolution hierarchy; `openshell-sandbox-provisioning.spec.md` — gateway credential providers and provider type mapping; `agent-sandbox-config.spec.md` — agent sandbox provider declarations

---

## Purpose

The platform MUST support MLflow tracing for every runner session when deployment tracking configuration is present. `MLFLOW_TRACKING_URI` is the default-on signal. The runner MUST attempt generic MLflow autologging before any agent SDK client or subprocess-backed agent starts, and it MUST also attempt provider-native GenAI autologging for configured integrations.

Tracing is enabled by default when `MLFLOW_TRACKING_URI` is present in the runner environment. `MLFLOW_TRACING_ENABLED=false` is the explicit kill switch. `MLFLOW_EXPERIMENT_NAME` is optional and defaults to `ambient-code-sessions`. `MLFLOW_TRACKING_TOKEN`, `MLFLOW_TRACKING_AUTH`, and `MLFLOW_WORKSPACE` remain supported for authenticated tracking servers, but missing auth MUST NOT block session startup. MLflow setup and export failures fail open: the runner logs a warning and continues the session, relying on MLflow asynchronous export retry/drop behavior rather than probing tracking-server health during startup.

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

The runner MUST depend on `mlflow>=3.10`. This is the minimum version shipped by Red Hat and the minimum required for GenAI tracing integrations such as Anthropic and OpenAI autologging.

#### Scenario: MLflow autolog available

- GIVEN a runner environment with the `mlflow` package installed
- WHEN Python executes `import mlflow; mlflow.autolog(log_traces=True); mlflow.anthropic.autolog()`
- THEN the call MUST succeed without `ImportError` or `AttributeError`

### Requirement: MLflow Credential Provider

The platform SHALL support an `mlflow` credential provider. The credential secret provides authentication credentials (e.g., `MLFLOW_TRACKING_TOKEN`) which are injected as provider credentials on the OpenShell gateway only when an `mlflow` credential is explicitly bound to the project or agent. `MLFLOW_TRACKING_URI`, `MLFLOW_EXPERIMENT_NAME`, async trace logging settings, and autolog settings are global platform defaults configured as environment variables on the control-plane deployment and forwarded to standard runner pods and OpenShell sandboxes whenever `MLFLOW_TRACKING_URI` is configured.

| Source | Environment Variable | Purpose |
|---|---|---|
| Control-plane env | `MLFLOW_TRACKING_URI` | URL of the MLflow tracking server (must be HTTPS, e.g., `https://mlflow.example.com`) |
| Credential secret | `MLFLOW_TRACKING_TOKEN` | Authentication token for the MLflow tracking server |
| Control-plane env | `MLFLOW_EXPERIMENT_NAME` | Optional experiment name; runner default is `ambient-code-sessions` |
| Control-plane env | `MLFLOW_CREDENTIAL_SECRET_NAME` | Optional source secret name for explicitly bound MLflow credentials; defaults to `mlflow` |
| Control-plane env | `MLFLOW_CREDENTIAL_SECRET_NAMESPACE` | Optional source namespace for explicitly bound MLflow credentials; defaults to the control-plane runtime namespace |
| Control-plane env | `MLFLOW_ENABLE_ASYNC_TRACE_LOGGING` | Optional async trace logging toggle; default forwarded value is `true` |
| Control-plane env | `MLFLOW_AUTOLOG_EXCLUDE_FLAVORS` | Optional comma-separated generic autolog flavor exclusions |
| Control-plane env | `MLFLOW_GENAI_AUTOLOG_INTEGRATIONS` | Optional comma-separated GenAI integrations; default forwarded value is `anthropic,openai` |

The credential provider follows the existing credential binding hierarchy defined in `credential-binding.spec.md` — it can be bound at agent or project scope. The MLflow bearer token source may be materialized by Vault into the ACP deployment namespace, but it MUST NOT be injected into tenant sandboxes unless an `mlflow` credential binding authorizes that project or agent to use it.

The control-plane reads MLflow runtime env from its own process environment (set on the deployment). When `MLFLOW_TRACKING_URI` is set, the control-plane injects the MLflow runtime env into every standard runner pod and OpenShell sandbox. `MLFLOW_TRACKING_URI` is a platform environment variable set at deployment time. Agent-level environment configuration (`agent.environment`) MAY override non-platform MLflow defaults such as `MLFLOW_EXPERIMENT_NAME`, `MLFLOW_TRACING_ENABLED`, `MLFLOW_AUTOLOG_EXCLUDE_FLAVORS`, and `MLFLOW_GENAI_AUTOLOG_INTEGRATIONS`. Agent configuration MUST NOT override platform MLflow routing or authentication keys: `MLFLOW_TRACKING_URI`, `MLFLOW_TRACKING_AUTH`, `MLFLOW_WORKSPACE`, or `MLFLOW_TRACKING_TOKEN`.

#### Scenario: MLflow credential bound to project

- GIVEN a user creates a credential with provider type `mlflow` containing `MLFLOW_TRACKING_TOKEN`
- AND the control-plane deployment has `MLFLOW_TRACKING_URI` set
- AND the user binds the credential to project P
- WHEN a session starts in project P
- THEN the runner pod MUST have `MLFLOW_TRACKING_TOKEN` set via the gateway provider credential
- AND `MLFLOW_TRACKING_URI`, `MLFLOW_TRACING_ENABLED=true`, async trace logging settings, and autolog settings MUST be set from the control-plane's environment

#### Scenario: No MLflow credential binding

- GIVEN no `mlflow` credential is bound to project P
- AND a global MLflow credential source secret exists in the ACP deployment namespace
- WHEN a session starts in project P
- THEN the runner pod SHALL NOT have `MLFLOW_TRACKING_TOKEN` in its environment
- AND `MLFLOW_TRACKING_URI`, `MLFLOW_TRACING_ENABLED=true`, async trace logging settings, and autolog settings SHALL still be set from the control-plane environment
- AND MLflow export errors SHALL NOT fail the session

#### Scenario: Agent-level experiment name override

- GIVEN an `mlflow` credential is bound to a project
- AND the control-plane has `MLFLOW_EXPERIMENT_NAME=acp-general`
- AND the agent configuration sets `environment.MLFLOW_EXPERIMENT_NAME=my-custom-experiment`
- WHEN a session starts using that agent
- THEN the sandbox MUST have `MLFLOW_EXPERIMENT_NAME=my-custom-experiment`

#### Scenario: OpenShell gateway provider type mapping

- GIVEN an `mlflow` credential is bound to a project
- WHEN the control plane creates an OpenShell provider for this credential
- THEN the provider type MUST be `generic`
- AND the provider credentials MUST contain only `MLFLOW_TRACKING_TOKEN` from the secret

#### Scenario: Malformed MLFLOW_TRACKING_URI rejected at startup

- GIVEN the control-plane deployment sets `MLFLOW_TRACKING_URI`
- AND the value is relative, contains URL credentials, uses non-HTTPS for a non-loopback host, or is otherwise malformed
- WHEN the control plane starts
- THEN startup MUST fail with a descriptive error indicating the URI must be a valid HTTPS absolute URL without embedded credentials

#### Scenario: MLFLOW_TRACKING_URI validated against domain allowlist

- GIVEN the platform maintains a domain allowlist for MLflow tracking server endpoints
- AND the control-plane deployment sets `MLFLOW_TRACKING_URI` whose host does not appear in the allowlist
- WHEN the user attempts to bind the credential
- THEN the API MUST return HTTP 400 with a descriptive error indicating the tracking server domain is not permitted

### Requirement: Conditional Tracing Activation

The runner MUST attempt MLflow tracing when `MLFLOW_TRACKING_URI` is set to a non-empty value, unless `MLFLOW_TRACING_ENABLED=false`. `OBSERVABILITY_BACKENDS` MAY include `mlflow`, but it MUST NOT be the only opt-in path.

The runner MUST call generic MLflow autologging before any agent SDK client or subprocess-backed agent starts:

```python
mlflow.autolog(
    log_models=False,
    log_datasets=True,
    log_traces=True,
    silent=False,
    extra_tags={...},
    exclude_flavors=...,
)
```

The runner MUST attempt provider-native GenAI autologging for `MLFLOW_GENAI_AUTOLOG_INTEGRATIONS`, defaulting to `anthropic,openai`. Provider-specific activation failures MUST be logged and MUST NOT fail runner startup.

#### Scenario: Tracking URI present — tracing enabled

- GIVEN `MLFLOW_TRACKING_URI` is set to `https://mlflow.example.com`
- WHEN the runner initializes the Claude SDK bridge
- THEN the runner MUST call `mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)`
- AND it MUST call `mlflow.set_experiment(MLFLOW_EXPERIMENT_NAME or "ambient-code-sessions")`
- AND it MUST call generic `mlflow.autolog(log_models=False, log_datasets=True, log_traces=True, silent=False, ...)`
- AND it MUST attempt `mlflow.anthropic.autolog()` and `mlflow.openai.autolog()` before creating the `ClaudeSDKClient`
- AND ACP session, turn, and tool spans MUST remain the universal trace envelope for Claude, Codex, OpenCode, and CLI-based agents

#### Scenario: Missing MLFLOW_TRACKING_URI — tracing disabled

- GIVEN `MLFLOW_TRACKING_URI` is not set
- WHEN the runner initializes the Claude SDK bridge
- THEN the runner MUST NOT call generic or provider-specific MLflow autologging
- AND no traces MUST be sent to any MLflow server

#### Scenario: Explicit opt-out disables tracing

- GIVEN `MLFLOW_TRACKING_URI` is set
- AND `MLFLOW_TRACING_ENABLED=false`
- WHEN the runner initializes the Claude SDK bridge
- THEN the runner MUST NOT call generic or provider-specific MLflow autologging
- AND the session MUST continue normally

#### Scenario: Tracing activation is best-effort (standard env)

- GIVEN `MLFLOW_TRACKING_URI` is set
- WHEN `mlflow.set_tracking_uri()`, `mlflow.set_experiment()`, generic `mlflow.autolog()`, or provider-specific autologging raises an exception
- THEN the runner MUST log a warning
- AND the session MUST NOT fail due to a tracing initialization error
- AND no MLflow liveness probe or server health check may block pod or session startup

### Requirement: Fast-Fail DNS Pre-Check for Tracking Server

Before calling any MLflow SDK initialization function (`set_tracking_uri`, `set_experiment`), the runner MUST perform a DNS resolution pre-check on the hostname extracted from `MLFLOW_TRACKING_URI`. The pre-check MUST complete within 5 seconds. If DNS resolution fails or times out, the runner MUST skip all MLflow initialization immediately rather than waiting for MLflow's internal HTTP timeout (default: 120 seconds with 7 retries and exponential backoff).

The pre-check result MUST be cached for the lifetime of the process so that subsequent initialization paths (e.g., `MLflowSessionTracer.initialize` after `activate_mlflow_autologging`) return instantly without repeating the DNS lookup.

`MLFLOW_TRACKING_URI` is a platform environment variable that SHALL always contain a valid URI. This requirement does not apply to non-network URIs (file paths, SQLite).

#### Scenario: Unresolvable hostname — fast skip

- GIVEN `MLFLOW_TRACKING_URI` is set to `https://nonexistent.example.invalid:443`
- AND the hostname does not resolve in DNS
- WHEN the runner initializes the Claude SDK bridge
- THEN the DNS pre-check MUST fail within 5 seconds
- AND the runner MUST log a warning indicating DNS resolution failed for the tracking URI hostname
- AND the runner MUST NOT call `mlflow.set_tracking_uri()` or `mlflow.set_experiment()`
- AND the session MUST proceed without MLflow tracing

#### Scenario: Resolvable hostname — normal initialization

- GIVEN `MLFLOW_TRACKING_URI` is set
- AND the hostname resolves in DNS
- WHEN the runner initializes the Claude SDK bridge
- THEN the DNS pre-check MUST succeed
- AND normal MLflow initialization MUST proceed

#### Scenario: Cached pre-check result

- GIVEN the DNS pre-check has already been performed for a given tracking URI
- WHEN a second initialization path invokes the pre-check for the same URI
- THEN the cached result MUST be returned immediately without repeating the DNS lookup

#### Scenario: Non-network URIs bypass pre-check

- GIVEN `MLFLOW_TRACKING_URI` is set to a local path (e.g., `file:///tmp/mlruns` or `sqlite:///mlflow.db`)
- WHEN the runner initializes
- THEN the DNS pre-check MUST NOT be performed
- AND normal MLflow initialization MUST proceed

#### Scenario: Autolog called before agent client creation

- GIVEN tracing activation conditions are met
- WHEN the runner sets up the Claude SDK bridge
- THEN generic and provider-specific MLflow autologging MUST be attempted before the `ClaudeSDKClient` is instantiated
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
| `mlflow_observability.py` | Manual span tracking using `mlflow.start_span()` for turn/tool boundaries | Keep ACP session/turn/tool spans as the universal trace envelope; activate by default when `MLFLOW_TRACKING_URI` is present unless `MLFLOW_TRACING_ENABLED=false` |
| `observability_config.py` | Controls MLflow backend via `OBSERVABILITY_BACKENDS` env var and `MLFLOW_TRACING_ENABLED` flag | Update so `MLFLOW_TRACKING_URI` is the default-on path; `OBSERVABILITY_BACKENDS` remains supported but is not required |
| `Dockerfile.openshell` | No Red Hat IT Root CA | Add `INTERNAL_BUILD` build arg (default `true`); when `true`, fetch CA certificate and update trust store; fail build if fetch fails |
| `pyproject.toml` | `mlflow[kubernetes]==3.13.0` in `mlflow-observability` extra | Verify `mlflow>=3.10` constraint is satisfied (current 3.13.0 already satisfies) |
| `openshell-sandbox-provisioning.spec.md` § Provider type mapping | Maps `jira`, `google`, `kubeconfig`, and unknown types to `generic` | Add `mlflow` → `generic` to the mapping table |
| `agent-sandbox-config.spec.md` § Provider type mapping | Maps credential types to OpenShell provider types | Add `mlflow` → `generic` to the mapping table |
| Control plane `provider_mapping.go` | Maps ambient credential providers to OpenShell provider types; contained `MLflowNetworkPolicy()` for dynamic OPA policy generation | Add `mlflow` → `generic` entry (follows existing pattern for `jira`, `google`, `kubeconfig`); remove `MLflowNetworkPolicy()` function (superseded by static `policy.yaml` entry); remove `MLflowSandboxEnvVars()` and `MLflowProviderCredentials()` — URI and experiment name now come from CP config, not the secret |
| OPA policy (`policy.yaml`) | Network policy sections for known endpoints | Add `_mlflow_rh` static entry with the MLflow tracking server endpoint; uses `_` prefix convention for platform-managed policies (matching `_acp_internal`) |
| `mlflow_observability.py` | Manual span tracking using `mlflow.start_span()` | Add DNS pre-check before `mlflow.set_tracking_uri()` / `mlflow.set_experiment()` to avoid blocking on unresolvable hosts |
| Control plane `config.go` | No MLflow config fields | Add `MLflowTrackingURI` and `MLflowExperimentName` config fields read from `MLFLOW_TRACKING_URI` and `MLFLOW_EXPERIMENT_NAME` env vars; these are the global defaults forwarded to sandboxes that have an MLflow provider |

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
