# Control Plane OIDC Authentication to Gateways

**Date:** 2026-07-14
**Status:** Design
**Depends on:** PR #363 (`feat(gateway): optional OIDC authentication for OpenShell gateways`)
**Related:** `gateway-oidc.spec.md` — gateway-side OIDC configuration; `gateway-provisioning.spec.md` — gateway lifecycle; `sso-authentication.spec.md` — platform SSO model; `control-plane.spec.md` — CP architecture

---

## Purpose

When a Gateway resource has OIDC enabled (non-empty `oidc.issuer`), the control plane's gRPC connection to that gateway SHALL authenticate using an OIDC bearer token obtained via the OAuth2 `client_credentials` grant, instead of mTLS client certificates.

PR #363 configures the gateway side: OIDC-enabled gateways validate `Authorization: Bearer <JWT>` headers and disable mTLS client certificate verification (`client_ca_path` is removed). However, the control plane currently authenticates to all gateways using a fixed strategy — mTLS transport credentials resolved via `TLSResolver` plus a Kubernetes ServiceAccount token injected as gRPC metadata by `authContext()`. Neither credential is valid against an OIDC-enabled gateway: the gateway no longer checks client certificates, and the SA token is not a JWT issued by the gateway's configured OIDC issuer.

This specification closes that gap. When the control plane connects to an OIDC-enabled gateway, it SHALL:

