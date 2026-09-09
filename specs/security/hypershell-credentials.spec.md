# Hypershell Credential Boundaries

## Purpose

ACP authorizes credential selection. OpenShell delivers provider credentials to
the selected runtime. Gateway identities remain separate from runner identities.

## Requirements

### Requirement: Exact credential selection

ACP SHALL select credentials by binding precedence: agent, Project, then global.
It SHALL reconcile the selected credential ID into the session's OpenShell
workspace. Required credential failures SHALL prevent runner launch. Credential
values SHALL NOT appear in resource status, ordinary responses, or logs.

#### Scenario: Same provider with different credentials

- GIVEN two agents select different credentials for the same provider type
- WHEN their sessions start
- THEN each provider record SHALL use its selected credential ID
- AND neither session SHALL overwrite the other's credential

### Requirement: Rotation and revocation

ACP SHALL reconcile updated credentials and revoked bindings for active sessions.
Supported short-lived provider credentials SHALL use refresh configuration.
Revocation SHALL stop or detach affected runtime access before provider removal
when OpenShell prevents removal of an attached provider.

#### Scenario: Binding removal

- GIVEN a session uses a bound credential
- WHEN its binding is removed
- THEN ACP SHALL remove that runtime access
- AND unrelated sessions SHALL retain their authorized access

### Requirement: Gateway authentication

ACP SHALL use a gateway-specific identity over verified TLS. It SHALL renew access
tokens and replace expiring service accounts. It SHALL protect service-account
secrets with encrypted storage. Authentication failures SHALL NOT cause an
unauthenticated retry. Runners SHALL receive neither gateway admin credentials
nor the ACP control-plane API token.

#### Scenario: Wrong gateway audience

- GIVEN a token belongs to another gateway
- WHEN a gateway operation is attempted
- THEN it SHALL fail authentication or authorization
- AND ACP SHALL preserve the failure without reducing authentication requirements
