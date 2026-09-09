# Runner Capabilities

## Purpose

Each runner can read and write session messages for its current run. Its identity
is separate from the control plane, the gateway, and the user.

## Requirements

### Requirement: Session scope

ACP SHALL issue a signed bootstrap capability for one session, Project, sandbox,
and run generation. It SHALL exchange this capability for an access token with a
maximum lifetime of five minutes. A public key and a session ID SHALL NOT permit
access. The bootstrap lifetime SHALL NOT exceed seven days.

#### Scenario: Another session

- GIVEN a runner has a valid access token
- WHEN it reads or writes another session
- THEN ACP SHALL deny the request

### Requirement: Restricted methods

A runner token SHALL permit only message writes, event writes, and message reads
for its session. It SHALL NOT permit HTTP API access, credential reads, session
creation, or runtime state changes. Existing runners and sidecars SHALL migrate
to scoped capabilities or gateway provider delivery before deployment.

#### Scenario: Privileged operation

- GIVEN a runner has a valid access token
- WHEN it requests a credential or creates a session
- THEN ACP SHALL deny the request

### Requirement: Revocation and transport

ACP SHALL verify current session state and run generation at token exchange and
on each API operation. Stop, deletion, and restart SHALL revoke old access.
Active message streams SHALL check expiry and revocation. Token refresh SHALL
preserve scope. Production callbacks SHALL use verified TLS and SHALL reject
redirects. Missing identity configuration SHALL deny access.

#### Scenario: Restart

- GIVEN a runner has an access token and an open message stream
- WHEN the session receives a new run generation
- THEN token refresh and subsequent writes SHALL fail
- AND the old message stream SHALL close
