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
