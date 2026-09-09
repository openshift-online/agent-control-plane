# Runtime State API

## Purpose

The control plane stores gateway and sandbox state without changing user data.
It retains resource mappings after deletion so that cleanup can finish.

## Requirements

### Requirement: Service access

The `/runtime/projects` and `/runtime/sessions` APIs SHALL require the configured
control-plane service identity. User identities and runner capabilities SHALL
NOT read or change runtime inventory. Lists SHALL include deleted resources and
SHALL use bounded pages in stable ID order.

#### Scenario: User requests deleted resource mappings

- GIVEN an authenticated user
- WHEN the user requests runtime inventory
- THEN ACP SHALL deny access before a database read

### Requirement: Conditional updates

A PATCH to `/runtime/projects/{id}` or `/runtime/sessions/{id}` SHALL require the
current `runtime_version`. A successful update SHALL increment this version.
Omitted fields SHALL remain unchanged. Null SHALL clear a nullable runtime
field. User fields and deletion markers SHALL NOT be accepted. Lifecycle changes
SHALL also require the current `expected_phase`. A mismatch SHALL return HTTP
409 without a state change.

#### Scenario: Stop during sandbox creation

- GIVEN the control plane read a session in the Creating phase
- WHEN the user stops the session before the control plane writes Running
- THEN the runtime update SHALL fail with HTTP 409
- AND the stop request SHALL remain in effect

### Requirement: Preserve bindings

Normal resource updates SHALL NOT overwrite runtime bindings. Updates based on
an old runtime version SHALL fail. Updates SHALL NOT recreate or restore a
deleted row. Cleanup SHALL preserve the deletion marker when it clears runtime
state.

#### Scenario: Cleanup after deletion

- GIVEN a deleted session retains a sandbox mapping
- WHEN cleanup removes its sandbox and updates the runtime state
- THEN the session SHALL remain deleted
