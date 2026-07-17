# Gateway CLI Management

## Purpose

The `acpctl` CLI SHALL support gateway resources as a first-class resource type across `get`, `delete`, and a dedicated `gateway` subcommand tree. This provides operators with full CLI access to inspect gateway connection details and configure local openshell CLI access against provisioned gateways.

**Related:** `gateway-provisioning.spec.md` — gateway resource model and reconciliation; `openshell-sandbox.spec.md` — sandbox execution via gateways

---

## Requirements

### Requirement: Get Gateways

The `acpctl get` command SHALL support `gateways` as a resource type with aliases `gateway` and `gw`.

When listing all gateways (`acpctl get gateways`), the output SHALL display a table with the following columns:

| Column | Width | Content |
|--------|-------|---------|
| NAME | 24 | `gateway.name` |
| VERSION | 20 | Image tag extracted from `gateway.image` (everything after the last `:`) |
| ADDRESS | 64 | `gateway.routeAddress` when a route is configured and ready; `"Not ready..."` when a route is configured but `routeAddress` is empty; comma-separated `gateway.serverDnsNames` when no route is configured |
| AGE | 10 | Relative time since `created_at` |

When retrieving a single gateway by name or ID (`acpctl get gateway <name>`), the output SHALL display the table row followed by a connection info block.

The command SHALL support JSON output via the standard `--output json` flag.

#### Scenario: List all gateways

- GIVEN gateways "alpha" and "beta" exist
- WHEN the user runs `acpctl get gateways`
- THEN a table renders with NAME, VERSION, ADDRESS, and AGE columns
- AND both gateways appear as rows

#### Scenario: Get a single gateway by name

- GIVEN gateway "alpha" exists in project "platform"
- WHEN the user runs `acpctl get gateway alpha`
- THEN the table renders with one row for "alpha"
- AND a connection info block is printed below the table

#### Scenario: Gateway not found

- GIVEN no gateway named "nonexistent" exists
- WHEN the user runs `acpctl get gateway nonexistent`
- THEN the command exits with an error: `gateway "nonexistent" not found`

#### Scenario: JSON output

- GIVEN gateway "alpha" exists
- WHEN the user runs `acpctl get gateway alpha -o json`
- THEN the gateway object is printed as JSON

### Requirement: Gateway Connection Info

When a single gateway is retrieved, the CLI SHALL print a connection info block after the table containing:

- **Route**: The external route address (only if `routeAddress` is non-empty)
- **Cluster DNS**: The in-cluster service address (`openshell-gateway.<namespace>.svc.cluster.local:8080`)
- **Server SANs**: The gateway's configured DNS names (only if `serverDnsNames` is non-empty)
- **Setup hint**: When a route address is available, show `acpctl gateway setup-cli <name>`. When no route address is available, show `acpctl gateway setup-cli <name> --kubectl`.

The namespace SHALL be derived from the gateway's `projectID`, lowercased.

#### Scenario: Connection info with route address

- GIVEN gateway "alpha" has `routeAddress: "https://openshell-gateway-platform.acpgw.apps.example.com"`, `serverDnsNames: ["gw.example.com"]`, and belongs to project "PLATFORM"
- WHEN the user runs `acpctl get gateway alpha`
- THEN the connection info shows:
  - Route: `https://openshell-gateway-platform.acpgw.apps.example.com`
  - Cluster DNS: `openshell-gateway.platform.svc.cluster.local:8080`
  - Server SANs: `gw.example.com`
  - Setup hint: `acpctl gateway setup-cli alpha`

#### Scenario: Connection info without route address

- GIVEN gateway "beta" has no `routeAddress` and an empty `serverDnsNames` list
- WHEN the user runs `acpctl get gateway beta`
- THEN the Route line is omitted from the connection info
- AND the Server SANs line is omitted
- AND the setup hint shows `acpctl gateway setup-cli beta --kubectl`

### Requirement: Delete Gateway

The `acpctl delete` command SHALL support `gateway` as a resource type with aliases `gateways` and `gw`.

#### Scenario: Delete a gateway

- GIVEN gateway "alpha" exists
- WHEN the user runs `acpctl delete gateway alpha`
- THEN the gateway is deleted via the API
- AND the output shows `gateway/alpha deleted`

