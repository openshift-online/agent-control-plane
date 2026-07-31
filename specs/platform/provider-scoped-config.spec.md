# Provider-Scoped Configuration

**Date:** 2026-07-31
**Status:** Proposed
**Related:** `specs/platform/agent-sandbox-config.spec.md` (Provider Declarations, Provider Schema), `specs/platform/control-plane.spec.md` (env var table), `components/ambient-control-plane/internal/openshell/provider_mapping.go` (ProviderConfig)

---

## Problem

Vertex AI providers require three configuration values to function:

| Value | Current Source | Where It Should Come From |
|-------|---------------|---------------------------|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Provider secret (`token` key) | Provider secret (no change) |
| `VERTEX_AI_PROJECT_ID` | Control plane env var `ANTHROPIC_VERTEX_PROJECT_ID` | Provider declaration |
| `VERTEX_AI_REGION` | Control plane env var `CLOUD_ML_REGION` | Provider declaration |

Today, only the service account key is per-provider. The project ID and region are global — set once on the control plane deployment and shared by every Vertex provider in every tenant namespace. This creates two problems:

1. **Multi-tenant inflexibility.** Different teams cannot target different GCP projects or regions. A platform with tenants in `us-central1` and `europe-west4` cannot serve both without running separate control plane instances.

2. **Operator coupling.** Changing the GCP project or region requires a control plane redeployment (env var change + rollout), even though the values are logically per-provider configuration that tenant admins should own.

The same pattern will recur for any future provider type that needs config beyond a single credential token (e.g., custom API base URLs, model overrides, region routing).

---

## Design

### Add `config` field to the Provider declaration schema

