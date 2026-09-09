# Hypershell Session Resources

## Purpose

Each ACP session runs in an isolated OpenShell workspace and sandbox on its
Project's gateway.

## Requirements

### Requirement: Session identity

ACP SHALL record the gateway, OpenShell workspace, sandbox identity, and runner
generation before runner execution. Restart recovery SHALL adopt the recorded
runtime and SHALL NOT start a duplicate runner. A Project update SHALL NOT change
the gateway used to clean up an existing session.

#### Scenario: Recover after a control-plane restart

- GIVEN a runner is active
- WHEN the control plane restarts
- THEN it SHALL find that runner through the recorded session identity
- AND SHALL continue status and message handling without duplicate execution

### Requirement: Session isolation

Each session SHALL have an OpenShell workspace that isolates provider and
inference configuration. Runtime lookup SHALL use the session's recorded
gateway and workspace. Names SHALL preserve distinct session identities.

#### Scenario: Concurrent models

- GIVEN two sessions in one ACP Project select different models
- WHEN both sessions run
- THEN each session SHALL use its selected model
- AND neither session SHALL change the other's inference route

### Requirement: Lifecycle and observability

ACP SHALL support execution, message delivery, logs, policy inspection, payload
upload, stop, resume, and deletion through gateway APIs. Failed remote operations
SHALL remain pending or report a failure. ACP SHALL retry cleanup after outages.
Stop and resume SHALL preserve the documented session files and message sequence.
Completed session snapshots SHALL remain available after runtime deletion.
Before stop or deletion, ACP SHALL use the finite `GetSandboxLogs` gateway RPC
and persist the policy and up to 500 buffered log entries with a session version
and phase check. An empty log buffer SHALL be a valid snapshot, including when
the sandbox never became Ready. A failed RPC or database write SHALL keep cleanup
pending. ACP SHALL preserve a saved snapshot when a stopped sandbox has no logs.
An already deleted sandbox SHALL NOT require another snapshot.
A Degraded gateway SHALL block new session work but SHALL NOT block attempts to
stop terminal sessions. ACP SHALL validate the gateway binding and refresh its
connection settings before these cleanup attempts.

#### Scenario: Failed remote deletion

- GIVEN a sandbox delete request fails
- WHEN ACP records the operation result
- THEN cleanup SHALL remain pending
- AND ACP SHALL NOT report successful runtime deletion