#### Scenario: Delete nonexistent gateway

- GIVEN no gateway named "nonexistent" exists
- WHEN the user runs `acpctl delete gateway nonexistent`
- THEN the command exits with an error

### Requirement: Gateway Subcommand Tree

The `acpctl gateway` top-level command SHALL provide a subcommand tree for gateway management operations. Running `acpctl gateway` without a subcommand SHALL display help text listing available subcommands (`setup-cli`, `remove-cli`).

### Requirement: Gateway Setup CLI

The `acpctl gateway setup-cli [name]` command SHALL configure local openshell CLI access for a named gateway.

#### Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--gateway-url` | No | Gateway's route address | Gateway URL (e.g. `https://gateway.example.com:8080`). If omitted, uses the gateway's `routeAddress` from the API server. |
| `--kubectl` | No | `false` | Fall back to `kubectl port-forward` and cert extraction when no route address is available |
| `--project` | No | Configured project | Project/namespace to look up the gateway in |
| `--print` | No | `false` | Print openshell commands instead of running them |

The API-side gateway name defaults to `openshell-gateway` if the positional `[name]` argument is omitted. The local openshell registration is named `<project>-<gateway-name>`.

#### URL Resolution

When `--gateway-url` is omitted, the command resolves the gateway URL as follows:

1. If the gateway has a `routeAddress` (populated by the control plane when a GRPCRoute is created), use it
2. If `--kubectl` is specified, fall back to `kubectl port-forward` (see kubectl mode below)
3. Otherwise, fail with an error instructing the user to use `--kubectl` or `--gateway-url`

#### Modes of Operation

The command has two modes based on whether cluster access is assumed:

**Route-address mode** (default — no cluster access required):

The gateway URL is resolved from the API server's `routeAddress` field or provided via `--gateway-url`. The command does NOT interact with the Kubernetes cluster — TLS verification relies on the system trust store. On CRC, this means the user must install the CRC CA certificates before running this command (see README).

- Non-interactive new registration (OIDC gateway + acpctl credentials):
  1. Fetch the gateway resource from the API server
  2. Write `metadata.json` to `~/.config/openshell/gateways/<local-name>/` with gateway endpoint, auth mode, and OIDC configuration
  3. Write `oidc_token.json` with the user's acpctl access token and refresh token
  4. Verify connectivity via `openshell status -g <local-name>` — if unreachable, clean up and fail

- Non-interactive re-authentication (gateway already registered + acpctl credentials):
  1. Refresh `oidc_token.json` with current acpctl credentials
  2. Verify connectivity via `openshell status -g <local-name>`

- Interactive fallback (no acpctl credentials OR non-OIDC gateway):
  1. Delegate to `openshell gateway add` or `openshell gateway login`
  2. Verify connectivity via `openshell status -g <local-name>`

**Kubectl mode** (`--kubectl` — requires cluster access):

Used when no route address is available (e.g., Kind clusters). The command starts a `kubectl port-forward` to the gateway service and fetches mTLS certificates from the cluster.

1. Start `kubectl port-forward` to `svc/openshell-gateway` in the gateway's namespace
2. Fetch mTLS certificates from the `openshell-client-tls` K8s secret, writing `ca.crt`, `tls.crt`, and `tls.key` to `~/.config/openshell/gateways/<local-name>/mtls/`
3. If mTLS fetch fails, warn the user (non-fatal)
4. Proceed with registration/re-authentication as in route-address mode, using `https://localhost:<port>` with `--gateway-insecure`

#### Connectivity Validation

After all registration or re-authentication paths, the command SHALL run `openshell status -g <local-name>` to verify the gateway is reachable. If the check fails:

- For **new registrations**: the gateway config directory (`~/.config/openshell/gateways/<local-name>/`) is removed so broken state is not left behind
- For **re-authentication**: the existing config is preserved (the gateway was previously working)
- The command exits with an error indicating the gateway URL is not reachable

This prevents users from successfully "configuring" a gateway that points to a wrong URL, wrong port, or a gateway that isn't running.

#### mTLS Certificate Handling