Extend the Provider YAML schema (defined in `agent-sandbox-config.spec.md`) with a `config` map:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique provider name within the namespace. |
| `type` | string | yes | ACP credential type (e.g., `vertex`, `github`, `anthropic`). |
| `secret` | string | yes | Name of a Kubernetes Secret holding the credential. |
| `config` | map[string]string | conditionally required | Provider-specific configuration key-value pairs. Passed to the OpenShell gateway as provider config. Required keys depend on provider type — see [Required Config Keys by Provider Type](#required-config-keys-by-provider-type). |

#### Vertex provider example (before)

```yaml
kind: Provider
name: vertex-prod
type: vertex
secret: vertex-sa-key
```

The secret contains only `token` (the SA key JSON). Project ID and region come from control plane env vars.

#### Vertex provider example (after)

```yaml
kind: Provider
name: vertex-prod
type: vertex
secret: vertex-sa-key
config:
  VERTEX_AI_PROJECT_ID: my-gcp-project
  VERTEX_AI_REGION: us-central1
```

All three values are now declared together. The provider is fully self-describing.

### Config resolution: declaration only, no global fallback

The control plane SHALL read provider config exclusively from the provider declaration's `config` map. There is no fallback to control plane env vars.

The global env vars `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION` SHALL be removed from the control plane config. The `VertexProjectID` and `VertexRegion` fields SHALL be removed from the control plane's config struct. Provider config is the provider's responsibility, not the control plane's.

### Required Config Keys by Provider Type

| Provider Type | Required Keys |
|---------------|--------------|
| `vertex` | `VERTEX_AI_PROJECT_ID`, `VERTEX_AI_REGION` |

Provider types not listed here have no required config keys. The table will be extended as new provider types gain config requirements.

### Validation

The control plane SHALL validate provider config at reconcile time:

- **Vertex providers:** Both `VERTEX_AI_PROJECT_ID` and `VERTEX_AI_REGION` MUST be present in the declaration's `config` map. If either is absent, the reconciler SHALL return an error and set the session status to failed with a message indicating the missing config key(s).
- **Unknown config keys:** The control plane SHALL pass all keys through to the gateway without filtering. The gateway is the authority on which keys it recognizes. This keeps ACP forward-compatible with new gateway config keys.
- **Empty values:** Config keys with empty string values SHALL be treated as absent (not passed to the gateway).

### Secret scope

The `config` map contains non-secret configuration (project IDs, regions, URLs). It lives in the ConfigMap alongside the provider declaration, not in the Kubernetes Secret. Only credential material (tokens, keys, passwords) belongs in the Secret.

---

## Changes Required

### 1. Provider declaration parsing

**File:** `components/ambient-control-plane/internal/reconciler/` (provider declaration struct)

Add `Config map[string]string` to the provider declaration struct. Parse it from the YAML alongside `name`, `type`, and `secret`.

### 2. Provider config resolution

**File:** `components/ambient-control-plane/internal/openshell/provider_mapping.go`

Replace `ProviderConfig` to read directly from the declaration config map. The function no longer takes global env-var-sourced parameters:

```go
// Before:
func ProviderConfig(ambientProvider, vertexProjectID, vertexRegion string) map[string]string

// After:
func ProviderConfig(ambientProvider string, declConfig map[string]string) map[string]string
```

For Vertex providers, the function reads `VERTEX_AI_PROJECT_ID` and `VERTEX_AI_REGION` from `declConfig`. Both must be present — there are no defaults. All other keys in `declConfig` are passed through as-is.

### 3. Remove global Vertex config from control plane

**File:** `components/ambient-control-plane/internal/config/config.go`

Remove `VertexProjectID` and `VertexRegion` fields from the config struct. Remove the `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION` env var reads.

**Files:** `components/manifests/base/ambient-control-plane-service.yml`, overlay patches, templates

Remove `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION` env var entries and their `operator-config` ConfigMap references.

### 4. Reconciler call site

**File:** `components/ambient-control-plane/internal/reconciler/kube_reconciler.go` (~line 1309)

Pass the declaration config directly:

```go
// Before:
Config: openshell.ProviderConfig(provType, r.cfg.VertexProjectID, r.cfg.VertexRegion),

// After:
Config: openshell.ProviderConfig(provType, provDecl.Config),
```

### 5. Update agent-sandbox-config.spec.md

Add `config` to the Provider Schema table and update the Provider Declaration structure example to show the `config` field.

### 6. Update examples

**File:** `examples/base/providers/vertex.yaml`

Add `config` with `VERTEX_AI_PROJECT_ID` and `VERTEX_AI_REGION` to demonstrate the full declaration.

### 7. CLI (openshell provider create)

The `--config` flags already exist on the CLI (`openshell provider create --config KEY=VALUE`). No CLI changes are needed — the config values just need to be persisted into the provider declaration ConfigMap rather than being ignored or only passed ephemerally.

---

## Migration

This is a **breaking change** for Vertex providers. Existing Vertex provider declarations that rely on control plane env vars for project ID and region will fail at reconcile time until updated.

1. **Update all Vertex provider declarations.** Add `config` with both `VERTEX_AI_PROJECT_ID` and `VERTEX_AI_REGION` to every Vertex provider declaration ConfigMap before deploying the updated control plane.
2. **Remove global env vars.** After deploying, remove `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION` from control plane manifests, overlay patches, templates, and the `operator-config` ConfigMap. These are dead config.
3. **Update CI.** Any CI workflows that set `ANTHROPIC_VERTEX_PROJECT_ID` or `CLOUD_ML_REGION` on the control plane must instead ensure the provider declaration ConfigMaps include the `config` map.
4. **Documentation.** Update `examples/README.md` and provider setup guides to show `config` as a required part of Vertex provider declarations.

---

## Future Considerations

- **Other provider types.** The `config` mechanism is generic — any provider type can use it. Future providers that need base URLs, custom endpoints, or model routing can use the same field without schema changes.
- **Config in Secret.** If a provider ever needs config values that are sensitive (e.g., a private endpoint URL that reveals infrastructure), the config could alternatively be stored in the Secret alongside the credential. This spec does not address that case — all current config values are non-sensitive.
