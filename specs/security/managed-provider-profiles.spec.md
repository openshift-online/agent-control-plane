# Managed Provider Profiles

## Purpose

ACP delivers selected credentials through the session's gateway workspace.
Provider configuration remains separate from runner and gateway identities.

## Requirements

### Requirement: Explicit injection grant

Managed sessions SHALL resolve only `credential:viewer` bindings with no user or
session subject. Resolution SHALL use agent, Project, then global precedence.
Ownership and token-reader grants SHALL NOT imply injection. Duplicate grants at
one level SHALL use creation time and ID for a stable choice. ACP SHALL fetch the
selected credential ID and SHALL reject a mismatched token response.

#### Scenario: Ownership without injection

- GIVEN a user owns a credential without an injection binding
- WHEN a session starts
- THEN the credential SHALL NOT enter its gateway workspace

### Requirement: Profile conversion

ACP SHALL convert credential data to the selected OpenShell profile. It SHALL
validate structured data before it starts the runner. Raw Kubernetes Secret
references SHALL NOT authorize managed provider access. A profile that cannot
safely deliver its credential SHALL prevent launch with a clear error.

#### Scenario: GitHub App

- GIVEN a bound credential contains a GitHub App ID, installation ID, and key
- WHEN ACP prepares the provider
- THEN ACP SHALL exchange the key for an expiring installation token
- AND the gateway SHALL receive the installation token without the App key

### Requirement: Rotation and revocation

Provider names SHALL distinguish credential IDs and sessions. ACP SHALL refresh
source changes and short-lived credentials. It SHALL remove revoked sandbox
attachments before it deletes provider records. If authorization or detachment
fails, the control plane SHALL stop the affected sandbox. Managed sessions SHALL
NOT retain access until session termination after a binding is removed.

#### Scenario: Binding removal during execution

- GIVEN an active managed sandbox uses a bound credential
- WHEN its binding is removed
- THEN ACP SHALL detach and delete its provider
- OR it SHALL stop the sandbox if removal cannot complete
- AND unrelated sessions SHALL retain their providers

### Requirement: Google SDK access

Bound Google service-account and ADC credentials SHALL use the `google-cloud`
profile. The gateway SHALL refresh access tokens. The sandbox SHALL use the
OpenShell metadata emulator. ACP SHALL NOT copy private keys or refresh tokens
into sandbox files or environment variables.

#### Scenario: ADC refresh

- GIVEN a bound Google credential contains ADC refresh data
- WHEN ACP prepares a session
- THEN the gateway SHALL receive the refresh material
- AND the sandbox SHALL use metadata access without an ADC secret file

### Requirement: Kubernetes bearer profile

ACP SHALL accept kubeconfig credentials with an embedded bearer token and a
verified HTTPS API origin. It SHALL create a profile in the session workspace
with that origin and operator-approved private network ranges. Profile updates
SHALL use the current resource version and verify session ownership. The sandbox
kubeconfig SHALL contain a placeholder token. It SHALL NOT contain the source
bearer token or disable certificate checks.

ACP SHALL reject exec authentication, client certificates, external file
references, impersonation, basic authentication, proxy URLs, and TLS name
overrides. Embedded CA certificates SHALL match the public certificates in
`HYPERSHELL_KUBERNETES_TRUST_BUNDLE`. Operators SHALL install the same certificates
in the supervisor system trust store. Private API address ranges SHALL come from
`HYPERSHELL_KUBERNETES_ALLOWED_CIDRS`, a comma-separated list of IPs or CIDRs.

#### Scenario: Unsupported kubeconfig helper

- GIVEN a bound kubeconfig uses an exec authentication helper
- WHEN ACP prepares the profile
- THEN ACP SHALL reject the format before it starts the session
- AND ACP SHALL NOT run the helper