The `openshell-client-tls` K8s secret in the gateway's namespace contains `ca.crt`, `tls.crt`, and `tls.key`. These are fetched via `kubectl get secret` and written to the openshell config directory.

- `ca.crt` enables openshell to verify the gateway's TLS certificate without `--gateway-insecure`
- `tls.crt` and `tls.key` provide mTLS client authentication
- Private key files (`tls.key`) SHALL be written with `0600` permissions. Other certificate files SHALL use `0644`.
- `kubectl` must be in PATH and configured with access to the gateway's namespace
- mTLS fetch failure is non-fatal: the gateway registration succeeds but may require `--gateway-insecure`

#### Print Mode

When `--print` is specified, the command SHALL print the equivalent openshell commands (gateway add, gateway login, provider list) instead of executing them. This is useful for debugging or manual execution.

#### Scenario: Non-interactive setup with OIDC credentials

- GIVEN gateway "alpha" exists with OIDC config in project "platform"
- AND the user has a valid acpctl OIDC token (via `acpctl login --password-grant` or `--use-auth-code`)
- AND `kubectl` has access to namespace "platform"
- AND the `openshell-client-tls` secret exists in namespace "platform"
- WHEN the user runs `acpctl gateway setup-cli alpha --gateway-url https://gw.example.com:8080`
- THEN metadata.json and oidc_token.json are written to `~/.config/openshell/gateways/platform-alpha/`
- AND mTLS certs are written to `~/.config/openshell/gateways/platform-alpha/mtls/`
- AND `openshell -g platform-alpha provider list` works without `--gateway-insecure`

#### Scenario: Non-interactive setup without kubectl access

- GIVEN gateway "alpha" exists with OIDC config
- AND the user has a valid acpctl OIDC token
- BUT `kubectl` is not in PATH or lacks access to the namespace
- WHEN the user runs `acpctl gateway setup-cli alpha --gateway-url https://gw.example.com:8080`
- THEN metadata.json and oidc_token.json are written successfully
- AND a warning is printed: `Warning: could not fetch mTLS certs`
- AND the user is advised to manually provision mTLS certificates or ensure kubectl access

#### Scenario: Re-authentication of existing gateway

- GIVEN gateway "platform-alpha" is already registered in openshell
- AND the user has refreshed their acpctl credentials
- WHEN the user runs `acpctl gateway setup-cli alpha --gateway-url https://gw.example.com:8080`
- THEN the oidc_token.json is updated with current credentials
- AND mTLS certs are refreshed

#### Scenario: Interactive fallback without credentials

- GIVEN gateway "alpha" exists with OIDC config
- AND the user has no acpctl access token
- WHEN the user runs `acpctl gateway setup-cli alpha --gateway-url https://gw.example.com:8080`
- THEN `openshell gateway add` is invoked with OIDC flags
- AND the browser-based OIDC login flow opens

#### Scenario: Unreachable gateway URL

- GIVEN gateway "alpha" exists in the API server
- AND the user provides `--gateway-url https://localhost:99999` (nothing listening)
- WHEN the user runs `acpctl gateway setup-cli alpha --gateway-url https://localhost:99999`
- THEN the command exits with error: `gateway at https://localhost:99999 is not reachable`
- AND no gateway config is left in `~/.config/openshell/gateways/`

#### Scenario: openshell not installed

- GIVEN `openshell` is not in PATH
- WHEN the user runs `acpctl gateway setup-cli alpha --gateway-url ...`
- THEN the command exits with error: `openshell not found in PATH: required for gateway setup`

#### Scenario: Print mode

- GIVEN gateway "alpha" exists
- WHEN the user runs `acpctl gateway setup-cli alpha --gateway-url https://gw.example.com:8080 --print`
- THEN the output shows the openshell gateway add, login, and verify commands
- AND no commands are executed

### Requirement: Gateway Remove CLI

The `acpctl gateway remove-cli [name]` command SHALL remove a local openshell CLI gateway registration.

#### Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--project` | No | Configured project | Project/namespace used to derive the gateway name |

If the positional `[name]` argument is omitted, the gateway name is derived as `<project>-openshell-gateway`.

The command delegates to `openshell gateway remove <name>`.

