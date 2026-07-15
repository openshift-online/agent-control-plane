# Gateway OIDC Authentication Specification

**Date:** 2026-07-14
**Status:** Design
**Related:** `gateway-provisioning.spec.md` — gateway lifecycle and provisioning; `gateway-rbac-policy.spec.md` — RBAC policy
**Upstream:** [OpenShell OIDC User Authentication](https://docs.nvidia.com/openshell/latest/kubernetes/access-control#oidc-user-authentication)

---

## Purpose

The Gateway resource SHALL support optional OIDC authentication configuration. When enabled, the control plane SHALL provision the OpenShell gateway with OIDC settings so that the gateway validates `Authorization: Bearer <token>` headers against the configured identity provider's JWKS endpoint. This enables identity-based access control on OpenShell gateways without requiring users to manage raw TOML configuration.

OIDC configuration is expressed as first-class fields on the Gateway API resource, passed through to the `[openshell.gateway.oidc]` section of `gateway.toml` during reconciliation. When OIDC is not configured (the default), gateway behavior is unchanged — unauthenticated access remains permitted.

This enables:
- **Per-gateway OIDC** — Each gateway can independently enable OIDC with its own issuer, audience, and role mappings
- **Declarative configuration** — OIDC settings are managed via `acpctl apply -k`, not manual TOML editing
- **Role-based access** — Gateways can enforce admin/user role separation via JWT claims
- **Testability** — Kind clusters include Keycloak configuration for local OIDC testing

---

## Requirements

### Requirement: Gateway OIDC API Fields

The Gateway API resource SHALL accept an optional `oidc` object containing OIDC configuration fields. These fields map directly to the upstream OpenShell `server.oidc.*` helm values. When `oidc` is absent or `oidc.issuer` is empty, OIDC is disabled.

**Fields:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `oidc.issuer` | string | Yes (to enable OIDC) | `""` | OIDC issuer URL; empty disables OIDC |
| `oidc.audience` | string | No | `"openshell-cli"` | Expected `aud` claim value in JWT |
| `oidc.jwks_ttl` | integer | No | `3600` | JWKS key cache retention in seconds |
| `oidc.roles_claim` | string | No | `""` | Dot-delimited path to roles array in JWT claims |
| `oidc.admin_role` | string | No | `""` | Role name conferring admin access |
| `oidc.user_role` | string | No | `""` | Role name conferring standard user access |
| `oidc.scopes_claim` | string | No | `""` | Dot-delimited path to scopes array in JWT claims |

#### Scenario: Gateway with OIDC enabled via kustomize

- GIVEN a Gateway resource in a kustomize overlay:
  ```yaml
  kind: Gateway
  name: openshell-gateway
  project: tenant-a
  image: ghcr.io/nvidia/openshell/gateway:0.0.80
  server_dns_names:
    - openshell-gateway.tenant-a.svc.cluster.local
  oidc:
    issuer: https://keycloak.example.com/realms/ambient-code
    audience: openshell-cli
    roles_claim: realm_access.roles
    admin_role: openshell-admin
    user_role: openshell-user
  ```
- WHEN the user runs `acpctl apply -k`
- THEN the API server SHALL persist the Gateway with OIDC configuration
- AND the GatewayReconciler SHALL generate a `gateway.toml` containing the `[openshell.gateway.oidc]` section

#### Scenario: Gateway without OIDC (default)

- GIVEN a Gateway resource with no `oidc` field
- WHEN the GatewayReconciler reconciles
- THEN the `gateway.toml` SHALL NOT contain an `[openshell.gateway.oidc]` section
- AND `allow_unauthenticated_users` SHALL remain `true`
- AND gateway behavior SHALL be identical to the current unauthenticated mode

#### Scenario: Patch OIDC configuration on existing gateway

- GIVEN a Gateway resource with OIDC disabled
- WHEN the user patches the Gateway with OIDC fields:
  ```json
  {"oidc": {"issuer": "https://idp.example.com/realms/openshell"}}
  ```
- THEN the API server SHALL update the Gateway's OIDC configuration
- AND the GatewayReconciler SHALL detect the change and update the `gateway.toml`
- AND the gateway StatefulSet SHALL restart to pick up the new configuration

#### Scenario: Disable OIDC by clearing issuer

- GIVEN a Gateway resource with OIDC enabled
- WHEN the user patches the Gateway with `{"oidc": {"issuer": ""}}`
- THEN the GatewayReconciler SHALL remove the `[openshell.gateway.oidc]` section from `gateway.toml`
- AND `allow_unauthenticated_users` SHALL be set back to `true`

---

### Requirement: OIDC Role Validation

When OIDC role-based access control is configured, both `admin_role` and `user_role` MUST be set, or both MUST be empty. Setting only one is not supported per the upstream OpenShell constraint.

#### Scenario: Valid RBAC configuration

- GIVEN a Gateway with `oidc.admin_role = "openshell-admin"` and `oidc.user_role = "openshell-user"`
- WHEN the GatewayReconciler validates the configuration
- THEN validation SHALL pass

#### Scenario: Valid auth-only configuration (no RBAC)

- GIVEN a Gateway with `oidc.issuer` set and both `oidc.admin_role` and `oidc.user_role` empty
- WHEN the GatewayReconciler validates the configuration
- THEN validation SHALL pass
- AND any valid JWT from the configured issuer SHALL be accepted with no role-based distinctions

#### Scenario: Invalid partial RBAC configuration

- GIVEN a Gateway with `oidc.admin_role = "openshell-admin"` and `oidc.user_role = ""`
- WHEN the GatewayReconciler validates the configuration
- THEN validation SHALL fail with a descriptive error: both `admin_role` and `user_role` must be set, or both must be empty
- AND the Gateway SHALL NOT be reconciled until corrected

---

### Requirement: OIDC Configuration in gateway.toml

When a Gateway has OIDC enabled (non-empty `oidc.issuer`), the GatewayReconciler SHALL inject the OIDC configuration into the `gateway.toml` ConfigMap. This applies whether the user provides a custom `config` field or uses the default template.

#### Scenario: OIDC section injected into default gateway.toml

- GIVEN a Gateway with OIDC enabled and no custom `config` field
- WHEN the GatewayReconciler generates the ConfigMap
- THEN `gateway.toml` SHALL contain:
  ```toml
  [openshell.gateway.auth]
  allow_unauthenticated_users = false

  [openshell.gateway.oidc]
  issuer       = "https://keycloak.example.com/realms/ambient-code"
  audience     = "openshell-cli"
  jwks_ttl     = 3600
  roles_claim  = "realm_access.roles"
  admin_role   = "openshell-admin"
  user_role    = "openshell-user"
  scopes_claim = ""
  ```
- AND `allow_unauthenticated_users` SHALL be `false` (overriding the default `true`)

#### Scenario: Custom config overrides bypass OIDC injection

- GIVEN a Gateway with OIDC enabled AND a custom `config` field (raw TOML)
- WHEN the GatewayReconciler generates the ConfigMap
- THEN the custom `config` SHALL be used verbatim as the `gateway.toml`
- AND the GatewayReconciler SHALL NOT inject the `[openshell.gateway.oidc]` section
- AND the user is responsible for including OIDC settings directly in the custom TOML

#### Scenario: Only non-empty OIDC fields written to TOML

- GIVEN a Gateway with only `oidc.issuer` set (all other fields at zero values)
- WHEN the GatewayReconciler generates the ConfigMap
- THEN `gateway.toml` SHALL contain the OIDC section with only non-empty/non-zero fields:
  - `issuer` = the configured value (always present when OIDC is enabled)
  - Other fields (audience, jwks_ttl, roles_claim, etc.) are omitted when empty/zero
- AND the upstream OpenShell gateway SHALL apply its own defaults for omitted fields

---

### Requirement: mTLS Disabled for OIDC Gateways

When OIDC is enabled on a gateway, mTLS (client certificate verification) SHALL be disabled. OIDC clients authenticate via Bearer tokens in the `Authorization` header — requiring client certificates is incompatible with OIDC authentication flows (CLI users, browser-based flows, and external service accounts do not possess gateway client certificates).

The GatewayReconciler SHALL remove the `client_ca_path` setting from the `[openshell.gateway.tls]` section when OIDC is enabled. Server-side TLS (`cert_path`, `key_path`) SHALL remain active for transport encryption.

#### Scenario: OIDC gateway has mTLS disabled

- GIVEN a Gateway with OIDC enabled (non-empty `oidc.issuer`)
- WHEN the GatewayReconciler generates the ConfigMap
- THEN `gateway.toml` SHALL NOT contain a `client_ca_path` setting in the `[openshell.gateway.tls]` section
- AND `cert_path` and `key_path` SHALL remain present (server TLS preserved)
- AND the gateway SHALL accept clients authenticating via Bearer tokens without requiring a client certificate

#### Scenario: Non-OIDC gateway retains mTLS

- GIVEN a Gateway with no OIDC configuration (or `oidc.issuer` is empty)
- WHEN the GatewayReconciler generates the ConfigMap
- THEN `gateway.toml` SHALL retain the `client_ca_path` setting in the `[openshell.gateway.tls]` section
- AND mTLS behavior SHALL be unchanged from the current default

---

### Requirement: OIDC Change Detection

The GatewayReconciler SHALL detect changes to OIDC configuration and trigger a gateway restart when OIDC settings change. OIDC changes are treated the same as TOML config changes.

#### Scenario: OIDC configuration changed

- GIVEN a running gateway with OIDC configured for issuer `https://old-idp.example.com`
- WHEN the Gateway is patched to use issuer `https://new-idp.example.com`
- THEN the GatewayReconciler SHALL update the ConfigMap with the new OIDC settings
- AND the StatefulSet SHALL receive a restart annotation to pick up the new config
- AND the gateway pods SHALL be recreated via rolling update

#### Scenario: OIDC enabled on previously unauthenticated gateway

- GIVEN a running gateway with no OIDC configuration
- WHEN the Gateway is patched to add OIDC fields
- THEN the GatewayReconciler SHALL update the ConfigMap to include the OIDC section
- AND `allow_unauthenticated_users` SHALL change from `true` to `false`
- AND the StatefulSet SHALL restart

---

### Requirement: OpenAPI Schema Extension

The Gateway OpenAPI schema SHALL be extended with an `oidc` object property. The `GatewayPatchRequest` schema SHALL also include the `oidc` field for partial updates.

#### Scenario: OpenAPI schema includes OIDC

- GIVEN the Gateway OpenAPI schema in `openapi.gateways.yaml`
- THEN it SHALL include an `oidc` property defined as:
  ```yaml
  oidc:
    type: object
    description: OIDC authentication configuration for the gateway
    properties:
      issuer:
        type: string
        description: OIDC issuer URL; empty disables OIDC
      audience:
        type: string
        description: Expected aud claim value in JWT
        default: "openshell-cli"
      jwks_ttl:
        type: integer
        description: JWKS key cache retention in seconds
        default: 3600
      roles_claim:
        type: string
        description: Dot-delimited path to roles array in JWT claims
      admin_role:
        type: string
        description: Role name conferring admin access
      user_role:
        type: string
        description: Role name conferring standard user access
      scopes_claim:
        type: string
        description: Dot-delimited path to scopes array in JWT claims
  ```

#### Scenario: SDK regeneration

- WHEN the OpenAPI schema is updated
- THEN `make generate` in the API server SHALL regenerate the Go OpenAPI client
- AND `make generate` in the SDK SHALL regenerate Go, Python, and TypeScript clients with the `oidc` field

---

### Requirement: Database Storage

The Gateway database model SHALL store OIDC configuration as a JSONB column. This follows the same pattern used for `labels` and `annotations`.

#### Scenario: OIDC persisted as JSONB

- GIVEN a Gateway with OIDC configuration
- WHEN the API server persists it
- THEN the `oidc` field SHALL be stored in a `oidc` column of type `jsonb`
- AND the column SHALL be nullable (null = OIDC not configured)

#### Scenario: Migration adds OIDC column

- WHEN the migration runs
- THEN it SHALL add a nullable `oidc` column of type `jsonb` to the `gateways` table
- AND existing gateways SHALL have `oidc = NULL`

---

### Requirement: Kind Cluster OIDC Testing

The Kind cluster Keycloak realm SHALL be configured to support OIDC testing with OpenShell gateways. This enables end-to-end OIDC validation in local development without an external identity provider.

#### Scenario: Keycloak client for OpenShell

- GIVEN the Kind cluster Keycloak realm `ambient-code`
- THEN it SHALL include a public client named `openshell-cli`:
  - `publicClient: true` (CLI-based auth flow)
  - `standardFlowEnabled: true` (authorization code flow)
  - `directAccessGrantsEnabled: true` (resource owner password for testing)
  - Protocol mapper: `audience` mapper adding `openshell-cli` to the `aud` claim

#### Scenario: OpenShell realm roles

- GIVEN the Kind cluster Keycloak realm `ambient-code`
- THEN it SHALL define two realm roles:
  - `openshell-admin` — admin-level access to OpenShell gateways
  - `openshell-user` — standard user access to OpenShell gateways

#### Scenario: User-to-role mappings

- GIVEN the Kind cluster users `admin` and `developer`
- THEN the `admin` user SHALL have the `openshell-admin` realm role assigned
- AND the `developer` user SHALL have the `openshell-user` realm role assigned
- AND both users' tokens SHALL include `realm_access.roles` containing their assigned roles

#### Scenario: Example Gateway with Kind OIDC

- GIVEN the Kind cluster is running with Keycloak
- THEN example Gateway overlays for Kind SHALL include OIDC configuration:
  ```yaml
  kind: Gateway
  name: openshell-gateway
  oidc:
    issuer: http://keycloak-service:8080/realms/ambient-code
    audience: openshell-cli
    roles_claim: realm_access.roles
    admin_role: openshell-admin
    user_role: openshell-user
  ```
- AND the gateway SHALL validate tokens issued by the Kind Keycloak instance

---

## Migration

### Existing Consumers

| Consumer | Impact |
|---|---|
| Gateway OpenAPI schema (`openapi.gateways.yaml`) | Add `oidc` object property |
| Gateway DB model (`plugins/gateways/model.go`) | Add `Oidc` JSONB column |
| Gateway presenter (`plugins/gateways/presenter.go`) | Handle OIDC field serialization |
| Gateway config struct (`internal/gateway/config.go`) | Add `OidcConfig` struct to `GatewayConfig` |
| Gateway manifest overrides (`internal/gateway/manifests.go`) | Inject `[openshell.gateway.oidc]` into ConfigMap |
| Gateway validation (`internal/gateway/validation.go`) | Validate OIDC role pairing constraint |
| Gateway reconciler (`internal/reconciler/gateway_reconciler.go`) | Pass OIDC config to manifest generation, detect OIDC changes |
| Go SDK types (`go-sdk/types/gateway.go`) | Regenerated — add `Oidc` field |
| Python SDK (`python-sdk/ambient_platform/gateway.py`) | Regenerated — add `oidc` field |
| TypeScript SDK (`ts-sdk/src/gateway.ts`) | Regenerated — add `oidc` field |
| Kind Keycloak realm (`manifests/overlays/kind/keycloak-realm.json`) | Add `openshell-cli` client, realm roles, role mappings |
| Example Gateway overlays (`examples/`) | Add OIDC-enabled examples for Kind |
| `configmap.yaml` manifest template | No changes — OIDC is injected at runtime by `ApplyConfigOverrides` |

### Backward Compatibility

- Gateways without `oidc` configuration behave identically to current behavior
- The `oidc` field is optional and nullable — no breaking changes to existing API consumers
- Existing `config` field (raw TOML) continues to work; OIDC fields are merged on top when both are present
- The database migration is additive (new nullable column)

---

## References

- [OpenShell OIDC User Authentication](https://docs.nvidia.com/openshell/latest/kubernetes/access-control#oidc-user-authentication)
- [OpenShell OIDC Values Reference](https://docs.nvidia.com/openshell/latest/kubernetes/access-control#oidc-values-reference)
- [gateway-provisioning.spec.md](./gateway-provisioning.spec.md) — Gateway lifecycle
- [gateway-rbac-policy.spec.md](../security/gateway-rbac-policy.spec.md) — RBAC policy