1. Use server-only TLS (verify the gateway's server certificate, but do not present a client certificate)
2. Obtain a JWT from the gateway's OIDC issuer via the `client_credentials` grant
3. Inject the JWT as `Authorization: Bearer <token>` in gRPC metadata
4. Refresh the token transparently before expiry so that gRPC connectivity is never interrupted

The OIDC client credentials are sourced from a Kubernetes Secret named `acp-control-plane-oidc` in the control plane's runtime namespace, mounted via `valueFrom`/`secretKeyRef` on the control plane Deployment. In the Kind test environment, a dedicated Keycloak confidential client provides these credentials. In production, the OIDC provider is whatever issuer URL is configured on the Gateway resource.

---

## Requirements

### Requirement: Per-Gateway Auth Strategy Selection

The control plane SHALL select its authentication strategy for each gateway based on whether the Gateway resource has OIDC enabled. The auth strategy determines both the transport credentials (mTLS vs. server-only TLS) and the application-layer token (SA token vs. OIDC JWT).

| Gateway OIDC state | Transport | Application-layer auth |
|---|---|---|
| OIDC disabled (default) | mTLS (client cert from TLS Secret) | SA token from `saTokenPath` |
| OIDC enabled (`oidc.issuer` non-empty) | Server-only TLS (verify server cert, no client cert) | OIDC JWT from `client_credentials` grant |

The `GatewayClient` SHALL expose a method to register OIDC configuration per namespace (e.g., `SetOIDCConfig(namespace string, oidcCfg *OidcConfig)`). The reconciler SHALL call this method when it processes a Gateway with OIDC enabled. When `getOrCreateConn()` creates a connection for a namespace, it SHALL check the registered OIDC state to select the correct transport and auth strategy.

If the OIDC state of a gateway changes (enabled → disabled or vice versa), the reconciler SHALL call `SetOIDCConfig` with the updated state, which SHALL evict the cached gRPC connection for that namespace so the next call re-establishes it with the correct auth strategy.

#### Scenario: Control plane connects to an OIDC-enabled gateway

- GIVEN a Gateway resource in namespace `tenant-a` with `oidc.issuer = "https://keycloak.example.com/realms/ambient-code"`
- AND the `acp-control-plane-oidc` Secret exists with valid client credentials
- WHEN the control plane makes a gRPC call to the gateway (e.g., `CreateSandbox`)
- THEN the gRPC connection SHALL use server-only TLS (no client certificate presented)
- AND the gRPC metadata SHALL contain `authorization: Bearer <jwt>` where the JWT is obtained from the gateway's OIDC issuer via `client_credentials` grant
- AND the gateway SHALL accept the request

#### Scenario: Control plane connects to a non-OIDC gateway

- GIVEN a Gateway resource in namespace `tenant-b` with no `oidc` configuration
- WHEN the control plane makes a gRPC call to the gateway
- THEN the gRPC connection SHALL use mTLS (client certificate from TLS Secret)
- AND the gRPC metadata SHALL contain `authorization: Bearer <sa-token>` from the SA token file
- AND behavior SHALL be identical to the current implementation

#### Scenario: Gateway OIDC state changes

- GIVEN a cached gRPC connection to a gateway in namespace `tenant-a` using mTLS
- WHEN the Gateway resource is updated to enable OIDC
- AND the GatewayReconciler processes the updated Gateway
- THEN the reconciler SHALL call `GatewayClient.SetOIDCConfig("tenant-a", oidcCfg)` with the new OIDC configuration
- AND `SetOIDCConfig` SHALL evict the cached gRPC connection for `tenant-a`
- AND the next gRPC call SHALL establish a new connection using OIDC auth

---

### Requirement: OIDC Token Acquisition for Gateway Auth

The control plane SHALL obtain OIDC tokens for gateway authentication via the OAuth2 `client_credentials` grant using the credentials from the `acp-control-plane-oidc` Secret. The token provider SHALL be separate from the existing `OIDCTokenProvider` used for API server authentication, as the token URL and client identity differ.

When `OIDC_GATEWAY_TOKEN_URL` is set (from the `acp-control-plane-oidc` Secret's `token-url` key), the control plane SHALL use it directly. When not set, the control plane SHALL derive the token endpoint from the Gateway's `oidc.issuer` by appending `/protocol/openid-connect/token`. This suffix is the Keycloak convention and works for most OIDC providers; non-standard providers SHOULD set `token-url` in the Secret explicitly.

The `oidc.audience` from the Gateway resource SHALL be included as a token request parameter so the issued JWT contains the correct `aud` claim.

#### Scenario: Token acquired via client_credentials grant

- GIVEN the `acp-control-plane-oidc` Secret contains:
  - `token-url`: `http://keycloak-service:11880/realms/ambient-code/protocol/openid-connect/token`
  - `client-id`: `acp-control-plane`
  - `client-secret`: `<secret-value>`
- AND a Gateway has `oidc.audience = "openshell-cli"`
- WHEN the control plane needs a token for this gateway
- THEN it SHALL POST to the token URL with `grant_type=client_credentials`, `client_id`, `client_secret`, and `audience=openshell-cli`
- AND it SHALL use the returned `access_token` as the Bearer token in gRPC metadata

#### Scenario: Token URL not in Secret, derived from Gateway issuer

- GIVEN the `acp-control-plane-oidc` Secret contains `client-id` and `client-secret` but no `token-url`
- AND a Gateway has `oidc.issuer = "https://keycloak.example.com/realms/ambient-code"`
- WHEN the control plane needs a token for this gateway
- THEN it SHALL derive the token URL as `https://keycloak.example.com/realms/ambient-code/protocol/openid-connect/token`
- AND it SHALL use this derived URL for the `client_credentials` grant

#### Scenario: Secret missing or incomplete

- GIVEN the `acp-control-plane-oidc` Secret does not exist or is missing required keys
- AND a Gateway has OIDC enabled
- WHEN the control plane attempts to authenticate to the gateway
- THEN the control plane SHALL log an error with the Secret name and missing keys
- AND the gRPC call SHALL fail with a descriptive error
- AND the control plane SHALL NOT crash

---

### Requirement: Graceful Token Refresh

The control plane SHALL refresh the OIDC token before it expires so that gRPC connectivity to OIDC-enabled gateways is never interrupted. A token lifetime of approximately 5 minutes is expected; the control plane SHALL request a new token when the cached token has less than 30 seconds of remaining validity.

Token refresh SHALL be transparent to callers — no gRPC call SHALL fail due to token expiry under normal conditions (network reachability to the OIDC issuer).

#### Scenario: Token refreshed before expiry

- GIVEN the control plane holds a cached OIDC token with 25 seconds until expiry
- WHEN the control plane makes a gRPC call to an OIDC-enabled gateway
- THEN the control plane SHALL fetch a new token from the OIDC issuer before making the call
- AND the new token SHALL be cached for subsequent calls
- AND the gRPC call SHALL succeed with the fresh token

#### Scenario: Token refresh failure

- GIVEN the control plane's cached OIDC token has expired
- AND the OIDC issuer is temporarily unreachable
- WHEN the control plane makes a gRPC call to an OIDC-enabled gateway
- THEN the gRPC call SHALL fail with an error indicating token refresh failure
- AND the control plane SHALL retry token acquisition on the next gRPC call
- AND the control plane SHALL NOT crash

#### Scenario: Existing gRPC streams survive token refresh

- GIVEN an active gRPC streaming call (e.g., `WatchSandbox`) to an OIDC-enabled gateway
- AND the OIDC token expires during the stream
- WHEN the stream continues to receive events
- THEN the stream SHALL NOT be interrupted by token expiry
- AND new gRPC calls SHALL use a refreshed token

---

### Requirement: Server-Only TLS for OIDC Gateways

When connecting to an OIDC-enabled gateway, the control plane SHALL use server-only TLS — it SHALL verify the gateway's server certificate against the CA bundle but SHALL NOT present a client certificate. This is required because OIDC-enabled gateways do not perform client certificate verification (`client_ca_path` is removed per PR #363).

The server CA certificate SHALL be resolved from the same TLS Secret used for mTLS (`openshell-server-tls` or equivalent), reading only the `ca.crt` field. The `tls.crt` and `tls.key` fields SHALL NOT be loaded for OIDC connections.

#### Scenario: Server-only TLS connection

- GIVEN a Gateway with OIDC enabled in namespace `tenant-a`
- AND the TLS Secret in `tenant-a` contains `ca.crt`
- WHEN the control plane establishes a gRPC connection
- THEN the TLS handshake SHALL verify the gateway's server certificate against `ca.crt`
- AND the control plane SHALL NOT present a client certificate
- AND the connection SHALL succeed

#### Scenario: Fallback to system CA bundle

- GIVEN a Gateway with OIDC enabled in namespace `tenant-a`
- AND no TLS Secret exists in `tenant-a` (gateway uses a publicly-trusted certificate)
- WHEN the control plane establishes a gRPC connection
- THEN the TLS handshake SHALL use the system CA bundle to verify the gateway's server certificate

---

### Requirement: Control Plane OIDC Credential Secret

The OIDC client credentials for gateway authentication SHALL be sourced from a Kubernetes Secret named `acp-control-plane-oidc` in the control plane's runtime namespace. The control plane Deployment SHALL mount these credentials as environment variables using `valueFrom`/`secretKeyRef`.

**Secret schema:**

| Key | Required | Description |
|---|---|---|
| `token-url` | No | OIDC token endpoint URL; if absent, derived from the Gateway's `oidc.issuer` |
| `client-id` | Yes | OAuth2 client ID for the `client_credentials` grant |
| `client-secret` | Yes | OAuth2 client secret |

**Environment variable mapping:**

| Env Var | Secret Key | Purpose |
|---|---|---|
| `OIDC_GATEWAY_TOKEN_URL` | `token-url` | OIDC token endpoint (optional override) |
| `OIDC_GATEWAY_CLIENT_ID` | `client-id` | Client ID for gateway OIDC auth |
| `OIDC_GATEWAY_CLIENT_SECRET` | `client-secret` | Client secret for gateway OIDC auth |

These environment variables are distinct from the existing `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` (which authenticate the control plane to the API server). The gateway OIDC credentials authenticate the control plane to the OIDC-enabled gateway via a potentially different OIDC provider.

#### Scenario: Deployment manifest sources credentials from Secret

- GIVEN the control plane Deployment manifest
- THEN it SHALL include env var entries:
  ```yaml
  - name: OIDC_GATEWAY_TOKEN_URL
    valueFrom:
      secretKeyRef:
        name: acp-control-plane-oidc
        key: token-url
        optional: true
  - name: OIDC_GATEWAY_CLIENT_ID
    valueFrom:
      secretKeyRef:
        name: acp-control-plane-oidc
        key: client-id
        optional: true
  - name: OIDC_GATEWAY_CLIENT_SECRET
    valueFrom:
      secretKeyRef:
        name: acp-control-plane-oidc
        key: client-secret
        optional: true
  ```
- AND all entries SHALL be `optional: true` so the control plane starts without them (non-OIDC gateways do not require these credentials)

#### Scenario: Control plane starts without OIDC gateway credentials

- GIVEN the `acp-control-plane-oidc` Secret does not exist
- AND no gateways have OIDC enabled
- WHEN the control plane starts
- THEN it SHALL start successfully
- AND mTLS gateway connections SHALL work normally
- AND `OIDC_GATEWAY_CLIENT_ID` and `OIDC_GATEWAY_CLIENT_SECRET` SHALL be empty strings

---

### Requirement: Kind Keycloak Client for Control Plane

The Kind cluster Keycloak realm SHALL include a confidential client for the control plane to authenticate to OIDC-enabled gateways via the `client_credentials` grant. This client is separate from the existing `openshell-cli` (public, for end-users) and `ambient-e2e` (for tests) clients.

**Client configuration:**

| Property | Value |
|---|---|
| `clientId` | `acp-control-plane` |
| `publicClient` | `false` (confidential) |
| `secret` | `control-plane-secret-do-not-use-in-prod` |
| `serviceAccountsEnabled` | `true` (enables `client_credentials` grant) |
| `standardFlowEnabled` | `false` (no browser login) |
| `directAccessGrantsEnabled` | `false` (no password grant) |
| Protocol mapper | `audience` mapper adding `openshell-cli` to `aud` claim |
| Service account roles | `openshell-admin` realm role |

The `openshell-admin` role is assigned to the service account so the control plane has full gateway administrative access when OIDC role enforcement is active.

#### Scenario: Keycloak client exists for control plane

- GIVEN the Kind cluster Keycloak realm `ambient-code`
- THEN it SHALL include a confidential client `acp-control-plane`
- AND the client SHALL support the `client_credentials` grant
- AND tokens issued to this client SHALL include `aud: "openshell-cli"`
- AND the service account SHALL have the `openshell-admin` realm role

#### Scenario: Kind Secret provisioned for control plane

- GIVEN the Kind cluster is bootstrapped
- THEN a Secret named `acp-control-plane-oidc` SHALL exist in the `ambient-code` namespace
- AND it SHALL contain:
  - `token-url`: `http://keycloak-service.ambient-code.svc.cluster.local:11880/realms/ambient-code/protocol/openid-connect/token`
  - `client-id`: `acp-control-plane`
  - `client-secret`: `control-plane-secret-do-not-use-in-prod`

#### Scenario: Token lifetime compatible with control plane refresh

- GIVEN the Keycloak realm `ambient-code` has `accessTokenLifespan = 300` (5 minutes)
- AND the control plane refreshes tokens 30 seconds before expiry
- WHEN the control plane continuously communicates with an OIDC gateway
- THEN tokens SHALL be refreshed every ~4.5 minutes
- AND no gRPC call SHALL fail due to token expiry

---

## Migration

### Existing Consumers

| Consumer | Impact |
|---|---|
| `GatewayClient` (`internal/openshell/gateway_client.go`) | New `SetOIDCConfig(namespace, *OidcConfig)` method to register per-namespace OIDC state; `authContext()` becomes `authContextForNamespace(ctx, namespace)` — uses OIDC token for OIDC namespaces, SA token otherwise; `getOrCreateConn()` selects server-only TLS for OIDC gateways |
| `TLSResolver` (`internal/openshell/tls_resolver.go`) | New method or variant to return server-only TLS credentials (CA verification, no client cert) |
| `ControlPlaneConfig` (`internal/config/config.go`) | New fields: `OIDCGatewayTokenURL`, `OIDCGatewayClientID`, `OIDCGatewayClientSecret` |
| `main.go` | Wires OIDC gateway token provider when credentials are present; passes Gateway OIDC config to `GatewayClient` |
| Control plane Deployment manifest (`base/ambient-control-plane-service.yml`) | Add `valueFrom`/`secretKeyRef` entries for `acp-control-plane-oidc` |
| Kind control plane env patch (`overlays/kind/control-plane-env-patch.yaml`) | No additional changes needed — base manifest `optional: true` handles absent Secret |
| Kind Keycloak realm (`overlays/kind/keycloak-realm.json`) | Add `acp-control-plane` confidential client with service account |
| Kind manifests | Add `acp-control-plane-oidc` Secret to Kind overlay |
| `OIDCTokenProvider` (`internal/auth/token_provider.go`) | Reused as-is for gateway token acquisition — same `client_credentials` grant, different credentials |

### Backward Compatibility

- Non-OIDC gateways continue to use mTLS + SA token — no behavior change
- The `acp-control-plane-oidc` Secret is optional — the control plane starts and operates without it
- Existing `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` for API server auth are unaffected
- The `GatewayClient` API surface does not change for callers — auth strategy selection is internal

---

## Design Decisions

| Decision | Rationale |
|---|---|
| Separate Secret (`acp-control-plane-oidc`) for gateway OIDC credentials | The gateway OIDC issuer may differ from the API server's OIDC issuer. Separate Secrets allow independent credential rotation and different OIDC providers. |
| Reuse `OIDCTokenProvider` for gateway tokens | The `client_credentials` grant flow is identical — same library, same caching, same 30-second refresh buffer. A new instance with different credentials is all that's needed. |
| Derive token URL from Gateway's `oidc.issuer` when not in Secret | Reduces configuration burden — in most deployments, the token endpoint follows the standard OIDC Discovery path. The Secret `token-url` key provides an escape hatch for non-standard providers. |
| `optional: true` on all `secretKeyRef` entries | The control plane must start without OIDC gateway credentials when no OIDC gateways exist. Making the Secret optional avoids requiring a dummy Secret in non-OIDC deployments. |
| Server-only TLS (not plaintext) for OIDC gateways | OIDC tokens are bearer credentials — transmitting them over plaintext would be a security vulnerability. Server TLS ensures transport encryption. The server cert is still validated against the CA. |
| Service account gets `openshell-admin` role | The control plane manages sandbox lifecycle (create, delete, exec) — it needs full administrative access to the gateway, not just user-level access. |
| Per-gateway auth selection based on Gateway resource OIDC state | Each tenant namespace can independently choose OIDC or mTLS. The control plane must support both simultaneously since different tenants may use different auth strategies. |
| 5-minute token lifetime with 30-second refresh buffer | Matches the existing `OIDCTokenProvider` pattern and the Kind Keycloak default (`accessTokenLifespan: 300`). Short-lived tokens limit blast radius of credential theft. The 30-second buffer provides ample margin for token refresh latency. |

---

## References

- [PR #363: feat(gateway): optional OIDC authentication for OpenShell gateways](https://github.com/openshift-online/agent-control-plane/pull/363)
- [gateway-oidc.spec.md](./gateway-oidc.spec.md) — Gateway-side OIDC configuration (PR #363)
- [gateway-provisioning.spec.md](./gateway-provisioning.spec.md) — Gateway lifecycle and reconciliation
- [control-plane.spec.md](./control-plane.spec.md) — Control plane architecture
- [sso-authentication.spec.md](../security/sso-authentication.spec.md) — Platform SSO model
- [OpenShell OIDC User Authentication](https://docs.nvidia.com/openshell/latest/kubernetes/access-control#oidc-user-authentication)
