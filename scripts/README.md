# Scripts

## SSO Configuration

### `setup-kind-sso.sh`

Configures SSO credentials for local Kind development. **Automatically called by `make kind-up`** — do not run manually.

**What it does:**
1. Patches `sso-credentials` secret with port-specific URLs:
   - `SSO_FRONTEND_ISSUER_URL`: Browser-facing Keycloak URL (localhost)
   - `SSO_REDIRECT_URI`: OAuth callback URL for ambient-ui
2. Updates Keycloak deployment's `KC_HOSTNAME` to match port-forwarded address
3. Waits for Keycloak rollout to complete

**Environment variables:**
- `NAMESPACE` - K8s namespace (default: `ambient-code`)
- `KIND_FWD_AMBIENT_UI_PORT` - Port for UI callback redirect
- `KIND_FWD_KEYCLOAK_PORT` - Port for Keycloak frontend

Ports are fixed in the Makefile and can be overridden via Make variables.

**Dual-Issuer Pattern:**
The UI pod fetches OIDC discovery from the backend issuer (`http://keycloak-service:11080/realms/ambient-code`) which it can reach via cluster DNS. It then selectively rewrites browser-facing endpoints (`authorization_endpoint`, `end_session_endpoint`) to use the frontend issuer (`http://localhost:$KIND_FWD_KEYCLOAK_PORT/realms/ambient-code`) so login redirects work from your browser. Server-to-server endpoints (`token_endpoint`, `userinfo_endpoint`, `jwks_uri`) stay unchanged so the pod can still call them.

**Default Users:**
- Developer: `developer` / `developer` (ambient-users group)
- Admin: `admin` / `admin` (ambient-users, ambient-admins groups)

Defined in `components/manifests/overlays/kind/keycloak-realm.json`.