#### Scenario: Remove a registered gateway

- GIVEN gateway "platform-openshell-gateway" is registered in openshell
- WHEN the user runs `acpctl gateway remove-cli --project platform`
- THEN the gateway registration is removed from openshell
- AND the output shows `Gateway platform-openshell-gateway removed`

#### Scenario: Remove by explicit name

- GIVEN gateway "my-gateway" is registered in openshell
- WHEN the user runs `acpctl gateway remove-cli my-gateway`
- THEN the gateway registration is removed

#### Scenario: Gateway not registered

- GIVEN gateway "missing" is not registered in openshell
- WHEN the user runs `acpctl gateway remove-cli missing`
- THEN the command exits with error: `gateway "missing" is not registered in openshell`

#### Scenario: openshell not installed

- GIVEN `openshell` is not in PATH
- WHEN the user runs `acpctl gateway remove-cli ...`
- THEN the command exits with error: `openshell not found in PATH: required for gateway removal`

### Requirement: OIDC Password Grant Login

The `acpctl login` command SHALL support `--password-grant` for headless OIDC token acquisition via the OAuth2 Resource Owner Password Credentials (ROPC) grant.

#### Flags

| Flag | Required with `--password-grant` | Description |
|------|----------------------------------|-------------|
| `--password-grant` | — | Enable ROPC grant mode |
| `--username` | Yes | OIDC username |
| `--password` | Yes | OIDC password |
| `--issuer-url` | No (default: Red Hat SSO) | OIDC issuer URL |
| `--client-id` | No (default: `ocm-cli`) | OAuth2 client ID |

The command POSTs to `<issuer-url>/protocol/openid-connect/token` with `grant_type=password`. Both access and refresh tokens are saved to the acpctl config.

`--password-grant` is mutually exclusive with `--token`, `--use-auth-code`, and `--client-credentials`.

This mode enables non-interactive gateway setup in CI/CD, local dev (`make kind-acpctl-login`), and environments where browser-based OIDC is unavailable.

#### Scenario: Headless OIDC login

- GIVEN a Keycloak realm at `http://localhost:11880/realms/ambient-code` with user `developer`/`developer`
- WHEN the user runs `acpctl login --password-grant --username developer --password developer --issuer-url http://localhost:11880/realms/ambient-code --client-id openshell-cli --url http://localhost:13080`
- THEN an OIDC JWT access token and refresh token are saved to the acpctl config
- AND subsequent `acpctl gateway setup-cli` commands use the OIDC token for non-interactive registration

#### Scenario: Missing credentials

- WHEN the user runs `acpctl login --password-grant --username developer`
- THEN the command exits with error: `--username and --password are required with --password-grant`

#### Scenario: Invalid credentials

- GIVEN a valid OIDC issuer
- WHEN the user runs `acpctl login --password-grant --username wrong --password wrong ...`
- THEN the command exits with an error from the token endpoint (e.g. `Invalid user credentials`)

### Requirement: API URL Short Flag

The `acpctl` root command SHALL support `-U` as a short flag alias for `--api-url`, allowing `acpctl -U https://api.example.com get gateways`.

#### Scenario: Short flag for API URL

- GIVEN a valid API server at `https://api.example.com`
- WHEN the user runs `acpctl -U https://api.example.com get gateways`
- THEN the command uses `https://api.example.com` as the API server URL

### Requirement: Deterministic Gateway Port-Forwards (Local Dev)

In the local Kind development environment, gateway port-forwards SHALL use deterministic ports based on `KIND_FWD_GATEWAY_BASE_PORT` (default `15080`) with a per-namespace offset.

- Gateways are discovered by label `app.kubernetes.io/instance=openshell-gateway`
- Namespaces are sorted alphabetically; the first gets port `15080`, the second `15081`, etc.
- The assigned port is written to `$(KIND_PF_DIR)/kind-pf-openshell-<namespace>.port`
- Status checks, access printout, and cleanup targets read from `.port` files (not log scraping)
- `make kind-port-forward-stop` removes `.pid`, `.log`, and `.port` files

This replaces the previous ephemeral port allocation where ports were discovered by parsing `kubectl port-forward` log output.
