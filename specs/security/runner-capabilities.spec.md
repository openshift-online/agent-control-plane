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


### Requirement: Backend compatibility

The Kubernetes gateway backend SHALL persist the sandbox name and a new run
generation before launch or resume. It SHALL use the same scoped token exchange
as the Hypershell backend. Bootstrap lifetime SHALL also be bounded by a positive
session timeout. Runner environment overrides SHALL NOT replace authentication
settings or inject a control-plane service token.

The API server SHALL mount only `public.pem` from the signing Secret. The control
plane MAY serve callback TLS directly with `CP_TOKEN_TLS_CERT_FILE` and
`CP_TOKEN_TLS_KEY_FILE`. A partial or invalid TLS configuration SHALL prevent
startup. OpenShift deployments SHALL use serving certificates for runner gRPC
and callback HTTPS. Kind and local test overlays MAY explicitly set
`AMBIENT_ALLOW_INSECURE_RUNNER_TRANSPORT=true`. Managed deployments SHALL NOT use
this override. TLS trust payloads SHALL contain only public CA certificates.

#### Scenario: Legacy backend resume

- GIVEN a stopped session uses the Kubernetes gateway backend
- WHEN the user resumes it
- THEN ACP SHALL persist a new generation and supply a new bootstrap capability
- AND the prior generation SHALL remain invalid

### Requirement: Durable message acceptance

Managed runners SHALL store an execution cursor in the retained session workspace
when `ACP_MESSAGE_CURSOR_FILE` is configured. The control plane SHALL reserve
this path against agent environment overrides. The cursor SHALL contain a format
version, the exact session ID, and the last accepted user-message sequence. The
API database SHALL remain the message history.

The runner SHALL save acceptance before dispatch. Writes SHALL use an atomic
file replacement, file and directory synchronization, and a lock that prevents
concurrent instances from accepting the same sequence. A resumed runner SHALL
read its stored sequence instead of using a timestamp cutoff or the current
maximum database sequence. User messages above the cursor SHALL remain eligible
regardless of their age. Accepted requests SHALL NOT run again automatically;
acceptance does not prove that a turn completed. A user can submit a new request
to repeat or continue work after an interrupted turn.

A missing cursor on resume, invalid content, another session ID, or a path outside
the session workspace SHALL prevent startup with a recovery instruction. Failure
to save acceptance SHALL stop dispatch. An initial API user message SHALL use the
same acceptance path. Managed startup SHALL NOT insert a second copy of that
initial user request. Project and agent instructions SHALL be supplied separately
from the user request.

#### Scenario: Message queued during a long stop

- GIVEN a stopped session has accepted user-message sequence 4
- AND sequence 5 was queued while the runner was stopped
- WHEN its retained workspace resumes
- THEN the runner SHALL start its watch after sequence 4
- AND it SHALL accept sequence 5 regardless of its timestamp
- AND it SHALL NOT run sequence 4 again
