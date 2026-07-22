# OpenShell Gateway TLS Specification

**Date:** 2026-07-22
**Status:** Implementation-Verified
**Parent:** `openshell-gateway.spec.md` — core gateway provisioning
**Related:** `openshell-gateway-oidc.spec.md` — OIDC authentication; `openshell-gateway-routing.spec.md` — external connectivity
**Verified by:** Working ROSA deployment (PR #415), e2e-openshell.sh (11/11 pass)

---

## Purpose

This specification defines TLS certificate management and mutual TLS (mTLS) behavior for OpenShell gateways deployed by the ACP control plane. It covers certificate generation strategies, SAN management, optional mTLS modes, cert rotation, and trusted CA bundle injection.

---

## TLS Modes

OpenShell's TLS behavior is determined by the combination of `client_ca_path` and OIDC configuration. The gateway internally uses the formula `require_client_auth = has_client_ca && !has_oidc`:

| `client_ca_path` | OIDC configured | `require_client_auth` | Mode |
|---|---|---|---|
| set | no | **true** | Full mTLS — all clients must present certs |
| set | yes | **false** | Optional mTLS — certs validated when present, OIDC for others |
| unset | yes | false | HTTPS + OIDC only |
| unset | no | false | HTTPS only (allow_unauthenticated) |

### Optional mTLS (Recommended for Production)

When OIDC is enabled alongside `client_ca_path`, the gateway operates in **optional mTLS** mode. This is the recommended production configuration because:

- Sandbox supervisors authenticate via client certificates (issued by the certgen job CA)
- CLI users and external clients authenticate via OIDC Bearer tokens
- Both authentication paths coexist without conflict

The GatewayReconciler SHALL **retain** `client_ca_path` in `gateway.toml` when OIDC is enabled. It SHALL NOT remove it.

> **Implementation note (verified):** The code change in `components/ambient-control-plane/internal/gateway/manifests.go` removed the block that stripped `client_ca_path` when OIDC was configured. The corrected `ApplyConfigOverrides()` always preserves `client_ca_path` regardless of OIDC state.

---

## Requirements

### Requirement: Optional mTLS with OIDC Gateways

When OIDC is enabled on a gateway, `client_ca_path` SHALL be retained in the `[openshell.gateway.tls]` section. The gateway's internal logic (`require_client_auth = has_ca && !has_oidc`) automatically switches from required to optional mTLS. This enables dual authentication: mTLS for sandboxes, OIDC for CLI users.

#### Scenario: OIDC gateway retains client_ca_path (optional mTLS)

- GIVEN a Gateway with OIDC enabled (non-empty `oidc.issuer`)
- WHEN the GatewayReconciler generates the ConfigMap
- THEN `gateway.toml` SHALL contain `client_ca_path` in the `[openshell.gateway.tls]` section
- AND `cert_path` and `key_path` SHALL remain present (server TLS preserved)
- AND the gateway SHALL accept clients authenticating via Bearer tokens OR client certificates

#### Scenario: Non-OIDC gateway requires mTLS

- GIVEN a Gateway with no OIDC configuration (or `oidc.issuer` is empty)
- WHEN the GatewayReconciler generates the ConfigMap
- THEN `gateway.toml` SHALL retain `client_ca_path` in the `[openshell.gateway.tls]` section
- AND mTLS SHALL be required for all clients (full mTLS mode)

#### Verified gateway.toml (ROSA deployment)

```toml
[openshell.gateway.tls]
cert_path      = "/etc/openshell-tls/server/tls.crt"
key_path       = "/etc/openshell-tls/server/tls.key"
client_ca_path = "/etc/openshell-tls/client-ca/ca.crt"

[openshell.gateway.auth]
allow_unauthenticated_users = false

[openshell.gateway.oidc]
issuer      = "https://keycloak-acp-api-01.apps.rosa.vteam-stage.7fpc.p3.openshiftapps.com/realms/ambient-code"
audience    = "ambient-frontend"
roles_claim = "groups"
admin_role  = "ambient-admins"
user_role   = "ambient-users"
```

---

### Requirement: TLS Certificate Management via cert-manager

The GatewayReconciler SHALL support two certificate generation strategies: the default `pkiInitJob` (a one-shot Job using the gateway image's `generate-certs` command) and `certManager` (delegating to the cert-manager operator). When cert-manager is available on the cluster, it SHALL be the preferred strategy.

#### Scenario: cert-manager installed

- GIVEN cert-manager is installed on the cluster (Certificate, Issuer CRDs are available)
- AND the GatewayReconciler detects cert-manager availability (via API discovery for `cert-manager.io` API group)
- WHEN the reconciler provisions a gateway
- THEN it SHALL create cert-manager resources for TLS certificate lifecycle:
  - A self-signed `Issuer` (`openshell-selfsigned`) in the project namespace
  - A `Certificate` for the CA (`openshell-ca`, ECDSA P256, creates `openshell-ca-tls` Secret)
  - A CA-backed `Issuer` (`openshell-ca-issuer`) that uses the CA certificate
  - A server `Certificate` (`openshell-server`, creates `openshell-server-tls` Secret with SANs from `serverDnsNames`)
  - A client `Certificate` (`openshell-client`, creates `openshell-client-tls` Secret)

#### Scenario: Fallback to pkiInitJob

- GIVEN cert-manager is NOT installed on the cluster
- WHEN the GatewayReconciler provisions a gateway
- THEN the certgen job SHALL handle both TLS certificate generation AND JWT key generation

#### Coexistence

cert-manager handles TLS certificate lifecycle. The certgen job handles JWT key generation (`signing.pem`, `public.pem`, `kid` in `openshell-gateway-jwt-keys`). Both run: cert-manager creates TLS secrets, then certgen checks if they exist (skipping TLS) and only creates JWT keys.

---

### Requirement: SAN Management and Cert Rotation

The reconciler monitors `serverDnsNames` on the Gateway API resource and compares them against the `server_sans` key in the `openshell-gateway-config` ConfigMap. When they differ, the reconciler triggers certificate regeneration.

#### Scenario: DNS names changed

- GIVEN a Gateway's `serverDnsNames` differ from the ConfigMap's `server_sans`
- WHEN the GatewayReconciler reconciles
- THEN it SHALL delete the existing `openshell-server-tls`, `openshell-client-tls`, and `openshell-gateway-jwt-keys` Secrets
- AND it SHALL delete any completed certgen Job
- AND it SHALL re-create the certgen Job with updated `--server-san` arguments
- AND the gateway workload SHALL restart to pick up the new certificates

#### Operational warning: Cert rotation is destructive

When SANs change, all PKI secrets are deleted and regenerated. Connected sandbox supervisors will experience `DecryptError` because their client certificates were signed by the old CA. Sandboxes must be recreated after cert rotation.

#### Scenario: ConfigMap SANs must match API SANs exactly

- GIVEN the reconciler's `serverDnsNamesChanged()` function compares API `server_dns_names` against ConfigMap `server_sans`
- WHEN they differ in any way (different count, different values, different order)
- THEN the reconciler SHALL delete all PKI secrets and trigger cert regeneration
- AND if the reconciler lacks RBAC to read ConfigMaps, it SHALL log a warning and assume SANs changed (safe default)

> **Operational note (verified):** During the ROSA deployment, a ConfigMap/API SAN mismatch caused a cert deletion loop. The fix was to ensure both the API resource and ConfigMap had identical SANs. Manual cert regeneration (scale CP to 0, update ConfigMap, run certgen, scale CP to 1) was required to break the loop.

---

### Requirement: Trusted CA Bundle Injection

Gateways with OIDC enabled need to reach the identity provider's OIDC discovery endpoint over HTTPS. In environments where the IdP uses a non-public CA certificate (e.g., OpenShift CRC, private PKI), the gateway's default trust store will not include the required CA.

#### Scenario: Trusted CA ConfigMap present

- GIVEN a ConfigMap named `gateway-trusted-ca` exists in the ACP namespace
- AND the ConfigMap has a `ca-bundle.crt` key containing PEM-encoded CA certificates
- WHEN the GatewayReconciler reconciles a gateway in a tenant namespace
- THEN it SHALL copy the ConfigMap to the tenant namespace (create-or-update)
- AND it SHALL mount `ca-bundle.crt` at `/etc/pki/tls/certs/ca-bundle.crt` (read-only, subPath)
- AND it SHALL add `SSL_CERT_FILE=/etc/pki/tls/certs/ca-bundle.crt` to the gateway container

#### Scenario: Trusted CA ConfigMap absent

- GIVEN no ConfigMap named `gateway-trusted-ca` exists in the ACP namespace
- WHEN the GatewayReconciler reconciles a gateway
- THEN it SHALL NOT add any CA volume or `SSL_CERT_FILE` env var
- AND the gateway SHALL use its built-in trust store

---

### Requirement: RBAC for TLS Resources

The control plane ClusterRole SHALL include permissions for TLS-related resources:

```yaml
- apiGroups: [""]
  resources: ["secrets", "configmaps"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]

- apiGroups: ["cert-manager.io"]
  resources: ["issuers", "certificates"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]
```

---

## Debugging Reference

| Symptom | Root Cause | Fix |
|---|---|---|
| `DecryptError` in gateway logs | Stale client cert from sandbox after cert rotation | Recreate affected sandboxes |
| Cert deletion loop (every 30s) | ConfigMap SANs don't match API SANs | Ensure exact match; manual certgen if needed |
| `invalid peer certificate: UnknownIssuer` | Self-signed CA — CLI doesn't trust gateway CA | Use `OPENSHELL_GATEWAY_INSECURE=true` or trust CA |
| OIDC discovery fails with TLS error | Gateway can't reach IdP (private CA) | Create `gateway-trusted-ca` ConfigMap |

---

## References

- [NVIDIA OpenShell Managing Certificates](https://docs.nvidia.com/openshell/kubernetes/managing-certificates)
- [OpenShell Helm Chart — pkiInitJob](https://github.com/NVIDIA/OpenShell/tree/main/deploy/helm/openshell)
- [cert-manager Installation](https://cert-manager.io/docs/installation/)
